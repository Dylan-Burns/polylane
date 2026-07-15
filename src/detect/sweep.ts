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
 *  2. **Evaluate + incident lifecycle open path**: pull the last two *completed* minutes'
 *     `MetricPoint`s (via `read.ts`'s `queryMetrics`, not the agent-facing tool layer) and the
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
  openIncident,
} from "../telemetry/incidents";
import { queryMetrics } from "../telemetry/read";
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
 * under `investigation_count_hour`. Returns `true` (and consumes one slot) iff under budget.
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
async function tryConsumeInvestigationBudget(db: D1Database, nowMs: number): Promise<boolean> {
  const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(INVESTIGATION_BUDGET_META_KEY).first<{ value: string }>();
  let state = parseInvestigationRateState(row?.value, nowMs);
  if (nowMs - state.windowStartMs >= INVESTIGATION_RATE_WINDOW_MS) {
    state = { windowStartMs: nowMs, count: 0 };
  }
  if (state.count >= INVESTIGATION_RATE_LIMIT) return false;

  state.count += 1;
  await db
    .prepare(`REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .bind(INVESTIGATION_BUDGET_META_KEY, JSON.stringify(state))
    .run();
  return true;
}

/** Best-effort notification of `env.INVESTIGATOR`'s singleton stub — fire-and-forget: `/start`
 * returns as soon as `InvestigatorDO` has durably recorded the investigation and armed its alarm
 * (Task 4.2), well before the loop itself runs, so this call is fast regardless of how long the
 * investigation ends up taking. A thrown fetch (DO unreachable) is caught and logged, never
 * allowed to fail the sweep. */
async function notifyInvestigator(env: Env, incidentId: string, anomalies: readonly Anomaly[]): Promise<void> {
  const statement = anomalies.map((a) => a.statement).join(" | ");
  try {
    await investigatorStub(env).fetch("http://investigator/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId, statement }),
    });
  } catch (err) {
    console.error(`sweep: failed to notify INVESTIGATOR for incident ${incidentId}`, err);
  }
}

/** Subtask 2: evaluate the last two completed minutes and drive the incident open/append path. */
async function runDetection(env: Env, nowMs: number): Promise<void> {
  const currentMinuteStart = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  const minute0Start = currentMinuteStart - MINUTE_MS; // most recent *completed* minute
  const minute1Start = currentMinuteStart - 2 * MINUTE_MS;

  const [minute0, minute1, baselines] = await Promise.all([
    queryMetrics(env.DB, { fromMs: minute0Start, toMs: minute0Start + MINUTE_MS, stepMin: 1 }),
    queryMetrics(env.DB, { fromMs: minute1Start, toMs: minute1Start + MINUTE_MS, stepMin: 1 }),
    getBaselines(env.DB),
  ]);

  const anomalies = evaluate([minute0, minute1], baselines);
  if (anomalies.length === 0) return;

  const { id, created } = await openIncident(env.DB, anomalies, nowMs);
  if (created) {
    const allowed = await tryConsumeInvestigationBudget(env.DB, nowMs);
    if (allowed) {
      await notifyInvestigator(env, id, anomalies);
    } else {
      console.warn(`sweep: investigation budget exhausted this hour, not starting investigator for incident ${id}`);
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
