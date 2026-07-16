/**
 * The cron sweep (spec §8, task brief): everything that runs once a minute (`wrangler.jsonc`'s
 * `* * * * *` trigger, wired to `runSweep` from `index.ts`'s `scheduled` handler). Five ordered
 * subtasks, each **individually try/caught** — a throw in one (e.g. a transient D1 error in
 * retention) is logged and does NOT stop the others; detection runs first specifically so a
 * later-subtask failure can never prevent an incident from opening:
 *
 *  1. **World-status gate**: fetch SimulatorDO's `/status`; unless `worldStatus === 'running'`,
 *     every other subtask is skipped this tick (spec §6: "the detector no-ops unless the world
 *     status ... is running" — mid-reset/backfill telemetry is incomplete or about to be wiped, so
 *     detecting, auto-resolving, recomputing baselines, or pruning against it would all be wrong).
 *  2. **Evaluate + incident lifecycle open path**: pull the two newest minutes PRESENT in
 *     `rollups` (anchored via `read.ts`'s `latestRollupMinute`, never wall-clock arithmetic — the
 *     simulator's tick writes a closed minute's rows up to ~20s after the boundary, later than
 *     this cron fires; see `runDetection`) as `MetricPoint`s (via `queryMetrics`) and the
 *     current `BaselineMap`, run `detect/rules.ts`'s `evaluate()`, and for a non-empty result call
 *     `incidents.ts`'s `openIncident` with the whole batch. `created: true` -> best-effort notify
 *     `env.INVESTIGATOR`'s `/start` (guarded by a `meta`-backed <= 10/hour counter — see
 *     `tryConsumeInvestigationBudget`). `created: false` (covered by an existing incident) ->
 *     `appendFingerprints` onto it instead; deliberately no `/start` call, which is exactly how the
 *     mandated integration test proves dedupe (two sweeps over an unresolved fault -> exactly one
 *     `/start`, not one incident row still gets an accumulated fingerprint history). Finally,
 *     anomalies owned by a DIFFERENT still-covering incident than the one the batch folded onto
 *     (reachable when two incidents are open concurrently, e.g. a residual false positive plus a
 *     real fault) are routed to their own incidents via per-owner `appendFingerprints` calls — so
 *     every open incident whose fingerprint is still breaching gets its auto-resolve health clock
 *     refreshed every tick, and its evidence recorded on the RIGHT incident, regardless of which
 *     incident happened to absorb the batch this tick.
 *  3. **Lifecycle housekeeping**: `autoResolve` then `forceFailStuck` (see `incidents.ts`).
 *  4. **Baseline recompute**: every 15 minutes on the wall clock (`floor(nowMs/60_000) % 15 === 0`),
 *     `detect/baselines.ts`'s `computeBaselines`.
 *  5. **Retention**: `telemetry/retention.ts`'s `sweepRetention`, bounded to 5000 rows/run.
 *
 * **Residual false positives** (documented in full in `detect/rules.ts`'s top comment): the v2.1
 * evidence-gated rules still leak ~0.17 FP/day globally even after the evidence-gate tightening —
 * this incident layer is the second half of that design, not a bug to chase away here. A spurious
 * `evaluate()` hit opens (or gets folded into) an incident exactly like a real one, but
 * `autoResolve`'s 5-consecutive-healthy-minute rule clears it again within ~5-10 minutes with no
 * human/agent involvement, and dedupe means a noisy fingerprint can't reopen a fresh incident every
 * single minute while it's flapping. The false-positive *rate* is absorbed by the lifecycle, not
 * eliminated at the rule layer.
 */

import { computeBaselines, getBaselines } from "./baselines";
import { evaluate, type Anomaly } from "./rules";
import { investigatorStub } from "../agent/investigator-do";
import type { Env } from "../env";
import { MINUTE_MS } from "../sim/backfill";
import { simulatorStub } from "../sim/simulator-do";
import {
  appendFingerprints,
  autoResolve,
  findOwnersByFingerprint,
  forceFailStuck,
  insertInvestigationStep,
  openIncident,
} from "../telemetry/incidents";
import { latestRollupMinute, queryMetrics } from "../telemetry/read";
import { sweepRetention } from "../telemetry/retention";

const BASELINE_RECOMPUTE_INTERVAL_MIN = 15;
const RETENTION_MAX_ROWS = 5000;

/** Meta key holding the epoch-ms `nowMs` of the most recent sweep tick that ran to completion
 * (world running, all four subtasks attempted — see the bottom of `runSweep`). Exported so
 * `telemetry/state.ts`'s `getOpsHealth` (Task 5.1's `/api/state` ops-health panel) reads the exact
 * key this file writes, rather than a second hand-copied literal. */
export const LAST_SWEEP_OK_META_KEY = "last_sweep_ok_ms";

const INVESTIGATION_RATE_LIMIT = 10;
const INVESTIGATION_RATE_WINDOW_MS = 60 * 60_000;
const INVESTIGATION_BUDGET_META_KEY = "investigation_count_hour";

/** Fetches SimulatorDO's `/status` and reports whether the world is live-ticking. Any failure
 * (network error, non-2xx, malformed JSON) is treated as "not running" — the caller's gate then
 * skips the rest of the sweep, which is the safe default when the world's state is unknown. */
async function isWorldRunning(env: Env): Promise<boolean> {
  const res = await simulatorStub(env).fetch("http://simulator/status");
  if (!res.ok) return false;
  const body = (await res.json()) as { worldStatus?: string };
  return body.worldStatus === "running";
}

interface InvestigationRateState {
  windowStartMs: number;
  count: number;
}

/** Parses a persisted `InvestigationRateState`, falling back to a fresh window (fail OPEN, not
 * closed) on missing/malformed data — a corrupt counter should degrade to "allow investigations"
 * rather than silently blocking every future incident's `/start` call forever (the much worse
 * failure mode for a guardrail that exists to cap cost, not to gate correctness). Logged so the
 * corruption is visible. */
function parseInvestigationRateState(raw: string | undefined, nowMs: number): InvestigationRateState {
  if (raw === undefined) return { windowStartMs: nowMs, count: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<InvestigationRateState>;
    if (typeof parsed.windowStartMs === "number" && typeof parsed.count === "number") {
      return { windowStartMs: parsed.windowStartMs, count: parsed.count };
    }
    throw new Error("malformed investigation-budget state shape");
  } catch (err) {
    console.error("sweep: investigation_count_hour meta value is corrupt; resetting the window", err);
    return { windowStartMs: nowMs, count: 0 };
  }
}

/**
 * Fixed-window (not sliding) <= 10/hour guard on starting new investigations, persisted in `meta`
 * under `investigation_count_hour`. Read here (window-folded); consumed in `startInvestigation`
 * only after a successful `/start`.
 *
 * **Known limitation (accepted)**: a plain read-then-write, not a SQL-level atomic increment. It
 * is correct as long as two sweep runs never interleave — Cloudflare does not overlap a Worker's
 * own scheduled invocations in practice, but that is observed platform behavior, not a documented
 * contractual guarantee. The exposure is cron-vs-cron only (`runSweep` is wired solely to the
 * `scheduled` handler and is not HTTP-reachable), and the worst case of an interleaving is an
 * over- or under-count of a couple of investigations within one hour — a bounded cost overrun (or
 * a one-tick start delay), never a correctness break — so no locking/CAS is layered on for this
 * project.
 */
async function readInvestigationRateState(db: D1Database, nowMs: number): Promise<InvestigationRateState> {
  const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(INVESTIGATION_BUDGET_META_KEY).first<{ value: string }>();
  const state = parseInvestigationRateState(row?.value, nowMs);
  if (nowMs - state.windowStartMs >= INVESTIGATION_RATE_WINDOW_MS) {
    return { windowStartMs: nowMs, count: 0 };
  }
  return state;
}

/** Notifies `env.INVESTIGATOR`'s singleton stub and reports whether the investigation actually
 * STARTED: `/start` 409s (`investigation_active`) while another investigation holds the DO — up
 * to its 4-minute wall budget — and treating that as "notified" silently orphaned the incident
 * (the budget slot burned, the timeline stayed empty, and no later sweep retried; the ordinary
 * restore-A-then-inject-B demo flow hit this). A thrown fetch (DO unreachable) is the same
 * outcome as a rejection: not started. Never allowed to fail the sweep. */
async function notifyInvestigator(env: Env, incidentId: string, statement: string): Promise<boolean> {
  try {
    const res = await investigatorStub(env).fetch("http://investigator/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId, statement }),
    });
    if (!res.ok) {
      console.warn(`sweep: INVESTIGATOR /start rejected for incident ${incidentId} (HTTP ${res.status})`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`sweep: failed to notify INVESTIGATOR for incident ${incidentId}`, err);
    return false;
  }
}

type StartOutcome = "started" | "budget" | "busy";

/** The one place an investigation is started: budget peeked FIRST (never start over budget), the
 * slot consumed only AFTER `/start` succeeds — a 409-busy or unreachable DO no longer burns one of
 * the 10 hourly slots for an investigation that never ran. Peek-then-consume shares
 * `tryConsume`-style read-modify-write semantics and the same accepted cron-vs-cron race (see the
 * fixed-window doc above); sweeps are single-flight in practice. */
async function startInvestigation(env: Env, incidentId: string, statement: string, nowMs: number): Promise<StartOutcome> {
  const state = await readInvestigationRateState(env.DB, nowMs);
  if (state.count >= INVESTIGATION_RATE_LIMIT) return "budget";
  const started = await notifyInvestigator(env, incidentId, statement);
  if (!started) return "busy";
  state.count += 1;
  await env.DB
    .prepare(`REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .bind(INVESTIGATION_BUDGET_META_KEY, JSON.stringify(state))
    .run();
  return "started";
}

/** The visible why-is-this-timeline-empty note for a deferred start (budget exhausted or
 * investigator busy) — written ONCE, on the incident's creation tick; the retry subtask stays
 * silent until it succeeds. Best-effort: a failure to write the note must not fail the sweep. */
async function recordDeferredNote(db: D1Database, incidentId: string, outcome: Exclude<StartOutcome, "started">, nowMs: number): Promise<void> {
  const note =
    outcome === "budget"
      ? "Investigation deferred — the hourly investigation budget (10/hour) is exhausted. The incident is recorded; the sweep retries automatically once the budget window resets."
      : "Investigation deferred — the investigator is busy with another incident. The incident is recorded; the sweep retries automatically once the investigator is free.";
  try {
    await insertInvestigationStep(db, {
      incidentId,
      stepNo: 0,
      kind: "note",
      contentJson: JSON.stringify({ note }),
      tsMs: nowMs,
      tokensIn: 0,
      tokensOut: 0,
    });
  } catch (err) {
    console.error(`sweep: failed to record deferred note for incident ${incidentId}`, err);
  }
}

/** How old the newest rollup minute may be before detection declines to run on it: normal
 * freshest-data age at cron time is 63–123s (a closed minute's rollups land up to ~20s after the
 * boundary; the cron fires at an arbitrary offset in the next minute), so 5 minutes tolerates a
 * missed tick or two while refusing to evaluate a long-stalled world's ancient data as if it were
 * current (statements say "since HH:MMZ" — firing them 20 minutes late would be dishonest noise). */
const DETECTION_MAX_ROLLUP_AGE_MS = 5 * MINUTE_MS;

/** Subtask 2: evaluate the two newest rolled-up minutes and drive the incident open/append path. */
async function runDetection(env: Env, nowMs: number): Promise<void> {
  // Anchored on the newest minute PRESENT in `rollups` (see `latestRollupMinute`'s doc comment),
  // never on wall-clock arithmetic: the cron consistently fires BEFORE the simulator's tick has
  // written the wall-clock last-completed minute, so a wall-clock minute0 is empty every single
  // sweep — the production-blindness bug this replaced (all rules no-op on an empty minute; live
  // detection never fired at all while every fixture-seeded test stayed green).
  const latestMinute = await latestRollupMinute(env.DB);
  if (latestMinute === null) return; // no telemetry at all — nothing to evaluate
  if (nowMs - latestMinute > DETECTION_MAX_ROLLUP_AGE_MS) {
    console.warn(
      `sweep: newest rollup minute is ${Math.round((nowMs - latestMinute) / 1000)}s old; skipping detection (stalled simulator?)`,
    );
    return;
  }
  const minute0Start = latestMinute;
  const minute1Start = latestMinute - MINUTE_MS;

  const [minute0, minute1, baselines] = await Promise.all([
    queryMetrics(env.DB, { fromMs: minute0Start, toMs: minute0Start + MINUTE_MS, stepMin: 1 }),
    queryMetrics(env.DB, { fromMs: minute1Start, toMs: minute1Start + MINUTE_MS, stepMin: 1 }),
    getBaselines(env.DB),
  ]);

  const anomalies = evaluate([minute0, minute1], baselines);
  if (anomalies.length === 0) return;

  const { id, created } = await openIncident(env.DB, anomalies, nowMs);
  if (created) {
    const statement = anomalies.map((a) => a.statement).join(" | ");
    const outcome = await startInvestigation(env, id, statement, nowMs);
    if (outcome !== "started") {
      // Deferred start (budget kill-switch — Task 7.1 — or investigator busy): the incident still
      // opens and is visible, with a note explaining WHY its timeline is empty; the
      // `retryDeferredInvestigations` subtask picks it up on later sweeps.
      console.warn(`sweep: investigation deferred (${outcome}) for incident ${id}`);
      await recordDeferredNote(env.DB, id, outcome, nowMs);
    }
  } else {
    await appendFingerprints(env.DB, id, anomalies, nowMs);
  }

  // Cross-incident routing (see the file doc comment, subtask 2): the batch may span MORE open
  // incidents than the one `openIncident` selected — `appendFingerprints` above deliberately
  // drops anomalies owned by a different incident rather than mis-attributing them, so route
  // each of those to its actual owner here. Ownership is re-resolved AFTER the open/append above
  // (a just-created incident now owns its whole batch, making this a no-op on the `created`
  // path), and each foreign owner gets exactly its own anomalies — refreshing that incident's
  // health clock so a still-breaching fault can never auto-resolve just because a different
  // incident absorbed the batch this tick.
  const owners = await findOwnersByFingerprint(env.DB, [...new Set(anomalies.map((a) => a.fingerprint))], nowMs);
  const foreignByOwner = new Map<string, Anomaly[]>();
  for (const anomaly of anomalies) {
    const owner = owners.get(anomaly.fingerprint);
    if (owner !== undefined && owner !== id) {
      const group = foreignByOwner.get(owner);
      if (group) group.push(anomaly);
      else foreignByOwner.set(owner, [anomaly]);
    }
  }
  for (const [ownerId, group] of foreignByOwner) {
    await appendFingerprints(env.DB, ownerId, group, nowMs);
  }
}

/** Subtask 3: incident lifecycle housekeeping that doesn't depend on this tick's `evaluate()`
 * output — auto-resolving recovered incidents and force-failing stuck investigations. */
async function runLifecycleHousekeeping(env: Env, nowMs: number): Promise<void> {
  await autoResolve(env.DB, nowMs);
  await forceFailStuck(env.DB, nowMs);
}

/** Subtask 4: baseline recompute, gated to once every 15 wall-clock minutes (spec §8). */
async function maybeRecomputeBaselines(env: Env, nowMs: number): Promise<void> {
  const minute = Math.floor(nowMs / MINUTE_MS);
  if (minute % BASELINE_RECOMPUTE_INTERVAL_MIN === 0) {
    await computeBaselines(env.DB, nowMs);
  }
}

/**
 * Runs one sweep tick. `nowMs` defaults to `Date.now()` for production (the `scheduled` handler
 * passes `controller.scheduledTime` explicitly instead, which is the more accurate "when this cron
 * actually fired" timestamp); every test calls this with an explicit `nowMs` for determinism. Never
 * throws — see the file doc comment for the five subtasks and their individual try/catch isolation.
 */
/** How old an `open` incident must be before the retry subtask attempts its start — excludes the
 * incident created THIS tick (it already got its attempt in `runDetection`). */
const RETRY_START_MIN_AGE_MS = 30_000;

/** Rebuilds the `/start` statement from a persisted `trigger_json` — the sweep-written
 * `{statements, anomalies}` shape (`incidents.ts`'s `buildTrigger`); returns null for anything
 * else (a shape with no statements has nothing to brief the investigator with). */
function statementFromTrigger(triggerJson: string): string | null {
  try {
    const trigger = JSON.parse(triggerJson) as { statements?: unknown };
    if (Array.isArray(trigger.statements)) {
      const statements = trigger.statements.filter((s): s is string => typeof s === "string");
      if (statements.length > 0) return statements.join(" | ");
    }
    return null;
  } catch {
    return null;
  }
}

/** Subtask: start deferred investigations. An incident that couldn't start when it opened (budget
 * exhausted, or the investigator busy with an earlier incident's up-to-4-minute run) previously
 * stayed `open` with an empty timeline FOREVER — nothing ever retried. `status = 'open'` is the
 * reliable "never started" marker (`InvestigatorDO`'s `/start` flips it to `investigating`
 * synchronously before returning 200), and a successful late start behaves exactly like an
 * on-time one. Budget-gated per attempt; a `budget` outcome stops the pass (no slot for anyone). */
async function retryDeferredInvestigations(env: Env, nowMs: number): Promise<void> {
  const { results } = await env.DB
    .prepare(`SELECT id, trigger_json FROM incidents WHERE status = 'open' AND opened_at <= ? ORDER BY opened_at ASC`)
    .bind(nowMs - RETRY_START_MIN_AGE_MS)
    .all<{ id: string; trigger_json: string }>();
  for (const row of results ?? []) {
    const statement = statementFromTrigger(row.trigger_json);
    if (statement === null) continue; // un-briefable trigger shape (e.g. hand-seeded) — leave it
    const outcome = await startInvestigation(env, row.id, statement, nowMs);
    if (outcome === "started") {
      console.log(`sweep: deferred investigation started for incident ${row.id}`);
    } else if (outcome === "budget") {
      return; // no slots left this window — later incidents can't start either
    }
    // "busy": the investigator is still occupied — silent (the creation-tick note already
    // explains the empty timeline); next sweep retries.
  }
}

export async function runSweep(env: Env, nowMs: number = Date.now()): Promise<void> {
  let worldRunning = false;
  try {
    worldRunning = await isWorldRunning(env);
  } catch (err) {
    console.error("sweep: world-status check failed", err);
  }
  if (!worldRunning) return;

  try {
    await runDetection(env, nowMs);
  } catch (err) {
    console.error("sweep: detection subtask failed", err);
  }

  try {
    await retryDeferredInvestigations(env, nowMs);
  } catch (err) {
    console.error("sweep: deferred-investigation retry subtask failed", err);
  }

  try {
    await runLifecycleHousekeeping(env, nowMs);
  } catch (err) {
    console.error("sweep: lifecycle housekeeping subtask failed", err);
  }

  try {
    await maybeRecomputeBaselines(env, nowMs);
  } catch (err) {
    console.error("sweep: baseline recompute subtask failed", err);
  }

  try {
    await sweepRetention(env.DB, nowMs, { maxRows: RETENTION_MAX_ROWS });
  } catch (err) {
    console.error("sweep: retention subtask failed", err);
  }

  // Recorded last, and only reached once the tick has run to completion (world running, every
  // subtask above attempted — each is individually try/caught, so a subtask's own failure never
  // stops us from getting here). `/api/state`'s ops-health panel surfaces this so the UI can flag
  // "the sweep hasn't run recently" if it stops advancing (e.g. the cron trigger itself breaks,
  // which no in-Worker try/catch can detect from the inside).
  try {
    await env.DB.prepare(`REPLACE INTO meta (key, value) VALUES (?, ?)`).bind(LAST_SWEEP_OK_META_KEY, String(nowMs)).run();
  } catch (err) {
    console.error("sweep: failed to record the last-sweep-ok watermark", err);
  }
}
