/**
 * The public GET data-surface (spec §10): `/api/health` (moved here from `index.ts`, which now just
 * mounts this app), `/api/state`, `/api/analytics`, `/api/incidents`, `/api/incidents/:id`,
 * `/api/incidents/:id/metrics`, `/api/traces/:id`, `/api/logs`, `/api/deploys` — every GET endpoint
 * the UI polls or drills into. POST routes (chaos, admin reset, chat) stay in their own files
 * (`api/chaos.ts`, future `api/chat.ts`) since they're a fundamentally different shape (proxies /
 * SSE, not a query layer passthrough); this file is specifically the read side, mirroring
 * `telemetry/read.ts`'s own "reads only" boundary at the HTTP layer.
 *
 * Every handler here is a thin adapter, exactly like `agent/tools.ts`'s executors: parse/validate
 * query params, resolve the window via `parseWindow`, call the matching `telemetry/read.ts` /
 * `telemetry/state.ts` function, and return its result close to verbatim — caps, `truncated`/`total`
 * signals, and shape all live in the query layer, never re-implemented here. The one deliberate
 * exception is `/incidents/:id/metrics`: its tile shaping (window derivation from the incident's
 * lifecycle timestamps, defensive trigger parsing, per-service aggregation of `queryMetrics`'
 * per-operation points) is HTTP-presentation logic over the existing query seam, not a new query —
 * it lives here (see the "Incident metric tiles" section) rather than widening `read.ts`.
 */

import { Hono } from "hono";
import { getBaselines } from "../detect/baselines";
import type { Env } from "../env";
import { simulatorStub } from "../sim/simulator-do";
import { getIncidents, getTrace, listDeploys, listInvestigationSteps, queryMetrics, searchLogs, type StepView } from "../telemetry/read";
import { buildTopology, getAnalytics, getOpsHealth, serviceHealth, sparklineSeries, type StateResponse, type WorldStatusView } from "../telemetry/state";
import type { IncidentView, MetricPoint } from "../telemetry/types";
import { parseWindow, WindowError } from "../agent/window";

const LOG_LEVELS = ["info", "warn", "error"] as const;

/** `GET /api/incidents`' default lookback when no `from` is supplied — incidents are the UI's
 * durable history panel (spec §6: kept indefinitely, surviving resets), so its default window is
 * a day, not `parseWindow`'s generic 30-minute telemetry default. */
const INCIDENTS_DEFAULT_FROM = "-24h";

/** `GET /api/deploys`' default lookback when no `from` is supplied — the deploys rail exists to
 * correlate change events with incident onsets, so it defaults to the same day-long window as
 * `INCIDENTS_DEFAULT_FROM` (a deploy older than the incident panel's own horizon has nothing on
 * screen to correlate with), not `parseWindow`'s generic 30-minute telemetry default. */
const DEPLOYS_DEFAULT_FROM = "-24h";

/** `GET /api/incidents/:id`'s response shape (spec §10: "incident + steps") — exported alongside
 * `StateResponse` so Task 5.2's UI (which polls this at 2s during an investigation) types against
 * the same definition this handler builds. `steps` is ordered by `step_no` ascending — see
 * `read.ts`'s `listInvestigationSteps`. */
export interface IncidentDetailResponse {
  incident: IncidentView;
  steps: StepView[];
}

// --- Incident metric tiles (GET /api/incidents/:id/metrics) --------------------------------------

/** One evidence tile of `GET /api/incidents/:id/metrics`: the service-level timeseries for one
 * `(service, metricClass)` pair the incident's trigger flagged, pre-shaped for the UI's area
 * charts. `points[].value` is already in `unit`'s terms (`error_rate` is a 0–100 percent, never a
 * 0–1 fraction) and `baseline` has the same conversion applied, so points/peak/baseline all share
 * one axis without the UI re-deriving units. `ratio` is `peak / baseline`, or `null` when the
 * baseline is 0 (no meaningful multiple exists — mirrors `read.ts`'s `safeRatio` concern, but a
 * display tile wants "n/a", not `Infinity`). */
export interface IncidentMetricTile {
  service: string;
  metricClass: "req_rate" | "error_rate" | "p95";
  unit: "per_min" | "pct" | "ms";
  points: { minute_ts: number; value: number }[];
  peak: number;
  baseline: number;
  ratio: number | null;
}

/** `GET /api/incidents/:id/metrics`' full response — the evidence window is derived from the
 * incident's own lifecycle timestamps (see the route handler's window math) and returned
 * explicitly so the UI charts fixed bounds instead of inferring them from whatever points came
 * back (an empty tile still knows its x-axis). */
export interface IncidentMetricsResponse {
  windowFromMs: number;
  windowToMs: number;
  tiles: IncidentMetricTile[];
}

/** Pre-incident context: the window starts 30 min before `opened_at`, enough to chart the
 * baseline the anomaly broke away from. */
const INCIDENT_METRICS_PRE_MS = 30 * 60_000;

/** A still-unresolved incident's window extends at most 1h past `opened_at` — an open-ended
 * incident must not grow an unbounded chart query as it ages. */
const INCIDENT_METRICS_ACTIVE_CAP_MS = 60 * 60_000;

/** Recovery tail: 10 min past the incident's end (still clamped to `nowMs` — the future has no
 * rollups), so a resolved incident's chart shows the metric actually settling. */
const INCIDENT_METRICS_POST_MS = 10 * 60_000;

/** Tile cap: the trigger accumulates anomalies over a cascade's whole life (`incidents.ts`'s
 * `appendFingerprints` is append-only), but the UI renders at most 3 evidence tiles — the same
 * shape-aware-cap discipline as `read.ts`'s page caps, applied after dedupe so the 3 kept are 3
 * *distinct* (service, metricClass) stories. */
const MAX_INCIDENT_METRIC_TILES = 3;

type TileMetricClass = IncidentMetricTile["metricClass"];

/** Display unit per tile metric — `error_rate` tiles speak percent (the handler multiplies both
 * points and baseline by 100), the other two are already in display units. */
const TILE_UNITS: Record<TileMetricClass, IncidentMetricTile["unit"]> = {
  req_rate: "per_min",
  error_rate: "pct",
  p95: "ms",
};

/** Minimum pre-incident minutes in the window before the series' own median is trusted as the
 * tile baseline (below it, the trigger anomaly's per-operation baseline is the fallback — see the
 * handler's baseline comment). Three points is the least a median can call a trend. */
const TILE_BASELINE_MIN_PRE_POINTS = 3;

/** Plain odd/even median (same convention as `detect/baselines.ts`'s median — re-derived here
 * rather than imported because that module's version is un-exported and MAD-coupled). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (sorted.length % 2 === 0 && lower !== undefined && upper !== undefined) return (lower + upper) / 2;
  return upper ?? 0;
}

/** Accepted `metricClass` spellings on a trigger anomaly, normalized to the tiles' metric names.
 * `detect/rules.ts`'s `Anomaly` — what `incidents.ts` actually persists in `trigger_json` — uses
 * the incident-domain names (`errors`/`latency`/`traffic`), while the tiles speak the
 * `BaselineMetric` names the charts are denominated in; both spellings are accepted so real
 * incidents chart correctly and already-metric-named payloads pass through unchanged. Anything
 * else (e.g. `p50`, which has no tile) is dropped. */
const TILE_METRIC_ALIASES: Record<string, TileMetricClass> = {
  req_rate: "req_rate",
  error_rate: "error_rate",
  p95: "p95",
  traffic: "req_rate",
  errors: "error_rate",
  latency: "p95",
};

interface TileAnomaly {
  service: string;
  metricClass: TileMetricClass;
  baseline: number;
}

/** Defensively extracts the tile-able anomalies from an incident's parsed `trigger` (typed
 * `unknown` on `IncidentView`, and nothing here trusts its shape): the anomaly array is accepted
 * either bare or under `.anomalies` (the `{statements, anomalies}` payload `incidents.ts`
 * persists); entries survive only with a string `service`, a recognized `metricClass` (see
 * `TILE_METRIC_ALIASES`), and a numeric `baseline`; duplicates dedupe by `(service, metricClass)`
 * preserving first-seen order (the opening batch's lead anomaly stays the lead tile); and the
 * result caps at `MAX_INCIDENT_METRIC_TILES`. A malformed trigger of any shape yields `[]` — the
 * endpoint must degrade to 200 with empty tiles, never 500 over one odd row. */
function tileAnomalies(trigger: unknown): TileAnomaly[] {
  let entries: unknown[];
  if (Array.isArray(trigger)) {
    entries = trigger;
  } else if (
    trigger !== null &&
    typeof trigger === "object" &&
    Array.isArray((trigger as { anomalies?: unknown }).anomalies)
  ) {
    entries = (trigger as { anomalies: unknown[] }).anomalies;
  } else {
    return [];
  }

  const seen = new Set<string>();
  const out: TileAnomaly[] = [];
  for (const entry of entries) {
    if (out.length >= MAX_INCIDENT_METRIC_TILES) break;
    if (entry === null || typeof entry !== "object") continue;
    const { service, metricClass, baseline } = entry as { service?: unknown; metricClass?: unknown; baseline?: unknown };
    if (typeof service !== "string" || typeof baseline !== "number" || typeof metricClass !== "string") continue;
    const normalized = TILE_METRIC_ALIASES[metricClass];
    if (normalized === undefined) continue;
    // NUL-separated grouping key (the `read.ts`/`rules.ts` convention) -- can never collide with a
    // real service name.
    const key = `${service}\u0000${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ service, metricClass: normalized, baseline });
  }
  return out;
}

interface ServiceMinutePoint {
  minute_ts: number;
  count: number;
  error_rate: number;
  p95: number;
}

/** Folds `queryMetrics`' per-(service, operation) points into one service-level point per minute,
 * ascending by `minute_ts`: `count` sums; `error_rate` re-weights by count
 * (`sum(error_rate × count) / sum(count)` — recovering the error *count* each operation
 * contributed, exactly the weighting `queryMetrics`' own buckets use); `p95` is the same
 * count-weighted mean (an approximation across operations — the identical trade `state.ts`'s
 * `sparklineSeries` makes in SQL, since rollups don't retain raw durations). */
function aggregateToServiceMinutes(points: readonly MetricPoint[]): ServiceMinutePoint[] {
  const byMinute = new Map<number, { count: number; errorWeighted: number; p95Weighted: number }>();
  for (const point of points) {
    let acc = byMinute.get(point.minute_ts);
    if (!acc) {
      acc = { count: 0, errorWeighted: 0, p95Weighted: 0 };
      byMinute.set(point.minute_ts, acc);
    }
    acc.count += point.count;
    acc.errorWeighted += point.error_rate * point.count;
    acc.p95Weighted += point.p95 * point.count;
  }
  return [...byMinute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minute_ts, acc]) => ({
      minute_ts,
      count: acc.count,
      error_rate: acc.count === 0 ? 0 : acc.errorWeighted / acc.count,
      p95: acc.count === 0 ? 0 : acc.p95Weighted / acc.count,
    }));
}

/** Fetches `SimulatorDO`'s `/status` for the singleton `idFromName('world')` instance and returns
 * its body verbatim (`WorldStatusView`) — `null` on any failure (network error, non-2xx, malformed
 * JSON) so `GET /api/state` can fall back rather than 500ing the whole response over a DO hiccup. */
async function fetchWorldStatus(env: Env): Promise<WorldStatusView | null> {
  try {
    const res = await simulatorStub(env).fetch("http://simulator/status");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The one honest default for `GET /api/state` when `SimulatorDO` itself is unreachable — matches
 * `index.ts`'s pre-existing `/api/health` fallback ("unseeded") rather than inventing a new
 * failure-mode string, since both are "we couldn't learn the real world status" moments. */
const FALLBACK_WORLD_STATUS: WorldStatusView = { worldStatus: "unseeded", fault: null, generation: 0 };

export const routes = new Hono<{ Bindings: Env }>();

routes.get("/health", async (c) => {
  const status = await fetchWorldStatus(c.env);
  return c.json({ ok: true, worldStatus: status?.worldStatus ?? "unseeded" });
});

routes.get("/state", async (c) => {
  const nowMs = Date.now();

  const [baselines, world] = await Promise.all([getBaselines(c.env.DB), fetchWorldStatus(c.env)]);
  const [health, sparklines, opsHealth] = await Promise.all([
    serviceHealth(c.env.DB, baselines, nowMs),
    sparklineSeries(c.env.DB, nowMs),
    getOpsHealth(c.env.DB, nowMs),
  ]);

  const body: StateResponse = {
    topology: buildTopology(),
    health,
    sparklines,
    worldStatus: world ?? FALLBACK_WORLD_STATUS,
    opsHealth,
  };
  return c.json(body);
});

// The ops stat row (incident counts, time-to-report/resolve medians, latest-minute traffic) —
// everything lives in `state.ts`'s `getAnalytics`; this is the pure thin-adapter shape.
routes.get("/analytics", async (c) => c.json(await getAnalytics(c.env.DB, Date.now())));

routes.get("/incidents", async (c) => {
  const nowMs = Date.now();
  try {
    const { fromMs, toMs } = parseWindow(
      { from: c.req.query("from") ?? INCIDENTS_DEFAULT_FROM, to: c.req.query("to") },
      nowMs,
    );
    // getIncidents' window branch is already newest-first (spec §10: "recent first") and carries
    // the {incidents, total} envelope with its 20-row cap -- passed through verbatim.
    const result = await getIncidents(c.env.DB, { fromMs, toMs });
    return c.json(result);
  } catch (err) {
    if (err instanceof WindowError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// Registered BEFORE `/incidents/:id` deliberately: Hono resolves same-specificity param routes in
// registration order, so the more specific `/metrics` sub-path must never risk being swallowed by
// the detail route — the coexistence of both is pinned by a test in routes.test.ts.
routes.get("/incidents/:id/metrics", async (c) => {
  const nowMs = Date.now();
  const { incidents } = await getIncidents(c.env.DB, { id: c.req.param("id") });
  const incident = incidents[0];
  if (incident === undefined) {
    return c.json({ error: "not_found" }, 404);
  }

  // Evidence window: 30 min of pre-incident context, through the incident's end (`resolved_at`
  // when it has one, else capped at 1h past opening), plus a 10-min recovery tail — every
  // forward-looking bound clamped to `nowMs`, since the future has no rollups.
  const fromMs = incident.opened_at - INCIDENT_METRICS_PRE_MS;
  const rawEndMs = incident.resolved_at ?? Math.min(nowMs, incident.opened_at + INCIDENT_METRICS_ACTIVE_CAP_MS);
  const toMs = Math.min(nowMs, rawEndMs + INCIDENT_METRICS_POST_MS);

  // One `queryMetrics` fetch per *distinct* service — two tiles on one service (the common cascade
  // shape: errors + latency on the same culprit) share the aggregation instead of re-querying.
  const pointsByService = new Map<string, ServiceMinutePoint[]>();
  const tiles: IncidentMetricTile[] = [];
  for (const anomaly of tileAnomalies(incident.trigger)) {
    let servicePoints = pointsByService.get(anomaly.service);
    if (servicePoints === undefined) {
      servicePoints = aggregateToServiceMinutes(
        await queryMetrics(c.env.DB, { service: anomaly.service, fromMs, toMs, stepMin: 1 }),
      );
      pointsByService.set(anomaly.service, servicePoints);
    }

    // error_rate tiles speak percent — points AND baseline both ×100, so every number on the tile
    // shares one axis; req_rate/p95 are already in their display units.
    const points = servicePoints.map((p) => ({
      minute_ts: p.minute_ts,
      value:
        anomaly.metricClass === "req_rate" ? p.count : anomaly.metricClass === "error_rate" ? p.error_rate * 100 : p.p95,
    }));
    const peak = points.reduce((max, p) => Math.max(max, p.value), 0);

    // Baseline at the SAME aggregation level as the points: the median of the window's pre-open
    // service-level minutes (the 30-min context the window exists to provide). The trigger
    // anomaly's own `baseline` is per-(service, operation) — the detector's worst single
    // operation — so dividing a summed-service peak by it systematically misstates the "×N"
    // multiple on any multi-operation service (adversarial-review finding). The per-op number
    // remains the fallback when the window is too young to have meaningful pre-open context
    // (< TILE_BASELINE_MIN_PRE_POINTS minutes, e.g. right after a reset wiped rollups).
    const preOpenValues = points.filter((p) => p.minute_ts < incident.opened_at).map((p) => p.value);
    const anomalyBaseline = anomaly.metricClass === "error_rate" ? anomaly.baseline * 100 : anomaly.baseline;
    const baseline = preOpenValues.length >= TILE_BASELINE_MIN_PRE_POINTS ? median(preOpenValues) : anomalyBaseline;
    tiles.push({
      service: anomaly.service,
      metricClass: anomaly.metricClass,
      unit: TILE_UNITS[anomaly.metricClass],
      points,
      peak,
      baseline,
      ratio: baseline > 0 ? peak / baseline : null,
    });
  }

  const body: IncidentMetricsResponse = { windowFromMs: fromMs, windowToMs: toMs, tiles };
  return c.json(body);
});

routes.get("/incidents/:id", async (c) => {
  const id = c.req.param("id");
  const { incidents } = await getIncidents(c.env.DB, { id });
  const incident = incidents[0];
  if (incident === undefined) {
    return c.json({ error: "not_found" }, 404);
  }
  const steps = await listInvestigationSteps(c.env.DB, id);
  const body: IncidentDetailResponse = { incident, steps };
  return c.json(body);
});

routes.get("/traces/:id", async (c) => {
  const traceId = c.req.param("id");
  const trace = await getTrace(c.env.DB, traceId);
  // `getTrace` returns an empty, non-truncated view for an unknown trace_id (see read.ts) -- that's
  // the "no such trace" signal this route turns into a 404, distinct from a real (possibly
  // truncated) trace that simply has spans.
  if (trace.spans.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(trace);
});

routes.get("/logs", async (c) => {
  const nowMs = Date.now();
  const service = c.req.query("service");
  const levelRaw = c.req.query("level");
  if (levelRaw !== undefined && !(LOG_LEVELS as readonly string[]).includes(levelRaw)) {
    return c.json({ error: "invalid_level", allowed: LOG_LEVELS }, 400);
  }
  const level = levelRaw as (typeof LOG_LEVELS)[number] | undefined;
  const contains = c.req.query("contains");
  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;

  try {
    const { fromMs, toMs } = parseWindow({ from: c.req.query("from"), to: c.req.query("to") }, nowMs);
    const result = await searchLogs(c.env.DB, { service, level, contains, fromMs, toMs, limit });
    return c.json(result);
  } catch (err) {
    if (err instanceof WindowError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

routes.get("/deploys", async (c) => {
  const nowMs = Date.now();
  try {
    const { fromMs, toMs } = parseWindow(
      { from: c.req.query("from") ?? DEPLOYS_DEFAULT_FROM, to: c.req.query("to") },
      nowMs,
    );
    // `id` is stripped for the same reason the agent's list_deploys tool strips it: deploy ids
    // embed the originating scenario name (`deploy-traffic-spike-…` — idempotent-dedupe keys, see
    // sim/scenarios.ts), and shipping them to the browser would spoil the simulation honesty
    // boundary in devtools. The rail cites deploys as service@version, like the agent does.
    const deploys = (await listDeploys(c.env.DB, { fromMs, toMs })).map(({ id: _id, ...deploy }) => deploy);
    // listDeploys returns chronological ascending (a correlation timeline — the right order for
    // the agent's onset analysis, see read.ts). The deploys rail wants recent-first, so reverse
    // HERE, at the presentation seam, rather than changing the shared query function the agent's
    // list_deploys tool also consumes.
    deploys.reverse();
    return c.json({ deploys });
  } catch (err) {
    if (err instanceof WindowError) return c.json({ error: err.message }, 400);
    throw err;
  }
});
