/**
 * Incident lifecycle (spec §8): `open -> investigating -> reported -> resolved | failed`. This is
 * the *write* side of `incidents`/`incident_fingerprints` — `read.ts`'s `getIncidents` stays the
 * read side, unchanged by this file. Every export here is a plain `(db, ...) => Promise<...>`,
 * like `queries.ts`/`baselines.ts` — no `Date.now()`, callers (the sweep, Task 3.3's own
 * `sweep.ts`; the investigator loop, Task 4.2; the chaos routes, `api/chaos.ts`) always pass an
 * explicit `nowMs`.
 *
 * **Dedupe** (spec §8): an incident whose fingerprint set already covers one of `anomalies`'
 * fingerprints, and whose status is `open`/`investigating`/`reported`, suppresses a new incident —
 * the whole batch is folded into that incident instead (`openIncident` returns `created: false`;
 * the caller then calls `appendFingerprints` to fold in the batch). A `failed` incident keeps
 * suppressing for a 10-minute re-arm window after its terminal timestamp (`resolved_at`, reused as
 * the generic "ended" column — see `setStatus`'s doc comment), then stops. `resolved` never
 * suppresses. `reported` is treated identically to `open`/`investigating` (permanent suppression,
 * no re-arm) — spec §8 describes a `follow_up_of`-linked incident opening for anomalies that arrive
 * after `reported` and persist past a re-arm delay, but that mechanism is driven by the
 * investigator loop reacting to post-report anomalies (Task 4.2, not yet built — `InvestigatorDO`
 * is still the Task-1.4-era 501 stub), so it's out of scope here; this file's dedupe binding text
 * ("suppressed by covering fingerprints on `open|investigating|reported`") is honored literally,
 * and `follow_up_of` is left unused pending that task. TODO(Task 4.2).
 *
 * Coverage is resolved **per fingerprint**, not batch-wide: `openIncident`/`appendFingerprints` both
 * look up which specific incident (if any) currently owns each individual fingerprint in the batch,
 * so a batch spanning two *different*, unrelated already-open incidents (e.g. a genuine fault
 * overlapping with a still-resolving false-positive from a different service — spec §8's documented
 * residual FP rate) never merges their evidence together; each fingerprint stays attributed to its
 * own incident. A batch containing one covered fingerprint and one genuinely new one (the common
 * "same cascade" case, e.g. bad-deploy's `payments:errors` opens the incident, `payments:latency`
 * breaches a minute later) still folds the new fingerprint onto the same incident, since only the
 * genuinely-new one has no owner yet.
 *
 * **Severity** (spec §7): decided once, at open time, from the *opening* batch only — `critical` if
 * any anomaly hard-tripped or the batch spans >= 2 distinct services, else `warning`. Never
 * recomputed by `appendFingerprints` (the schema's own comment: "the agent's report may comment but
 * doesn't change it").
 *
 * **`trigger_json` shape** (task brief): exactly `{statements: string[], anomalies: Anomaly[]}`,
 * agent/UI-facing and append-only for the incident's active life — `openIncident` seeds it with the
 * opening batch, `appendFingerprints` pushes every later batch onto it (even for fingerprints that
 * were already tracked — a still-breaching fingerprint reappearing is itself evidence worth keeping
 * in the audit trail, and it's what re-arms `autoResolve`'s healthy-streak clock, see below).
 * `statements` is always `anomalies.map(a => a.statement)`, kept as a separate field only because
 * the brief names it as one (a flat string list is cheaper for a report/UI to render than
 * re-deriving it from `anomalies` every time).
 *
 * **Atomicity**: every multi-row write in this file (`openIncident`'s create path,
 * `appendFingerprints`) is issued as a single `db.batch()` call — D1 batches are transactional
 * (all-or-nothing) — rather than several sequential round trips, so a transient D1 failure partway
 * through can never leave a ghost `incidents` row with no `incident_fingerprints`/health rows (which
 * would be unreachable by `findCoveringIncident`'s dedupe lookup and un-resolvable by `autoResolve`,
 * which skips any incident with zero tracked fingerprints).
 *
 * **Auto-resolve health tracking** ("you own the mechanism, keep it queryable and tested" — task
 * brief): deliberately NOT folded into `trigger_json` (that field is agent-facing content, not
 * internal bookkeeping) and NOT a new `incident_fingerprints` column (would need a migration this
 * task doesn't otherwise require). Instead, `meta` — already earmarked for exactly this
 * ("guardrail counters", migration 0001's comment) — holds one row per (incident, fingerprint):
 * key `incident_health:<incidentId>:<fingerprint>`, value the `nowMs` this fingerprint was last
 * seen anomalous. `openIncident`/`appendFingerprints` refresh it for every anomaly they record;
 * `autoResolve` reads it back and clears it once an incident resolves; `forceFailStuck` clears it on
 * force-fail too (a terminal incident's health rows serve no further purpose). A real SQL table row
 * (not a JSON blob field) stays directly queryable (`SELECT * FROM meta WHERE key LIKE
 * 'incident_health:%'`), which is what "queryable" asks for.
 */

import type { Anomaly } from "../detect/rules";
import type { IncidentView } from "./types";

export type IncidentStatus = IncidentView["status"];

/** `failed` stops suppressing dedupe this long after its terminal timestamp (spec §8: "prevents
 * both per-minute failure spam and permanently bricked detection"). */
const REARM_MS = 10 * 60_000;

/** `autoResolve`'s healthy-streak requirement (spec §8: "all fingerprints healthy 5 consecutive
 * minutes"). Approximated as "no anomalous sighting of this fingerprint in the last 5 minutes",
 * via the `meta`-backed `incident_health:*` timestamps described in the file doc comment above —
 * exact for the sweep's own 1-minute cron cadence, since a fingerprint can only be re-touched at
 * most once per completed minute. */
const HEALTHY_MS = 5 * 60_000;

/** `forceFailStuck`'s stuck-investigation watchdog (spec §8: "wall-clock cap (4 min) + 2 min grace"
 * = 6 min; task brief: "no investigation_steps row newer than 6 min -> failed"). Strictly greater
 * than, not >=, so an incident exactly at the 6-minute mark is not yet stuck. */
const STUCK_MS = 6 * 60_000;

// --- trigger_json ------------------------------------------------------------------------------

interface TriggerPayload {
  statements: string[];
  anomalies: Anomaly[];
}

/** Parses `trigger_json`, falling back to an empty payload (rather than throwing) on malformed
 * JSON — this column is never hand-edited in normal operation, but a fail-safe default keeps one
 * corrupt row from wedging every future `appendFingerprints`/`undeliveredUpdates` call against that
 * incident. Logged so the corruption isn't silently invisible. */
function parseTrigger(raw: string): TriggerPayload {
  try {
    const parsed = JSON.parse(raw) as Partial<TriggerPayload>;
    return { statements: parsed.statements ?? [], anomalies: parsed.anomalies ?? [] };
  } catch (err) {
    console.error("incidents: trigger_json failed to parse; falling back to an empty payload", err);
    return { statements: [], anomalies: [] };
  }
}

function buildTrigger(anomalies: readonly Anomaly[]): TriggerPayload {
  return { statements: anomalies.map((a) => a.statement), anomalies: [...anomalies] };
}

// --- incident_health (meta) ---------------------------------------------------------------------

function healthKey(incidentId: string, fingerprint: string): string {
  return `incident_health:${incidentId}:${fingerprint}`;
}

/** Builds (but does not execute) the `REPLACE INTO meta` statements that refresh the
 * `incident_health:*` row for every one of `fingerprints` to `nowMs` — called whenever a
 * fingerprint is observed anomalous again (both the opening batch and every later covered batch),
 * which is exactly what should reset `autoResolve`'s healthy-streak clock. Callers fold the result
 * into their own single `db.batch()` alongside the fingerprint-row writes (see the file doc
 * comment's "Atomicity" section) rather than issuing a separate round trip. */
function buildHealthTouchStatements(
  db: D1Database,
  incidentId: string,
  fingerprints: readonly string[],
  nowMs: number,
): D1PreparedStatement[] {
  return fingerprints.map((fp) =>
    db.prepare(`REPLACE INTO meta (key, value) VALUES (?, ?)`).bind(healthKey(incidentId, fp), String(nowMs)),
  );
}

/** Builds the single `DELETE` statement clearing every `incident_health:*` row for `incidentId`'s
 * `fingerprints` — called once an incident reaches a terminal status (`resolved`/`failed`), since
 * those rows can never be read again (`autoResolve` only ever looks at `open`/`reported`
 * incidents). Returns `[]` for an empty `fingerprints` (nothing to clear). */
function buildHealthClearStatements(db: D1Database, incidentId: string, fingerprints: readonly string[]): D1PreparedStatement[] {
  if (fingerprints.length === 0) return [];
  const keys = fingerprints.map((fp) => healthKey(incidentId, fp));
  const placeholders = keys.map(() => "?").join(", ");
  return [db.prepare(`DELETE FROM meta WHERE key IN (${placeholders})`).bind(...keys)];
}

// --- incident_fingerprints -----------------------------------------------------------------------

/** Builds (but does not execute) `INSERT OR IGNORE` statements, one per `(incident_id, fingerprint)`
 * PK (task brief) — a fingerprint already tracked keeps its original `first_seen_ms` and whatever
 * `delivered_to_agent` it already has; only a genuinely new fingerprint gets a fresh row with
 * `delivered_to_agent = 0`. See `buildHealthTouchStatements`'s doc comment for why this returns
 * statements rather than executing them directly. */
function buildFingerprintInsertStatements(
  db: D1Database,
  incidentId: string,
  fingerprints: readonly string[],
  nowMs: number,
): D1PreparedStatement[] {
  return fingerprints.map((fp) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent)
         VALUES (?, ?, ?, 0)`,
      )
      .bind(incidentId, fp, nowMs),
  );
}

// --- coverage ------------------------------------------------------------------------------------

interface CoveringRow {
  id: string;
  status: IncidentStatus;
  resolved_at: number | null;
}

function isCovering(row: CoveringRow, nowMs: number): boolean {
  if (row.status === "open" || row.status === "investigating" || row.status === "reported") return true;
  if (row.status === "failed") return row.resolved_at !== null && nowMs - row.resolved_at < REARM_MS;
  return false; // 'resolved' never suppresses
}

/**
 * Resolves, independently for each of `fingerprints`, which incident (if any) currently
 * `isCovering` it at `nowMs` — a `Map<fingerprint, incidentId>` with an entry only for fingerprints
 * that ARE covered. When a fingerprint has been tracked by more than one incident over its history
 * (e.g. an earlier incident resolved and a later one reopened on it), the most-recently-opened
 * covering match wins. This per-fingerprint resolution (not "any match anywhere in the batch") is
 * what keeps two unrelated already-open incidents from being merged — see the file doc comment.
 */
async function findOwnersByFingerprint(
  db: D1Database,
  fingerprints: readonly string[],
  nowMs: number,
): Promise<Map<string, string>> {
  if (fingerprints.length === 0) return new Map();
  const placeholders = fingerprints.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT DISTINCT f.fingerprint, i.id, i.status, i.resolved_at, i.opened_at
       FROM incident_fingerprints f
       JOIN incidents i ON i.id = f.incident_id
       WHERE f.fingerprint IN (${placeholders})
       ORDER BY i.opened_at DESC`,
    )
    .bind(...fingerprints)
    .all<CoveringRow & { fingerprint: string; opened_at: number }>();

  const owners = new Map<string, string>();
  for (const row of results ?? []) {
    if (owners.has(row.fingerprint)) continue; // keep the most-recently-opened covering match already found
    if (isCovering(row, nowMs)) owners.set(row.fingerprint, row.id);
  }
  return owners;
}

// --- openIncident ---------------------------------------------------------------------------------

export interface OpenIncidentResult {
  id: string;
  created: boolean;
}

function severityOf(anomalies: readonly Anomaly[]): "warning" | "critical" {
  const hasHardTrip = anomalies.some((a) => a.rule === "hard");
  const distinctServices = new Set(anomalies.map((a) => a.service)).size;
  return hasHardTrip || distinctServices >= 2 ? "critical" : "warning";
}

/**
 * Opens a new incident for `anomalies`, or returns the id of the existing incident that already
 * covers one of them (`created: false` — see the file doc comment's "Dedupe"/"Coverage" sections;
 * the caller is expected to `appendFingerprints` onto that id in that case, which independently
 * re-resolves per-fingerprint ownership rather than trusting this call's pick). When the batch's
 * fingerprints are covered by more than one distinct incident, the one covering whichever
 * fingerprint appears first in `anomalies` (deduplicated in array order) is returned,
 * deterministically — `evaluate()`'s output is already sorted by fingerprint, so for `sweep.ts`'s
 * real usage that means the alphabetically-first one; this function itself makes no ordering
 * assumption about its input. Throws on an empty `anomalies` array — every caller (`sweep.ts`) is
 * expected to skip calling this when `evaluate()` returned nothing, so an empty batch here signals
 * a caller bug, not a normal "nothing to do" outcome.
 */
export async function openIncident(db: D1Database, anomalies: readonly Anomaly[], nowMs: number): Promise<OpenIncidentResult> {
  if (anomalies.length === 0) {
    throw new Error("openIncident: anomalies must be non-empty");
  }
  const fingerprints = [...new Set(anomalies.map((a) => a.fingerprint))];

  const owners = await findOwnersByFingerprint(db, fingerprints, nowMs);
  for (const fp of fingerprints) {
    const owner = owners.get(fp);
    if (owner) return { id: owner, created: false };
  }

  const id = `inc-${crypto.randomUUID()}`;
  const severity = severityOf(anomalies);
  const trigger = buildTrigger(anomalies);

  await db.batch([
    db
      .prepare(`INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES (?, 'open', ?, ?, ?)`)
      .bind(id, severity, nowMs, JSON.stringify(trigger)),
    ...buildFingerprintInsertStatements(db, id, fingerprints, nowMs),
    ...buildHealthTouchStatements(db, id, fingerprints, nowMs),
  ]);

  return { id, created: true };
}

// --- appendFingerprints -----------------------------------------------------------------------

/**
 * Folds `anomalies` onto an already-open (or investigating/reported) incident `incidentId`: new
 * fingerprints get an `incident_fingerprints` row (`delivered_to_agent = 0`, so the investigator
 * picks them up as a "detector update"); every fingerprint actually folded in here has its
 * `trigger_json.anomalies` audit entry appended and its `incident_health:*` timestamp refreshed to
 * `nowMs`. Never touches `severity` (fixed at open — see the file doc comment).
 *
 * Re-resolves per-fingerprint ownership independently of whatever `openIncident` picked for the
 * same batch: any anomaly whose fingerprint is owned by a DIFFERENT incident than `incidentId` is
 * silently dropped from this call (not appended anywhere) rather than double-tracked onto the wrong
 * incident — see the file doc comment's "Coverage" section. This is a safe no-op for the vast
 * majority of calls (a batch covered by exactly one incident), and only actually filters anything
 * out in the rare cross-incident case.
 *
 * `nowMs` is not in the task brief's abbreviated signature, but `incident_fingerprints.first_seen_ms`
 * is `NOT NULL` and the health-tracking mechanism this file owns needs a timestamp too, so a caller
 * must supply one; `sweep.ts` always has `nowMs` in hand already.
 */
export async function appendFingerprints(
  db: D1Database,
  incidentId: string,
  anomalies: readonly Anomaly[],
  nowMs: number,
): Promise<void> {
  if (anomalies.length === 0) return;
  const allFingerprints = [...new Set(anomalies.map((a) => a.fingerprint))];
  const owners = await findOwnersByFingerprint(db, allFingerprints, nowMs);

  const toAppend = anomalies.filter((a) => {
    const owner = owners.get(a.fingerprint);
    return owner === undefined || owner === incidentId;
  });
  if (toAppend.length === 0) return;

  const fingerprints = [...new Set(toAppend.map((a) => a.fingerprint))];

  const row = await db.prepare(`SELECT trigger_json FROM incidents WHERE id = ?`).bind(incidentId).first<{ trigger_json: string }>();
  if (!row) return; // incident vanished underneath us (shouldn't happen) -- nothing left to append to
  const trigger = parseTrigger(row.trigger_json);
  trigger.anomalies.push(...toAppend);
  trigger.statements = trigger.anomalies.map((a) => a.statement);

  await db.batch([
    ...buildFingerprintInsertStatements(db, incidentId, fingerprints, nowMs),
    ...buildHealthTouchStatements(db, incidentId, fingerprints, nowMs),
    db.prepare(`UPDATE incidents SET trigger_json = ? WHERE id = ?`).bind(JSON.stringify(trigger), incidentId),
  ]);
}

// --- undeliveredUpdates / markDelivered -----------------------------------------------------------

/** One not-yet-delivered fingerprint plus the freshest statement recorded for it — pairs the two so
 * a caller can inject `statement` into the conversation and then `markDelivered` with exactly the
 * `fingerprint`s it just delivered, without a second query. */
export interface UndeliveredUpdate {
  fingerprint: string;
  statement: string;
}

/**
 * The updates the investigator hasn't yet been told about for `incidentId` — one per fingerprint
 * currently marked `delivered_to_agent = 0`, paired with that fingerprint's most recent
 * `trigger_json` anomaly statement (the freshest evidence), ordered by the fingerprint's own
 * `first_seen_ms`. Consumed by the investigator loop (Task 4.2, per spec §8: "checks for
 * undelivered fingerprints before each model call and injects them as a `detector update:` user
 * message") — not called by `sweep.ts` itself. Returns `[]` for an unknown incident id or one with
 * nothing undelivered.
 */
export async function undeliveredUpdates(db: D1Database, incidentId: string): Promise<UndeliveredUpdate[]> {
  const { results } = await db
    .prepare(
      `SELECT fingerprint FROM incident_fingerprints
       WHERE incident_id = ? AND delivered_to_agent = 0
       ORDER BY first_seen_ms ASC`,
    )
    .bind(incidentId)
    .all<{ fingerprint: string }>();
  const undeliveredFingerprints = (results ?? []).map((r) => r.fingerprint);
  if (undeliveredFingerprints.length === 0) return [];

  const row = await db.prepare(`SELECT trigger_json FROM incidents WHERE id = ?`).bind(incidentId).first<{ trigger_json: string }>();
  if (!row) return [];
  const trigger = parseTrigger(row.trigger_json);

  const latestStatementByFingerprint = new Map<string, string>();
  for (const anomaly of trigger.anomalies) {
    if (anomaly.fingerprint) latestStatementByFingerprint.set(anomaly.fingerprint, anomaly.statement);
  }

  const updates: UndeliveredUpdate[] = [];
  for (const fingerprint of undeliveredFingerprints) {
    const statement = latestStatementByFingerprint.get(fingerprint);
    if (statement !== undefined) updates.push({ fingerprint, statement });
  }
  return updates;
}

/** Marks `fingerprints` on `incidentId` as delivered (`delivered_to_agent = 1`) — called by the
 * investigator loop (Task 4.2) right after it injects `undeliveredUpdates`' result into the
 * conversation (typically `markDelivered(db, incidentId, updates.map(u => u.fingerprint))`).
 * Fingerprints not currently tracked on this incident are silently no-ops. */
export async function markDelivered(db: D1Database, incidentId: string, fingerprints: readonly string[]): Promise<void> {
  if (fingerprints.length === 0) return;
  const placeholders = fingerprints.map(() => "?").join(", ");
  await db
    .prepare(`UPDATE incident_fingerprints SET delivered_to_agent = 1 WHERE incident_id = ? AND fingerprint IN (${placeholders})`)
    .bind(incidentId, ...fingerprints)
    .run();
}

// --- setStatus --------------------------------------------------------------------------------

/** Which terminal-ish column to stamp alongside a status transition — `incidents` has no dedicated
 * `investigating_at`/`failed_at` column, so `resolved_at` doubles as the generic "this incident
 * stopped being active" timestamp for both `resolved` and `failed` (spec §7's data model defines
 * only `opened_at`/`reported_at`/`resolved_at`). */
export interface SetStatusOptions {
  ts?: { field: "reported_at" | "resolved_at"; value: number };
  /** JSON-stringified into `report_json` verbatim (overwriting, not merging — every caller today
   * only ever sets this on an `open`/`investigating` incident, which never has a prior
   * `report_json` to lose). Used by `forceFailStuck` and the chaos reset handler to record
   * `{failure_reason: "..."}`. */
  reportPatch?: Record<string, unknown>;
}

/** Generic status transition primitive — the investigator loop (Task 4.2) uses this directly for
 * `investigating`/`reported` too, so it stays a plain column setter rather than baking in
 * lifecycle-specific behavior (that lives in `openIncident`/`autoResolve`/`forceFailStuck`). */
export async function setStatus(db: D1Database, id: string, status: IncidentStatus, opts?: SetStatusOptions): Promise<void> {
  const sets: string[] = ["status = ?"];
  const params: unknown[] = [status];
  if (opts?.ts) {
    sets.push(`${opts.ts.field} = ?`);
    params.push(opts.ts.value);
  }
  if (opts?.reportPatch) {
    sets.push("report_json = ?");
    params.push(JSON.stringify(opts.reportPatch));
  }
  params.push(id);
  await db.prepare(`UPDATE incidents SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
}

// --- autoResolve ------------------------------------------------------------------------------

/** `Number(...)` a stored health timestamp, treating anything that isn't a finite number (missing
 * key, or a corrupt/non-numeric stored value) the same way: fail closed. A NaN health timestamp
 * must never look "healthy" just because `nowMs - NaN < HEALTHY_MS` happens to be `false` (i.e.
 * "not unhealthy") — that would auto-resolve an incident on unreadable data instead of blocking it. */
function isHealthy(rawValue: string | undefined, nowMs: number): boolean {
  if (rawValue === undefined) return false;
  const lastAnomalousMs = Number(rawValue);
  if (!Number.isFinite(lastAnomalousMs)) return false;
  return nowMs - lastAnomalousMs >= HEALTHY_MS;
}

async function allFingerprintsHealthy(db: D1Database, incidentId: string, fingerprints: readonly string[], nowMs: number): Promise<boolean> {
  const keys = fingerprints.map((fp) => healthKey(incidentId, fp));
  const placeholders = keys.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT key, value FROM meta WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const rawByKey = new Map((results ?? []).map((r) => [r.key, r.value]));

  return keys.every((key) => isHealthy(rawByKey.get(key), nowMs));
}

/**
 * Auto-resolves every `open`/`reported` incident whose *entire* fingerprint set has been healthy
 * (no anomalous sighting) for `HEALTHY_MS` (5 min) as of `nowMs` — spec §8: "applies to open and
 * reported only ... all fingerprints healthy 5 consecutive minutes". A single still-anomalous
 * fingerprint blocks resolution for the whole incident. `investigating` is deliberately excluded
 * (spec §8: "always runs to its report"). Clears the incident's `incident_health:*` meta rows once
 * resolved (see the file doc comment's health-tracking section).
 */
export async function autoResolve(db: D1Database, nowMs: number): Promise<void> {
  const { results } = await db.prepare(`SELECT id FROM incidents WHERE status IN ('open', 'reported')`).all<{ id: string }>();
  for (const { id } of results ?? []) {
    const { results: fpRows } = await db
      .prepare(`SELECT fingerprint FROM incident_fingerprints WHERE incident_id = ?`)
      .bind(id)
      .all<{ fingerprint: string }>();
    const fingerprints = (fpRows ?? []).map((r) => r.fingerprint);
    if (fingerprints.length === 0) continue; // no fingerprints tracked -- nothing to resolve against

    if (await allFingerprintsHealthy(db, id, fingerprints, nowMs)) {
      await setStatus(db, id, "resolved", { ts: { field: "resolved_at", value: nowMs } });
      await db.batch(buildHealthClearStatements(db, id, fingerprints));
    }
  }
}

// --- forceFailStuck ---------------------------------------------------------------------------

/**
 * Force-fails every `investigating` incident that has gone more than `STUCK_MS` (6 min) without a
 * new `investigation_steps` row — the stuck-investigation watchdog (spec §8: "recovery must not
 * depend on the thing that died"). An incident with zero steps yet uses `opened_at` as the
 * reference point (an investigation that never even wrote its first step is exactly as stuck as one
 * whose steps stopped). Sets `report_json.failure_reason` so the UI can explain why it ended
 * without a real report, and clears the incident's `incident_health:*` meta rows (a failed
 * incident is terminal — `autoResolve` never reads them again).
 */
export async function forceFailStuck(db: D1Database, nowMs: number): Promise<void> {
  const { results } = await db.prepare(`SELECT id, opened_at FROM incidents WHERE status = 'investigating'`).all<{
    id: string;
    opened_at: number;
  }>();
  for (const { id, opened_at } of results ?? []) {
    const stepRow = await db
      .prepare(`SELECT MAX(ts_ms) as last_ts FROM investigation_steps WHERE incident_id = ?`)
      .bind(id)
      .first<{ last_ts: number | null }>();
    const lastStepMs = stepRow?.last_ts ?? opened_at;
    if (nowMs - lastStepMs > STUCK_MS) {
      await setStatus(db, id, "failed", {
        ts: { field: "resolved_at", value: nowMs },
        reportPatch: { failure_reason: "stuck: no investigation step written in over 6 minutes" },
      });

      const { results: fpRows } = await db
        .prepare(`SELECT fingerprint FROM incident_fingerprints WHERE incident_id = ?`)
        .bind(id)
        .all<{ fingerprint: string }>();
      const fingerprints = (fpRows ?? []).map((r) => r.fingerprint);
      const clearStatements = buildHealthClearStatements(db, id, fingerprints);
      if (clearStatements.length > 0) await db.batch(clearStatements);
    }
  }
}
