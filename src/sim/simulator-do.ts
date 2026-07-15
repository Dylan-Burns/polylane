/**
 * SimulatorDO: the single `idFromName('world')` Durable Object that owns the demo universe's
 * clock. It is the *only* place in `src/sim/*` allowed to read `Date.now()` or touch D1/storage —
 * `generator.ts`, `scenarios.ts`, and `backfill.ts` stay pure so their output is reproducible and
 * testable in isolation; this file is where that determinism meets real time and real I/O.
 *
 * Responsibilities (spec §6, task brief):
 *  - Tick every ~20s: generate the elapsed window, persist a sampled subset of spans/logs every
 *    tick, and close out any minute(s) that finished within the tick into `rollups` (100% of
 *    traffic, independent of persistence sampling).
 *  - Own fault state (`POST /fault` / `POST /restore`) and the 30s chaos cooldown.
 *  - Own reset sequencing (`POST /reset`): wipe telemetry tables, chunk a 24h backfill across
 *    alarm ticks (~4h/chunk), recompute baselines (`detect/baselines.ts`'s `computeBaselines`,
 *    injected as a hook so tests can substitute a spy), seed one seeded incident, then go live.
 *  - Own the world-generation counter: every write batch checks it immediately before its D1
 *    writes and discards (skips the insert) if a reset bumped it underneath the batch.
 */

import { DurableObject } from "cloudflare:workers";
import { computeBaselines } from "../detect/baselines";
import type { Env } from "../env";
import { insertLogs, insertRollups, insertSpans } from "../telemetry/queries";
import type { Deploy, LogLine, RollupRow, Span } from "../telemetry/types";
import { BACKFILL_CHUNK_MS, BACKFILL_TOTAL_MS, MINUTE_MS, runBackfillChunk } from "./backfill";
import { generateWindow, rollupFromStats, sampleForPersistence, type RequestStat } from "./generator";
import { mulberry32 } from "./rng";
import { deployEventsFor, effectsFor, type FaultState, type ScenarioId } from "./scenarios";
import { insertSeededIncident } from "./seed-incident";

export type WorldStatus = "unseeded" | "seeding" | "running" | "resetting";

/** Alarm cadence: drives both live ticking and (while seeding) one backfill chunk per firing. */
const ALARM_INTERVAL_MS = 20_000;

const CHAOS_COOLDOWN_MS = 30_000;
const RESET_COOLDOWN_MS = 10 * 60_000;

const VALID_SCENARIOS: ReadonlySet<ScenarioId> = new Set([
  "bad-deploy",
  "dependency-outage",
  "latency-creep",
  "traffic-spike",
]);

interface BackfillState {
  generation: number;
  cursorMs: number;
  startMs: number;
  endMs: number;
}

/** Reset parameters persisted by `handleReset`'s first gate so the wipe -> seeding step
 * (`advanceReset`) is resumable from the alarm handler after a transient failure. */
interface PendingReset {
  generation: number;
  nowMs: number;
}

interface PartialMinute {
  minuteTs: number;
  stats: RequestStat[];
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function parseSimRate(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Per-tick RNG seed for live generation — genuinely random (unlike backfill's deterministic
 * per-window hash), since live ticks aren't expected to be reproducible, only their *effects*
 * (fault-driven or not) are what tests assert on. */
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

export class SimulatorDO extends DurableObject<Env> {
  /** Injected hook invoked once backfill's final chunk completes (spec §6: "backfill ends with a
   * synchronous baseline recompute — the detector is never armed without baselines"). Kept as a
   * mutable instance property (not a closed-over reference) so tests can substitute a spy via
   * `runInDurableObject`; defaults to the real `computeBaselines` (Task 3.1). */
  recomputeBaselines: (db: D1Database, nowMs: number) => Promise<number> = computeBaselines;

  /** TEST-ONLY wall-clock override — always `null` in production, where `now()` reads
   * `Date.now()`. No HTTP route sets this; it's only reachable via `runInDurableObject`'s direct
   * instance access, which is how `test/integration/simulator.test.ts` drives deterministic,
   * alarm-based flows without waiting on real time (the documented vitest-pool-workers pattern
   * for this is calling `alarm()` directly, per the task brief). */
  private testNowMs: number | null = null;

  setTestNow(ms: number | null): void {
    this.testNowMs = ms;
  }

  private now(): number {
    return this.testNowMs ?? Date.now();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "GET /status":
        return this.handleStatus();
      case "POST /fault":
        return this.handleFault(request);
      case "POST /restore":
        return this.handleRestore();
      case "POST /reset":
        return this.handleReset();
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    // Re-armed FIRST, unconditionally, before any other await — a pending alarm must exist across
    // every subsequent await in this method (task brief: alarm re-arm-at-top requirement).
    await this.armAlarm(ALARM_INTERVAL_MS);

    const worldStatus = (await this.ctx.storage.get<WorldStatus>("worldStatus")) ?? "unseeded";
    if (worldStatus === "seeding") {
      await this.runBackfillTick();
    } else if (worldStatus === "running") {
      await this.runLiveTick();
    } else if (worldStatus === "resetting") {
      // Recovery path: a reset's wipe -> seeding step failed after handleReset returned 202 and a
      // recovery alarm was armed. Retry it here (idempotent; no-op if pendingReset is gone). If it
      // throws again, the alarm re-armed at the top of this handler retries on the next firing.
      await this.advanceReset();
    }
    // 'unseeded': no alarm is normally pending; a stray firing just re-arms above and no-ops.
  }

  // --- HTTP handlers ---------------------------------------------------------------------------

  private async handleStatus(): Promise<Response> {
    const worldStatus = (await this.ctx.storage.get<WorldStatus>("worldStatus")) ?? "unseeded";
    const fault = (await this.ctx.storage.get<FaultState>("fault")) ?? null;
    const generation = (await this.ctx.storage.get<number>("generation")) ?? 0;
    const seedProgress = await this.ctx.storage.get<number>("seedProgress");
    // `seedProgress: undefined` is dropped by JSON.stringify, matching the brief's `seedProgress?`.
    return jsonResponse({ worldStatus, fault, generation, seedProgress }, 200);
  }

  private async handleFault(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_body" }, 400);
    }
    const scenario = (body as { scenario?: unknown } | null)?.scenario;
    if (typeof scenario !== "string" || !VALID_SCENARIOS.has(scenario as ScenarioId)) {
      return jsonResponse({ error: "invalid_scenario" }, 400);
    }

    return this.ctx.blockConcurrencyWhile(async () => {
      const fault = (await this.ctx.storage.get<FaultState>("fault")) ?? null;
      if (fault !== null) return jsonResponse({ error: "scenario_active" }, 409);

      const lastChaosAtMs = (await this.ctx.storage.get<number>("lastChaosAtMs")) ?? -Infinity;
      const now = this.now();
      const elapsed = now - lastChaosAtMs;
      if (elapsed < CHAOS_COOLDOWN_MS) {
        return jsonResponse({ error: "cooldown", retryAfterMs: CHAOS_COOLDOWN_MS - elapsed }, 429);
      }

      const newFault: FaultState = { scenario: scenario as ScenarioId, startedMs: now };
      await this.ctx.storage.put("fault", newFault);
      await this.ctx.storage.put("lastChaosAtMs", now);
      return jsonResponse({ fault: newFault }, 200);
    });
  }

  private async handleRestore(): Promise<Response> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put("fault", null);
    });
    return jsonResponse({ fault: null }, 200);
  }

  private async handleReset(): Promise<Response> {
    const gate = await this.ctx.blockConcurrencyWhile(async () => {
      const worldStatus = (await this.ctx.storage.get<WorldStatus>("worldStatus")) ?? "unseeded";
      const now = this.now();

      // Self-heal escape hatch: 'resetting'/'seeding' normally reject a new reset, but those
      // states are only legitimate while an alarm is pending to advance them. No pending alarm
      // means a previous reset died between committing state and re-arming (isolate death,
      // unrecovered wipe failure) — treat the state as wedged and let this reset take over,
      // bypassing the cooldown too (a wedged world must not stay bricked for 10 minutes).
      const inProgress = worldStatus === "seeding" || worldStatus === "resetting";
      const wedged = inProgress && (await this.ctx.storage.getAlarm()) === null;
      if (inProgress && !wedged) {
        return { ok: false as const, retryAfterMs: RESET_COOLDOWN_MS };
      }
      if (!wedged) {
        const lastResetAtMs = (await this.ctx.storage.get<number>("lastResetAtMs")) ?? -Infinity;
        const sinceLastReset = now - lastResetAtMs;
        if (sinceLastReset < RESET_COOLDOWN_MS) {
          return { ok: false as const, retryAfterMs: RESET_COOLDOWN_MS - sinceLastReset };
        }
      }

      const generation = ((await this.ctx.storage.get<number>("generation")) ?? 0) + 1;
      await this.ctx.storage.put("generation", generation);
      await this.ctx.storage.put<WorldStatus>("worldStatus", "resetting");
      await this.ctx.storage.put("lastResetAtMs", now);
      await this.ctx.storage.put("fault", null);
      await this.ctx.storage.delete("partialMinute");
      // Persisted (not closed over) so the wipe -> seeding step is resumable by the alarm
      // handler if this request's own attempt below fails partway.
      await this.ctx.storage.put<PendingReset>("pendingReset", { generation, nowMs: now });
      await this.ctx.storage.deleteAlarm();
      return { ok: true as const };
    });

    if (!gate.ok) {
      return jsonResponse({ error: "cooldown", retryAfterMs: gate.retryAfterMs }, 429);
    }

    try {
      await this.advanceReset();
    } catch {
      // Transient failure mid-wipe (e.g. a D1 hiccup). State is already recoverable — status
      // 'resetting' + pendingReset persisted above — so arm a recovery alarm and let the alarm
      // handler's 'resetting' branch retry `advanceReset`. If the isolate dies before even this
      // setAlarm lands, the no-pending-alarm escape hatch above un-wedges the next /reset.
      await this.armAlarm(ALARM_INTERVAL_MS);
    }

    return jsonResponse({ status: "resetting" }, 202);
  }

  /**
   * The wipe -> seeding step of a reset, driven by the `pendingReset` record `handleReset`
   * persists. Idempotent and resumable: callable again by the alarm handler (status 'resetting')
   * after a partial failure — the wipe re-runs harmlessly, and the gated transition below re-checks
   * the generation so a superseding reset makes this one a no-op.
   *
   * Investigation-abort and the telemetry wipe are not `ctx.storage` operations, so they run
   * outside the input gate (spec §6: "DO input gates do not protect across D1/fetch awaits").
   * That's safe: worldStatus is 'resetting' throughout, so no tick/backfill can run concurrently,
   * and a competing /reset is rejected (non-wedged in-progress state) until this reaches 'seeding'.
   */
  private async advanceReset(): Promise<void> {
    const pending = await this.ctx.storage.get<PendingReset>("pendingReset");
    if (!pending) return;
    const generation = await this.ctx.storage.get<number>("generation");
    if (generation !== pending.generation) {
      await this.ctx.storage.delete("pendingReset"); // superseded by a newer reset
      return;
    }

    await this.abortActiveInvestigation();
    await this.wipeTelemetryTables();

    await this.ctx.blockConcurrencyWhile(async () => {
      const currentGeneration = await this.ctx.storage.get<number>("generation");
      if (currentGeneration !== pending.generation) return; // superseded mid-wipe

      const endMs = Math.floor(pending.nowMs / MINUTE_MS) * MINUTE_MS;
      const startMs = endMs - BACKFILL_TOTAL_MS;
      const backfill: BackfillState = { generation: pending.generation, cursorMs: startMs, startMs, endMs };
      await this.ctx.storage.put<WorldStatus>("worldStatus", "seeding");
      await this.ctx.storage.put("seedProgress", 0);
      await this.ctx.storage.put("backfill", backfill);
      await this.ctx.storage.delete("pendingReset");
      await this.armAlarm(ALARM_INTERVAL_MS);
    });
  }

  // --- Internals ---------------------------------------------------------------------------------

  private async armAlarm(delayMs: number): Promise<void> {
    // Always anchored to the *real* wall clock, never `this.now()`: the alarm's own scheduling is
    // a physical-timer concern the runtime owns, independent of `testNowMs` (which only fakes the
    // simulated timestamps tick/backfill logic compute with). Scheduling against a faked, far-past
    // `this.now()` would make every alarm look overdue to the real alarm manager and race with
    // tests' manual `alarm()` calls; in production `testNowMs` is always null so this is simply
    // `Date.now() + delayMs` either way.
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private async wipeTelemetryTables(): Promise<void> {
    // Telemetry tables only (spec §6): spans/logs/rollups/deploys. Incidents, investigation_steps,
    // baselines, and meta are explicitly preserved across a reset.
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM spans"),
      this.env.DB.prepare("DELETE FROM logs"),
      this.env.DB.prepare("DELETE FROM rollups"),
      this.env.DB.prepare("DELETE FROM deploys"),
    ]);
  }

  private async abortActiveInvestigation(): Promise<void> {
    // TODO(Task 3.3/4.2): once InvestigatorDO tracks an active investigation, fail it here via an
    // INVESTIGATOR fetch (spec §6: "mark any active investigation failed ('world reset', partial
    // timeline preserved)"). No-op today — InvestigatorDO is still the Task-1.4-era 501 stub with
    // no investigation state to abort; this task's controller resolution explicitly defers the
    // wiring to those later tasks.
  }

  /**
   * Runs one ~20s live tick: generates `[lastTickMs, now())` minute-aligned sub-window by
   * sub-window (so timestamp-less `RequestStat`s can be unambiguously attributed to a minute for
   * rollup purposes), persists sampled spans/logs every tick, and closes rollups only for minutes
   * that fully finished within this tick — the still-open minute's stats carry to the next tick
   * via `partialMinute` storage.
   *
   * `capturedGenerationOverride` is a TEST-ONLY seam (see `runLiveTickForTest`): production always
   * omits it, so the captured generation is simply whatever's in storage at the top of this call
   * (mirroring "captured before the awaits" exactly, since a genuine concurrent reset can only
   * land during one of the awaits below, never during the synchronous compute in between).
   */
  private async runLiveTick(capturedGenerationOverride?: number): Promise<{ wrote: boolean }> {
    const storedGeneration = await this.ctx.storage.get<number>("generation");
    if (storedGeneration === undefined) return { wrote: false };
    const capturedGeneration = capturedGenerationOverride ?? storedGeneration;

    const nowMs = this.now();
    const lastTickMs = (await this.ctx.storage.get<number>("lastTickMs")) ?? nowMs;
    if (nowMs <= lastTickMs) {
      await this.ctx.storage.put("lastTickMs", nowMs);
      return { wrote: false };
    }

    const fault = (await this.ctx.storage.get<FaultState>("fault")) ?? null;
    const simRate = parseSimRate(this.env.SIM_RATE);
    const partial = (await this.ctx.storage.get<PartialMinute>("partialMinute")) ?? null;

    const spans: Span[] = [];
    const logs: LogLine[] = [];
    const rollups: RollupRow[] = [];
    let minuteAcc: PartialMinute | null = partial ? { minuteTs: partial.minuteTs, stats: [...partial.stats] } : null;

    let cursor = lastTickMs;
    while (cursor < nowMs) {
      const minuteStart = Math.floor(cursor / MINUTE_MS) * MINUTE_MS;
      const nextBoundary = minuteStart + MINUTE_MS;
      const subTo = Math.min(nextBoundary, nowMs);

      // Effects evaluated once per minute-aligned sub-window (at its end) rather than
      // continuously — a 20s-60s granularity tradeoff; fine for a demo simulator and irrelevant
      // to correctness of the stale-generation guard below.
      const effects = effectsFor(fault, subTo);
      const rng = mulberry32(randomSeed());
      const batch = generateWindow(cursor, subTo, effects, rng, simRate);
      const sampled = sampleForPersistence(batch, rng);
      spans.push(...sampled.spans);
      logs.push(...sampled.logs);

      if (!minuteAcc || minuteAcc.minuteTs !== minuteStart) {
        minuteAcc = { minuteTs: minuteStart, stats: [] };
      }
      minuteAcc.stats.push(...batch.requests);

      if (subTo === nextBoundary) {
        rollups.push(...rollupFromStats(minuteAcc.stats, minuteAcc.minuteTs));
        minuteAcc = null;
      }
      cursor = subTo;
    }

    const deploys: Deploy[] = deployEventsFor(fault).filter((d) => d.ts_ms >= lastTickMs && d.ts_ms < nowMs);

    // Stale-generation guard: captured above (or supplied by a test), re-checked immediately
    // before the D1 writes — the only awaits in this method not covered by an input gate. Discard
    // the whole batch (no insert at all) if a reset landed underneath us in between.
    //
    // Accepted limitation (reviewer-acknowledged): a reset can still land in the residual window
    // between this re-check passing and the D1 batch committing, letting one tick's rows (~a few
    // hundred max) into the freshly wiped world. Bounded and self-healing — no unique keys means
    // no errors, and retention ages the strays out — so per-row generation tagging is deliberately
    // not implemented for this demo.
    const currentGeneration = await this.ctx.storage.get<number>("generation");
    if (currentGeneration !== capturedGeneration) return { wrote: false };

    await insertSpans(this.env.DB, spans);
    await insertLogs(this.env.DB, logs);
    await insertRollups(this.env.DB, rollups);
    for (const deploy of deploys) {
      await this.insertDeployIgnoreDuplicate(deploy);
    }

    await this.ctx.storage.put("lastTickMs", nowMs);
    if (minuteAcc) {
      await this.ctx.storage.put("partialMinute", minuteAcc);
    } else {
      await this.ctx.storage.delete("partialMinute");
    }

    return { wrote: true };
  }

  /**
   * TEST-ONLY: exercises `runLiveTick`'s stale-generation branch deterministically. A genuine
   * concurrent race between an in-flight tick and a reset isn't reproducible from a single
   * synchronous test invocation (there's no I/O boundary a test can interleave into mid-method),
   * so the captured generation is supplied explicitly instead of read from storage — see
   * `test/integration/simulator.test.ts`'s "stale-generation batch is discarded" case.
   */
  async runLiveTickForTest(capturedGenerationOverride: number): Promise<{ wrote: boolean }> {
    return this.runLiveTick(capturedGenerationOverride);
  }

  private async insertDeployIgnoreDuplicate(deploy: Deploy): Promise<void> {
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO deploys (id, service, version, ts_ms, note) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(deploy.id, deploy.service, deploy.version, deploy.ts_ms, deploy.note)
      .run();
  }

  /**
   * Runs one backfill chunk (~4h of history) and advances the stored cursor. The final chunk
   * additionally invokes the injected `recomputeBaselines` hook and seeds the demo incident, then
   * flips the world to 'running' and hands off to `runLiveTick` on the next alarm firing. Mirrors
   * `runLiveTick`'s stale-generation guard (and its TEST-ONLY override seam).
   */
  private async runBackfillTick(capturedGenerationOverride?: number): Promise<{ wrote: boolean }> {
    const storedGeneration = await this.ctx.storage.get<number>("generation");
    const backfill = await this.ctx.storage.get<BackfillState>("backfill");
    if (storedGeneration === undefined || !backfill || backfill.generation !== storedGeneration) {
      return { wrote: false };
    }
    const capturedGeneration = capturedGenerationOverride ?? storedGeneration;

    const chunkFromMs = backfill.cursorMs;
    const chunkToMs = Math.min(chunkFromMs + BACKFILL_CHUNK_MS, backfill.endMs);
    const simRate = parseSimRate(this.env.SIM_RATE);
    const batch = runBackfillChunk(chunkFromMs, chunkToMs, simRate);

    // Same residual stale-write window as runLiveTick's re-check (see the comment there): a reset
    // between this check and the batch commit can leave one chunk's rows behind — accepted, bounded,
    // aged out by retention.
    const currentGeneration = await this.ctx.storage.get<number>("generation");
    if (currentGeneration !== capturedGeneration) return { wrote: false };

    await insertSpans(this.env.DB, batch.spans);
    await insertLogs(this.env.DB, batch.logs);
    await insertRollups(this.env.DB, batch.rollups);

    const isFinal = chunkToMs >= backfill.endMs;
    if (!isFinal) {
      const progress = (chunkToMs - backfill.startMs) / BACKFILL_TOTAL_MS;
      await this.ctx.storage.put("seedProgress", Math.min(1, progress));
      await this.ctx.storage.put<BackfillState>("backfill", { ...backfill, cursorMs: chunkToMs });
      return { wrote: true };
    }

    await this.recomputeBaselines(this.env.DB, backfill.endMs);
    await insertSeededIncident(this.env.DB, backfill.endMs);

    const finalGeneration = await this.ctx.storage.get<number>("generation");
    if (finalGeneration !== capturedGeneration) return { wrote: true }; // chunk + seed data landed; skip only the flip to 'running'

    await this.ctx.storage.put<WorldStatus>("worldStatus", "running");
    await this.ctx.storage.delete("backfill");
    await this.ctx.storage.delete("seedProgress");
    await this.ctx.storage.delete("partialMinute");
    await this.ctx.storage.put("lastTickMs", backfill.endMs);

    return { wrote: true };
  }
}
