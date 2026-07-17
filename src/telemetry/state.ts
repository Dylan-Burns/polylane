/**
 * Everything `/api/state` (spec §10) needs beyond a bare `SimulatorDO` proxy: the static topology
 * graph, per-service red/amber/green health, 30-min sparkline series per service, and the
 * ops-health panel (last sweep success, retention watermark age). Every export here is a pure
 * `(db, ...) => Promise<...>` read, matching `read.ts`'s own conventions (half-open windows, no
 * `Date.now()` — callers always pass an explicit `nowMs`) — `src/api/routes.ts`'s `GET /api/state`
 * handler is the only caller that also touches `SimulatorDO` (for `worldStatus`), which is why that
 * one field lives outside this module even though its TS shape (`StateResponse`) is documented here.
 * (`getAnalytics` — `GET /api/analytics`' ops stat row — lives here too: it isn't part of
 * `/api/state`'s payload, but it is the same kind of pure `(db, nowMs)` D1 read over the same
 * tables, and this module is where those already live.)
 *
 * **Health mapping** (spec §10, binding): **red** = the service appears in an
 * `open`/`investigating`/`reported` incident's fingerprints (`${service}:${metricClass}`, spec §8).
 * **amber** = either (a) the newest *rolled-up* minute (data-anchored via `latestRollupMinute`,
 * matching `sweep.ts`'s own detection anchor — see `serviceHealth`'s body comment) breaches a
 * sustained-rule threshold for some operation of the service without yet having triggered an
 * incident ("pre-incident" — reusing `detect/rules.ts`'s `breachesSustainedThreshold` so the same
 * thresholds back both the sweep and this endpoint), or (b) the service belongs to an incident
 * that resolved less than
 * `RECOVERING_WINDOW_MS` (5 min) ago ("recovering" — the task brief's own suggested reading of the
 * spec's "incident recovering" clause, chosen to match `incidents.ts`'s `autoResolve` healthy-streak
 * window so a just-resolved service reads as "still settling" for roughly as long as it took to
 * prove itself healthy in the first place). **red** always wins over either amber reason. **green**
 * otherwise — every service in `sim/topology.ts`'s `SERVICES` starts green and is only ever
 * upgraded to amber/red, never explicitly reset (a service with no incident and no breach is
 * exactly the "nothing to report" steady state).
 */

import type { BaselineMap } from "../detect/baselines";
import { breachesSustainedThreshold } from "../detect/rules";
import { LAST_SWEEP_OK_META_KEY } from "../detect/sweep";
import { MINUTE_MS } from "../sim/backfill";
import type { FaultState } from "../sim/scenarios";
import type { LiveMetrics, WorldStatus } from "../sim/simulator-do";
import { EXTERNAL_SERVICE, FLOWS, SERVICES, SERVICE_KIND, type ServiceKind, type Step } from "../sim/topology";
import { latestRollupMinute, queryMetrics } from "./read";
import { RETENTION_WATERMARK_META_KEY } from "./retention";

// --- Topology ----------------------------------------------------------------------------------

/** One node of the topology graph the UI renders — `external: true` marks `email-api` (spec
 * §6: emits no spans of its own, so it never appears in `health`/`sparklines`, only as an edge
 * target). Named `name` (not `service`) to match the task brief's exact shape,
 * `{name, ...}` alongside `edges`. `kind` is the Cloudflare product type behind the service
 * (`SERVICE_KIND`, `sim/topology.ts`) — threaded through so the UI can render a typed node card
 * without hand-duplicating the service->kind mapping. */
export interface TopologyServiceNode {
  name: string;
  kind: ServiceKind;
  external?: boolean;
}

export interface TopologyPayload {
  services: TopologyServiceNode[];
  /** `[from, to]` service-name pairs, deduped, alphabetically sorted for a byte-stable response —
   * see `buildTopology`'s doc comment for how these are derived. */
  edges: [string, string][];
}

/** Internal grouping-key separator for the edge-dedupe `Set` below, matching this codebase's own
 * NUL-separator convention (`read.ts`/`baselines.ts`/`rules.ts`) rather than a delimiter that could
 * collide with a real service name. */
const EDGE_KEY_SEP = "\u0000";

/** Walks every `FLOWS` entry's call tree and records one `(parent.service, child.service)` edge per
 * parent/child pair whose services actually differ — a step whose child shares its own service
 * (e.g. `notify.send_email` -> `notify.render_template`) is an intra-service call, not
 * a graph edge. Recursion covers every node regardless of whether an edge was recorded for it, so a
 * multi-level chain (edge-gateway -> checkout-edge -> payments-api -> ledger-db) is fully walked, not
 * just its first hop. */
function collectServiceEdges(): Set<string> {
  const edges = new Set<string>();
  function walk(step: Step): void {
    for (const child of step.children) {
      if (child.service !== step.service) {
        edges.add(`${step.service}${EDGE_KEY_SEP}${child.service}`);
      }
      walk(child);
    }
  }
  for (const flow of FLOWS) walk(flow.entry);
  return edges;
}

/**
 * The static service topology (spec §6's `edge-gateway -> checkout-edge -> payments-api ->
 * ledger-db` diagram, plus `checkout-edge -> notify -> email-api`), derived from `sim/topology.ts`'s
 * `FLOWS` call trees rather than hand-duplicated — a step added/removed there can never silently
 * drift out of sync with the UI's graph. `services` lists every internal service (`SERVICES`' own
 * declared order — a deliberate reading order: edge-gateway first, its two direct dependents
 * (checkout-edge, catalog-kv) next, then their own dependents) plus `email-api` last, flagged
 * `external`, each carrying its Cloudflare-product `kind` (`SERVICE_KIND`). `edges` are deduped and
 * sorted alphabetically (unlike `services`) purely for a byte-stable JSON response independent of
 * `FLOWS`' own walk order.
 */
export function buildTopology(): TopologyPayload {
  const edgeSet = collectServiceEdges();
  const edges: [string, string][] = [...edgeSet]
    .map((key): [string, string] => {
      const [from, to] = key.split(EDGE_KEY_SEP);
      return [from as string, to as string];
    })
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  // `SERVICE_KIND` is declared to cover all seven service names (`sim/topology.ts`'s doc comment),
  // so the lookup is infallible here even under `noUncheckedIndexedAccess`; the `!` documents that
  // invariant rather than papering over a real possibility of `undefined`.
  const services: TopologyServiceNode[] = [
    ...SERVICES.map((name): TopologyServiceNode => ({ name, kind: SERVICE_KIND[name]! })),
    { name: EXTERNAL_SERVICE, kind: SERVICE_KIND[EXTERNAL_SERVICE]!, external: true },
  ];

  return { services, edges };
}

// --- Health ------------------------------------------------------------------------------------

export type HealthStatus = "red" | "amber" | "green";

/** How long after `resolved_at` a service still reads "recovering" (amber) rather than plain green
 * — chosen to match `incidents.ts`'s `autoResolve` healthy-streak window (`HEALTHY_MS`), so a
 * service reads as "still settling" for roughly as long as it took to prove itself healthy before
 * auto-resolving. Documented per the task brief's own "your reasonable reading" allowance — spec
 * §10 specifies "recovering" without a precise window. */
const RECOVERING_WINDOW_MS = 5 * 60_000;

/** Extracts the service from a `${service}:${metricClass}` fingerprint (spec §8's fixed format —
 * `metricClass` is always `errors`/`latency`/`traffic`, never containing a colon itself, so the
 * *last* colon is always the metric-class separator even if a service name itself contained one,
 * which none in this topology do). */
function serviceFromFingerprint(fingerprint: string): string {
  const idx = fingerprint.lastIndexOf(":");
  return idx === -1 ? fingerprint : fingerprint.slice(0, idx);
}

interface FingerprintStatusRow {
  fingerprint: string;
  status: "open" | "investigating" | "reported" | "resolved" | "failed";
  resolved_at: number | null;
}

/**
 * Per-service red/amber/green health at `nowMs` (spec §10's binding mapping — see this module's
 * top doc comment for the exact red/amber precedence and the "recovering" window's rationale).
 * Every service in `sim/topology.ts`'s `SERVICES` gets an entry (defaulting green); a fingerprint
 * belonging to a service outside that list (shouldn't happen — spec §8 fingerprints are always
 * built from a real topology service name) still gets its own entry rather than being silently
 * dropped.
 *
 * Two D1 round trips: one query joining `incident_fingerprints` to `incidents` for every fingerprint
 * currently owned by an active (open/investigating/reported) OR recently-resolved incident (red and
 * amber-recovering share one query since both read the same join, distinguished by `status` per
 * row); one `queryMetrics` call over the single newest rolled-up minute (anchored via
 * `latestRollupMinute`, mirroring `sweep.ts`'s `runDetection`) to drive the amber pre-incident
 * check via `breachesSustainedThreshold`.
 */
export async function serviceHealth(
  db: D1Database,
  baselines: BaselineMap,
  nowMs: number,
): Promise<Record<string, HealthStatus>> {
  const health: Record<string, HealthStatus> = {};
  for (const service of SERVICES) health[service] = "green";

  const { results } = await db
    .prepare(
      `SELECT f.fingerprint AS fingerprint, i.status AS status, i.resolved_at AS resolved_at
       FROM incident_fingerprints f
       JOIN incidents i ON i.id = f.incident_id
       WHERE i.status IN ('open', 'investigating', 'reported')
          OR (i.status = 'resolved' AND i.resolved_at IS NOT NULL AND i.resolved_at >= ?)`,
    )
    .bind(nowMs - RECOVERING_WINDOW_MS)
    .all<FingerprintStatusRow>();

  const recoveringServices = new Set<string>();
  for (const row of results ?? []) {
    const service = serviceFromFingerprint(row.fingerprint);
    if (row.status === "resolved") {
      recoveringServices.add(service);
    } else {
      health[service] = "red";
    }
  }
  for (const service of recoveringServices) {
    if (health[service] !== "red") health[service] = "amber";
  }

  // Anchored on the newest minute PRESENT in rollups, not wall-clock arithmetic — the simulator's
  // tick writes a closed minute's rows up to ~20s after the boundary, so a wall-clock "last
  // completed minute" is empty whenever a poll lands early in the minute (in production: always,
  // making amber permanently blind). Same anchor as `sweep.ts`'s `runDetection`; no staleness
  // guard here because this is a display read — showing the last KNOWN minute's pre-incident
  // state matches what the sparklines (which also just render whatever data exists) already do.
  const latestMinute = await latestRollupMinute(db);
  if (latestMinute !== null) {
    const minute0 = await queryMetrics(db, {
      fromMs: latestMinute,
      toMs: latestMinute + MINUTE_MS,
      stepMin: 1,
    });
    for (const point of minute0) {
      if (health[point.service] === "red") continue;
      if (breachesSustainedThreshold(point, baselines)) {
        health[point.service] = "amber";
      }
    }
  }

  return health;
}

// --- Sparklines ----------------------------------------------------------------------------------

/** Sparkline series length (spec §10: "30-min sparkline series per service"). */
const SPARKLINE_WINDOW_MIN = 30;

export interface SparklinePoint {
  minute_ts: number;
  count: number;
  error_rate: number;
  p95: number;
}

interface SparklineRowDb {
  service: string;
  minute_ts: number;
  count: number;
  error_count: number;
  p95: number;
}

/**
 * The last `SPARKLINE_WINDOW_MIN` *completed* minutes of per-service traffic/error-rate/p95, one
 * point per (service, minute) that actually had a `rollups` row for at least one operation —
 * summed straight from `rollups` (spec: "sparklines must come from rollups, no raw span scans"),
 * never `queryMetrics` (which buckets by `(service, operation)`, one extra aggregation step short of
 * this endpoint's per-service granularity). `p95` is the same count-weighted average `queryMetrics`
 * uses when bucketing multiple rollup rows into one point (exact when a minute has only one
 * contributing operation, an approximation otherwise — re-deriving an exact percentile across
 * multiple operations' rollups isn't possible without the raw per-request durations).
 *
 * A service quiet for an entire minute (every operation had zero traffic) has no row for that
 * minute at all — `rollupFromStats` never emits a zero-traffic row (see `sim/generator.ts`) — so
 * gaps in a service's series are expected, not a bug; the UI is expected to treat a missing minute
 * as "no traffic", not interpolate it.
 */
export async function sparklineSeries(db: D1Database, nowMs: number): Promise<Record<string, SparklinePoint[]>> {
  const currentMinuteStart = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  const fromMs = currentMinuteStart - SPARKLINE_WINDOW_MIN * MINUTE_MS;
  const toMs = currentMinuteStart;

  const { results } = await db
    .prepare(
      `SELECT service, minute_ts,
              SUM(count) AS count,
              SUM(error_count) AS error_count,
              CASE WHEN SUM(count) = 0 THEN 0 ELSE SUM(p95_ms * count) * 1.0 / SUM(count) END AS p95
       FROM rollups
       WHERE minute_ts >= ? AND minute_ts < ?
       GROUP BY service, minute_ts
       ORDER BY service ASC, minute_ts ASC`,
    )
    .bind(fromMs, toMs)
    .all<SparklineRowDb>();

  const series: Record<string, SparklinePoint[]> = {};
  for (const row of results ?? []) {
    const points = series[row.service] ?? (series[row.service] = []);
    points.push({
      minute_ts: row.minute_ts,
      count: row.count,
      error_rate: row.count === 0 ? 0 : row.error_count / row.count,
      p95: row.p95,
    });
  }
  return series;
}

// --- Ops health ----------------------------------------------------------------------------------

export interface OpsHealth {
  /** Epoch ms of the most recent sweep tick that ran to completion (`detect/sweep.ts`'s
   * `LAST_SWEEP_OK_META_KEY`). Absent if the sweep has never once completed since this world's
   * `meta` table was last wiped (a brand-new world, or between reset and the first live tick). */
  lastSweepOkMs?: number;
  /** `nowMs` minus the `spans` table's retention watermark (`telemetry/retention.ts`'s
   * `RETENTION_WATERMARK_META_KEY`, the `spans` field of its `{spans, logs, rollups}` JSON value) —
   * see `getOpsHealth`'s doc comment for why `spans` specifically. Absent if retention has never
   * run (no watermark meta row at all yet). */
  retentionWatermarkAgeMs?: number;
}

interface RetentionWatermarksDb {
  spans?: number;
  logs?: number;
  rollups?: number;
}

/**
 * Reads the two `meta` keys the sweep/retention subtasks write and turns them into the ops-health
 * shape `/api/state` surfaces. `retentionWatermarkAgeMs` deliberately uses only the `spans`
 * watermark, not `logs`/`rollups` too: `spans`/`logs` share a 6h retention target and `rollups` a
 * 72h one, so a single combined number (e.g. the minimum of all three) would be dominated by
 * whichever table's target is largest — `rollups`' 72h cutoff, in this world, since a typical demo
 * run never accumulates 72h of rollups to actually delete, meaning its watermark keeps chasing (and
 * closely tracking) `nowMs - 72h` regardless of whether the sweep is actually healthy. `spans` is
 * the shortest-cycling of the three and the most direct evidence retention is alive: in a healthy
 * steady state this value hovers near `SPANS_LOGS_RETENTION_MS` (6h, `retention.ts`) because the
 * watermark advances roughly every tick; if the sweep stalls (or the retention subtask starts
 * failing every tick), the watermark stops moving while `nowMs` keeps advancing, and this number
 * grows well past 6h — a genuine staleness signal, not a constant.
 */
export async function getOpsHealth(db: D1Database, nowMs: number): Promise<OpsHealth> {
  const { results } = await db
    .prepare(`SELECT key, value FROM meta WHERE key IN (?, ?)`)
    .bind(LAST_SWEEP_OK_META_KEY, RETENTION_WATERMARK_META_KEY)
    .all<{ key: string; value: string }>();
  const byKey = new Map((results ?? []).map((row) => [row.key, row.value]));

  const opsHealth: OpsHealth = {};

  const lastSweepOkRaw = byKey.get(LAST_SWEEP_OK_META_KEY);
  if (lastSweepOkRaw !== undefined) {
    const parsed = Number(lastSweepOkRaw);
    if (Number.isFinite(parsed)) opsHealth.lastSweepOkMs = parsed;
  }

  const watermarkRaw = byKey.get(RETENTION_WATERMARK_META_KEY);
  if (watermarkRaw !== undefined) {
    try {
      const parsed = JSON.parse(watermarkRaw) as RetentionWatermarksDb;
      if (typeof parsed.spans === "number") {
        opsHealth.retentionWatermarkAgeMs = nowMs - parsed.spans;
      }
    } catch (err) {
      // Fail safe (matches retention.ts's own convention for this exact meta value): degrade to
      // "unknown" rather than throwing and taking the whole /api/state response down with it.
      console.error("state: retention_watermark_ms meta value is corrupt", err);
    }
  }

  return opsHealth;
}

// --- Analytics (GET /api/analytics: the UI's ops stat row) ---------------------------------------

/** One day in ms — `getAnalytics`'s `incidents24h` lookback, derived from `MINUTE_MS` so every
 * time constant in this module traces back to the same base unit. */
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The time-to-report/resolve medians' lookback (7 days): long enough that a quiet demo world
 * still has samples, short enough that the stat reflects the system as it currently behaves rather
 * than averaging over its whole history (incidents are kept indefinitely, spec §6). */
const ANALYTICS_MEDIAN_WINDOW_MS = 7 * DAY_MS;

/** Sample cap for the medians: the 100 *newest* qualifying incidents by `opened_at` — the same
 * shape-aware-cap discipline as `read.ts` (a busy week can accumulate unbounded incident rows),
 * and for a stat tile a median over the newest 100 is indistinguishable from one over all of them. */
const ANALYTICS_MEDIAN_SAMPLE_CAP = 100;

/** `GET /api/analytics`' response shape (the UI's ops stat row) — exported alongside
 * `StateResponse` so the route handler and the UI type against one definition. Every nullable
 * field is `null` exactly when its denominator doesn't exist (no reported/resolved incidents in
 * the window, empty `rollups`, a zero-traffic minute) so the UI renders an honest "—", never a
 * fabricated 0. */
export interface AnalyticsResponse {
  /** Incidents opened in the trailing 24h (`opened_at >= nowMs - 24h`), any status. */
  incidents24h: number;
  /** Incidents currently in a non-terminal status (`open`/`investigating`/`reported`), regardless
   * of age — "how many fires are burning right now", not a windowed count. */
  openNow: number;
  /** Median `reported_at - opened_at` over the newest `ANALYTICS_MEDIAN_SAMPLE_CAP` incidents
   * with a report inside the 7d window; `null` when none qualify. */
  timeToReportP50Ms: number | null;
  /** Median `resolved_at - opened_at`, same window/cap; `null` when none qualify. */
  timeToResolveP50Ms: number | null;
  /** Total request count across all services at the newest rolled-up minute (data-anchored via
   * `latestRollupMinute` — see `read.ts` for why wall-clock arithmetic is wrong here); `null`
   * when `rollups` is empty (fresh or mid-reset world). */
  reqPerMin: number | null;
  /** `100 * SUM(error_count) / SUM(count)` at that same minute — a percent, matching how the UI
   * displays it; `null` when `rollups` is empty or that minute's `SUM(count)` is 0 (no rate
   * exists to report). */
  errorRatePct: number | null;
}

/** Standard median (middle element for odd `n`, mean of the two middle elements for even — the
 * same convention as `detect/baselines.ts`'s own `median`), or `null` for an empty sample.
 * Computed in JS because SQLite has no median aggregate, and the qualifying rows are already
 * capped at `ANALYTICS_MEDIAN_SAMPLE_CAP` so the sort is trivially bounded. */
function medianOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The ops stat row `GET /api/analytics` serves (same conventions as `getOpsHealth`: pure
 * `(db, nowMs)` read, explicit `nowMs`, no `Date.now()`). The four incident statements go out as
 * one transactional `db.batch` round trip; the traffic pair takes two more (`latestRollupMinute`
 * to find the anchor minute, then one `SUM` over exactly that minute) because the anchor has to be
 * known before it can be bound. The median samples pull raw per-incident durations (newest first,
 * capped) rather than trying to rank in SQL — see `medianOrNull`.
 */
export async function getAnalytics(db: D1Database, nowMs: number): Promise<AnalyticsResponse> {
  const [count24hRes, openNowRes, reportRes, resolveRes] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE opened_at >= ?`).bind(nowMs - DAY_MS),
    db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE status IN ('open', 'investigating', 'reported')`),
    db
      .prepare(
        `SELECT reported_at - opened_at AS delta_ms FROM incidents
         WHERE reported_at IS NOT NULL AND opened_at >= ? ORDER BY opened_at DESC LIMIT ?`,
      )
      .bind(nowMs - ANALYTICS_MEDIAN_WINDOW_MS, ANALYTICS_MEDIAN_SAMPLE_CAP),
    db
      .prepare(
        `SELECT resolved_at - opened_at AS delta_ms FROM incidents
         WHERE resolved_at IS NOT NULL AND opened_at >= ? ORDER BY opened_at DESC LIMIT ?`,
      )
      .bind(nowMs - ANALYTICS_MEDIAN_WINDOW_MS, ANALYTICS_MEDIAN_SAMPLE_CAP),
  ]);

  const count24hRow = count24hRes?.results?.[0] as { n: number } | undefined;
  const openNowRow = openNowRes?.results?.[0] as { n: number } | undefined;
  const reportDeltas = ((reportRes?.results ?? []) as { delta_ms: number }[]).map((r) => r.delta_ms);
  const resolveDeltas = ((resolveRes?.results ?? []) as { delta_ms: number }[]).map((r) => r.delta_ms);

  let reqPerMin: number | null = null;
  let errorRatePct: number | null = null;
  const latestMinute = await latestRollupMinute(db);
  if (latestMinute !== null) {
    const traffic = await db
      .prepare(`SELECT SUM(count) AS total, SUM(error_count) AS errors FROM rollups WHERE minute_ts = ?`)
      .bind(latestMinute)
      .first<{ total: number | null; errors: number | null }>();
    const total = traffic?.total ?? 0;
    reqPerMin = total;
    errorRatePct = total > 0 ? (100 * (traffic?.errors ?? 0)) / total : null;
  }

  return {
    incidents24h: count24hRow?.n ?? 0,
    openNow: openNowRow?.n ?? 0,
    timeToReportP50Ms: medianOrNull(reportDeltas),
    timeToResolveP50Ms: medianOrNull(resolveDeltas),
    reqPerMin,
    errorRatePct,
  };
}

// --- StateResponse (documented, JSON-stable shape for /api/state; spec §10) ---------------------

/** `SimulatorDO`'s `/status` body, passed through verbatim (`sim/simulator-do.ts`'s
 * `handleStatus`) — the task brief's own naming: `/api/state`'s `worldStatus` field carries the
 * *entire* status object (including `fault`/`seedProgress`), not just the `worldStatus` enum
 * string; `worldStatus.worldStatus` is that enum. Built in `src/api/routes.ts` (the only place with
 * both a `SimulatorDO` binding and D1 access), not this module — everything else here is a pure D1
 * read with no Durable Object fetch, matching `read.ts`'s own "no I/O beyond D1" discipline. */
export interface WorldStatusView {
  worldStatus: WorldStatus;
  fault: FaultState;
  generation: number;
  seedProgress?: number;
  /** Table 7's near-real-time point: a per-service aggregate of the still-open minute, absent
   * whenever the world isn't running or that minute has no traffic yet (`SimulatorDO`'s
   * `buildLiveMetrics`). Passed through verbatim here (like every other field on this view) and
   * also surfaced at the top level as `StateResponse.live` — see `src/api/routes.ts`'s `/state`
   * handler. */
  live?: LiveMetrics;
}

/** The full `GET /api/state` response shape (spec §10) — exported so `src/api/routes.ts`'s handler
 * and Task 5.2's UI both type against one definition instead of an inline object literal drifting
 * out of sync with what's actually sent. */
export interface StateResponse {
  topology: TopologyPayload;
  health: Record<string, HealthStatus>;
  sparklines: Record<string, SparklinePoint[]>;
  worldStatus: WorldStatusView;
  opsHealth: OpsHealth;
  /** Table 7: mirrors `worldStatus.live` at the top level (the shape the UI's sparkline actually
   * reads) — omitted (`undefined`, dropped by `JSON.stringify`) under the same conditions as
   * `WorldStatusView.live`. */
  live?: LiveMetrics;
}
