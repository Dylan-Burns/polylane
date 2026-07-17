/**
 * Read half of the telemetry query layer (`queries.ts` stays insert-only). Every export here is a
 * pure read: `(db, args) => Promise<...>`, no writes, no `Date.now()` — callers (agent tools,
 * detector, API routes) always pass explicit `fromMs`/`toMs` windows. This is the *only* seam the
 * investigator agent sees into the telemetry store (spec §9's honesty boundary): swap this module
 * for a real backend connector and the agent is unchanged.
 *
 * Shared conventions across every function below:
 *  - Time windows are half-open `[fromMs, toMs)`, matching `generateWindow`'s own convention.
 *  - Row/span caps are *shape-aware*, never byte-sliced: every capped result says so
 *    (`truncated: true` on `getTrace`; a `total` match count alongside `searchLogs`/`findTraces`/
 *    `getIncidents` pages so `total > page.length` is an exact truncation signal) rather than
 *    silently dropping data the caller can't tell is missing (spec §9's "Result caps are
 *    shape-aware, never byte-sliced").
 *  - "Newest first" (descending by the row's own timestamp) is the default sort for
 *    investigation-facing lookups (`findTraces`, `searchLogs`, `getIncidents` by window) since the
 *    agent/UI usually wants the most recent evidence first; `listDeploys` sorts chronologically
 *    ascending instead, since deploys read naturally as a timeline when correlating with a
 *    regression onset.
 */

import type {
  BaselineMetric,
  IncidentView,
  LogLine,
  MetricPoint,
  PublicDeploy,
  RollupRow,
  Span,
  TraceSummary,
  TraceView,
} from "./types";

// --- Small shared helpers ------------------------------------------------------------------

/** Clamps `n` into `[min, max]`, flooring to an integer. Used for every caller-supplied `limit`.
 * A `NaN` `n` (e.g. a caller passing `limit: NaN` explicitly, which bypasses a `?? default`
 * fallback since `NaN` isn't nullish) falls back to `max` rather than propagating — every current
 * call site's default limit is also its `max`, so this is exactly "fall back to the default". */
function clampInt(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return max;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Escapes SQLite `LIKE` wildcards (`%`, `_`) and the escape character itself in a raw search
 * string, so `contains` is a literal substring match rather than a wildcard pattern. SQLite's
 * `LIKE` is already case-insensitive for ASCII by default, so no `lower()` wrapping is needed. */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `value / median`, never `NaN`/division-by-zero: a zero baseline with a still-zero observed
 * value is "no deviation" (0); a zero baseline with any nonzero observed value is an unbounded
 * spike, represented as `Infinity` (still a valid, comparable `number` for threshold rules). */
function safeRatio(value: number, median: number): number {
  if (median === 0) return value === 0 ? 0 : Infinity;
  return value / median;
}

interface LogRowDb {
  ts_ms: number;
  service: string;
  level: "info" | "warn" | "error";
  message: string;
  trace_id: string | null;
  span_id: string | null;
}

function rowToLogLine(row: LogRowDb): LogLine {
  return {
    ts_ms: row.ts_ms,
    service: row.service,
    level: row.level,
    message: row.message,
    trace_id: row.trace_id ?? undefined,
    span_id: row.span_id ?? undefined,
  };
}

// --- queryMetrics ----------------------------------------------------------------------------

export interface QueryMetricsArgs {
  service?: string;
  operation?: string;
  fromMs: number;
  toMs: number;
  stepMin: number;
}

/** Shape-aware page cap for `query_metrics` (points across the whole returned timeseries).
 * Enforced by the tool layer (`agent/tools.ts`), not here: `queryMetrics` already has to build
 * every bucketed point to answer the request (there's no row-level SQL `LIMIT` that means
 * anything once rollup rows have been bucketed into per-service/operation/minute points), so the
 * cap is a flat "take the first N of what came back" rule applied after this function returns,
 * exactly like `MAX_TRACE_SPANS` is enforced after the span rows are fetched. Exported here anyway
 * so the tool layer's cap-mentioning schema description reads from the same constant instead of a
 * copy that could go stale — the same reason as `SEARCH_LOGS_MAX_LIMIT`. */
export const MAX_METRIC_POINTS = 120;

interface BaselineRowDb {
  service: string;
  operation: string;
  metric: BaselineMetric;
  median: number;
  mad: number;
}

/** Reads the value a given baseline `metric` class compares against on a `MetricPoint`. */
function metricValueFor(point: Pick<MetricPoint, "count" | "error_rate" | "p95" | "p50">, metric: BaselineMetric): number {
  switch (metric) {
    case "req_rate":
      return point.count;
    case "error_rate":
      return point.error_rate;
    case "p95":
      return point.p95;
    case "p50":
      return point.p50;
  }
}

/**
 * The newest `minute_ts` present in `rollups`, or `null` when the table is empty (fresh or
 * mid-reset world). This is THE anchor for every "most recent completed minute" consumer
 * (`detect/sweep.ts`'s detection window, `telemetry/state.ts`'s amber pre-incident mapping):
 * SimulatorDO's 20s-cadence tick writes a closed minute's rollups up to ~20s AFTER the minute
 * boundary, while the cron fires at an arbitrary offset within the minute (observed :03–:08), so
 * wall-clock arithmetic (`floor(now/60s)−1`) routinely selects a minute whose rows haven't landed
 * yet — an empty result, every single tick. Anchoring on the data itself is the only lag-proof
 * choice; staleness policy (how old is too old to act on) stays with each consumer.
 */
export async function latestRollupMinute(db: D1Database): Promise<number | null> {
  const row = await db.prepare(`SELECT max(minute_ts) AS max_ts FROM rollups`).first<{ max_ts: number | null }>();
  return row?.max_ts ?? null;
}

/**
 * Timeseries of `rollups`, optionally filtered by `service`/`operation`, bucketed into
 * `stepMin`-minute windows and overlaid with the `baselines` table (median/MAD + a delta ratio
 * per metric class, attached only where a baseline row actually exists — see `MetricPoint`).
 *
 * Bucketing is epoch-aligned (`floor(minute_ts / stepMs) * stepMs`), not aligned to `fromMs` — a
 * standard downsampling convention that keeps bucket boundaries stable across queries with
 * different windows over the same data. Within a bucket, `count`/`error_count` sum (both are
 * already full-traffic counts per spec §6) and `p50`/`p95`/`p99` are count-weighted averages of
 * the contributing rollup rows' percentiles — rollups don't retain raw durations, so re-deriving
 * an exact percentile across minutes isn't possible; a weighted average is the standard
 * approximation and is exact when `stepMin` is 1 (one rollup row per point, no averaging).
 */
export async function queryMetrics(db: D1Database, args: QueryMetricsArgs): Promise<MetricPoint[]> {
  // A `NaN` `stepMin` (e.g. an explicit `step: NaN`, which bypasses a `?? 1` fallback since `NaN`
  // isn't nullish) falls back to the default of 1 rather than propagating — `Math.max(1, NaN)` is
  // itself `NaN`, so this needs its own guard, the same treatment `clampInt` gives `limit`.
  const stepMin = Number.isNaN(args.stepMin) ? 1 : Math.max(1, Math.floor(args.stepMin));
  const stepMs = stepMin * 60_000;

  const conditions: string[] = ["minute_ts >= ?", "minute_ts < ?"];
  const params: unknown[] = [args.fromMs, args.toMs];
  if (args.service !== undefined) {
    conditions.push("service = ?");
    params.push(args.service);
  }
  if (args.operation !== undefined) {
    conditions.push("operation = ?");
    params.push(args.operation);
  }

  const rollupSql = `SELECT service, operation, minute_ts, count, error_count, p50_ms, p95_ms, p99_ms FROM rollups WHERE ${conditions.join(" AND ")}`;
  const { results: rollupRows } = await db
    .prepare(rollupSql)
    .bind(...params)
    .all<RollupRow>();

  interface Bucket {
    service: string;
    operation: string;
    bucketTs: number;
    count: number;
    errorCount: number;
    p50Weighted: number;
    p95Weighted: number;
    p99Weighted: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const row of rollupRows ?? []) {
    const bucketTs = Math.floor(row.minute_ts / stepMs) * stepMs;
    const key = `${row.service}\u0000${row.operation}\u0000${bucketTs}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        service: row.service,
        operation: row.operation,
        bucketTs,
        count: 0,
        errorCount: 0,
        p50Weighted: 0,
        p95Weighted: 0,
        p99Weighted: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.count += row.count;
    bucket.errorCount += row.error_count;
    bucket.p50Weighted += row.p50_ms * row.count;
    bucket.p95Weighted += row.p95_ms * row.count;
    bucket.p99Weighted += row.p99_ms * row.count;
  }

  const points: MetricPoint[] = [...buckets.values()]
    .sort(
      (a, b) =>
        a.service.localeCompare(b.service) || a.operation.localeCompare(b.operation) || a.bucketTs - b.bucketTs,
    )
    .map((bucket) => ({
      service: bucket.service,
      operation: bucket.operation,
      minute_ts: bucket.bucketTs,
      count: bucket.count,
      error_rate: bucket.count === 0 ? 0 : bucket.errorCount / bucket.count,
      p50: bucket.count === 0 ? 0 : bucket.p50Weighted / bucket.count,
      p95: bucket.count === 0 ? 0 : bucket.p95Weighted / bucket.count,
      p99: bucket.count === 0 ? 0 : bucket.p99Weighted / bucket.count,
    }));

  if (points.length === 0) return points;

  // Baselines are entity-level (not per-minute), so fetch them with the same service/operation
  // filters (dropping the minute_ts condition) and attach the same map to every matching point.
  const baselineConditions: string[] = [];
  const baselineParams: unknown[] = [];
  if (args.service !== undefined) {
    baselineConditions.push("service = ?");
    baselineParams.push(args.service);
  }
  if (args.operation !== undefined) {
    baselineConditions.push("operation = ?");
    baselineParams.push(args.operation);
  }
  const baselineSql = `SELECT service, operation, metric, median, mad FROM baselines${
    baselineConditions.length > 0 ? ` WHERE ${baselineConditions.join(" AND ")}` : ""
  }`;
  const { results: baselineRows } = await db
    .prepare(baselineSql)
    .bind(...baselineParams)
    .all<BaselineRowDb>();

  const baselineMap = new Map<string, Partial<Record<BaselineMetric, { median: number; mad: number }>>>();
  for (const row of baselineRows ?? []) {
    const key = `${row.service}\u0000${row.operation}`;
    let entry = baselineMap.get(key);
    if (!entry) {
      entry = {};
      baselineMap.set(key, entry);
    }
    entry[row.metric] = { median: row.median, mad: row.mad };
  }

  for (const point of points) {
    const baseline = baselineMap.get(`${point.service}\u0000${point.operation}`);
    if (!baseline || Object.keys(baseline).length === 0) continue;
    point.baseline = baseline;
    const delta: Partial<Record<BaselineMetric, number>> = {};
    for (const metric of Object.keys(baseline) as BaselineMetric[]) {
      const b = baseline[metric];
      if (!b) continue;
      delta[metric] = safeRatio(metricValueFor(point, metric), b.median);
    }
    point.delta = delta;
  }

  return points;
}

// --- searchLogs -----------------------------------------------------------------------------

export interface SearchLogsArgs {
  service?: string;
  level?: "info" | "warn" | "error";
  contains?: string;
  fromMs: number;
  toMs: number;
  limit?: number;
}

/** Row cap for `searchLogs` (spec §9's tool table: "limit ≤ 50"). Exported so the tool layer
 * (`agent/tools.ts`) can build its cap-mentioning schema descriptions from the same constant
 * instead of a copy that could go stale. */
export const SEARCH_LOGS_MAX_LIMIT = 50;

export interface SearchLogsResult {
  /** The returned page: at most `limit` (clamped) rows, newest first. */
  logs: LogLine[];
  /** Total rows matching the same filters, ignoring `limit` — `total > logs.length` is the
   * honest "this page is truncated" signal (a bare capped array can't distinguish "exactly N"
   * from "capped at N"). */
  total: number;
}

/** Log lines within `[fromMs, toMs)`, optionally filtered by service/level/substring, newest
 * first, plus the `total` match count (a `COUNT(*)` over the same `WHERE`, batched alongside the
 * page query in a single D1 round trip). `limit` is clamped to `[1, 50]`, defaulting to 50 when
 * omitted, and caps `logs` only — never `total`. */
export async function searchLogs(db: D1Database, args: SearchLogsArgs): Promise<SearchLogsResult> {
  const limit = clampInt(args.limit ?? SEARCH_LOGS_MAX_LIMIT, 1, SEARCH_LOGS_MAX_LIMIT);

  const conditions: string[] = ["ts_ms >= ?", "ts_ms < ?"];
  const params: unknown[] = [args.fromMs, args.toMs];
  if (args.service !== undefined) {
    conditions.push("service = ?");
    params.push(args.service);
  }
  if (args.level !== undefined) {
    conditions.push("level = ?");
    params.push(args.level);
  }
  if (args.contains !== undefined && args.contains.length > 0) {
    conditions.push("message LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLikePattern(args.contains)}%`);
  }
  const where = conditions.join(" AND ");

  const [pageRes, countRes] = await db.batch([
    db
      .prepare(
        `SELECT ts_ms, service, level, message, trace_id, span_id FROM logs WHERE ${where} ORDER BY ts_ms DESC LIMIT ?`,
      )
      .bind(...params, limit),
    db.prepare(`SELECT COUNT(*) AS total FROM logs WHERE ${where}`).bind(...params),
  ]);

  const logs = ((pageRes?.results ?? []) as LogRowDb[]).map(rowToLogLine);
  const totalRow = countRes?.results?.[0] as { total: number } | undefined;
  return { logs, total: totalRow?.total ?? logs.length };
}

// --- findTraces -----------------------------------------------------------------------------

export interface FindTracesArgs {
  service?: string;
  fromMs: number;
  toMs: number;
  criteria: "errors" | "slowest";
  limit?: number;
}

/** Row cap for `findTraces` (spec §9's tool table: "limit ≤ 10"). Exported for the same
 * stale-copy-prevention reason as `SEARCH_LOGS_MAX_LIMIT`. */
export const FIND_TRACES_MAX_LIMIT = 10;

interface TraceRootRowDb {
  trace_id: string;
  service: string;
  operation: string;
  start_ms: number;
  duration_ms: number;
  status: "ok" | "error";
}

export interface FindTracesResult {
  /** The returned page: at most `limit` (clamped) trace summaries. */
  traces: TraceSummary[];
  /** Total traces matching the same filters, ignoring `limit` — see `SearchLogsResult.total`. */
  total: number;
}

/**
 * Summaries of persisted traces whose *entry* (root, `parent_span_id IS NULL`) span starts within
 * `[fromMs, toMs)`, optionally filtered to a `service` (matched against the entry span, not any
 * span in the tree — "traces entering through this service"), plus the `total` match count (a
 * `COUNT(*)` over the same `WHERE`, batched alongside the page query). `duration_ms` on each
 * summary is the root span's own duration (see `TraceSummary`), and `limit` clamps to `[1, 10]`,
 * capping `traces` only — never `total`.
 *
 *  - `criteria: 'errors'` — traces containing at least one span with `status = 'error'` *anywhere*
 *    in the tree (matching `sampleForPersistence`'s own notion of an "error trace" — the root may
 *    stay `ok` if the only error is on a fire-and-forget async branch), sorted newest first.
 *  - `criteria: 'slowest'` — all matching traces sorted by root duration descending (ties broken
 *    newest first).
 *
 * `span_count` is a second, small batched query (`trace_id IN (...)` over just the returned
 * traces) rather than a `JOIN`/subquery on the main query, so the (at most 10) root-span rows
 * stay the driver of ordering/limiting and the count fetch can't distort either.
 */
export async function findTraces(db: D1Database, args: FindTracesArgs): Promise<FindTracesResult> {
  const limit = clampInt(args.limit ?? FIND_TRACES_MAX_LIMIT, 1, FIND_TRACES_MAX_LIMIT);

  const conditions: string[] = ["parent_span_id IS NULL", "start_ms >= ?", "start_ms < ?"];
  const params: unknown[] = [args.fromMs, args.toMs];
  if (args.service !== undefined) {
    conditions.push("service = ?");
    params.push(args.service);
  }
  if (args.criteria === "errors") {
    conditions.push("trace_id IN (SELECT trace_id FROM spans WHERE status = 'error')");
  }
  const where = conditions.join(" AND ");

  const orderBy = args.criteria === "errors" ? "start_ms DESC" : "duration_ms DESC, start_ms DESC";
  const [pageRes, countRes] = await db.batch([
    db
      .prepare(
        `SELECT trace_id, service, operation, start_ms, duration_ms, status FROM spans WHERE ${where} ORDER BY ${orderBy} LIMIT ?`,
      )
      .bind(...params, limit),
    db.prepare(`SELECT COUNT(*) AS total FROM spans WHERE ${where}`).bind(...params),
  ]);
  const roots = (pageRes?.results ?? []) as TraceRootRowDb[];
  const totalRow = countRes?.results?.[0] as { total: number } | undefined;
  const total = totalRow?.total ?? roots.length;
  if (roots.length === 0) return { traces: [], total };

  const traceIds = roots.map((r) => r.trace_id);
  const placeholders = traceIds.map(() => "?").join(", ");
  const { results: countRows } = await db
    .prepare(`SELECT trace_id, COUNT(*) as span_count FROM spans WHERE trace_id IN (${placeholders}) GROUP BY trace_id`)
    .bind(...traceIds)
    .all<{ trace_id: string; span_count: number }>();
  const spanCountByTrace = new Map((countRows ?? []).map((r) => [r.trace_id, r.span_count]));

  const traces = roots.map((row) => ({
    trace_id: row.trace_id,
    entry_service: row.service,
    entry_operation: row.operation,
    start_ms: row.start_ms,
    duration_ms: row.duration_ms,
    status: row.status,
    span_count: spanCountByTrace.get(row.trace_id) ?? 1,
  }));
  return { traces, total };
}

// --- getTrace ---------------------------------------------------------------------------------

/** Shape-aware span cap (spec §9's `get_trace`: "≤ 40 spans"). Exported for the same
 * stale-copy-prevention reason as `SEARCH_LOGS_MAX_LIMIT`. */
export const MAX_TRACE_SPANS = 40;

/** Prefix marking a synthesized "collapsed" marker span so the defensive fallback trim (below)
 * can recognize and never drop/re-collapse one. Never collides with a real `span_id` (`randomHex`
 * in `generator.ts` only ever emits bare hex). */
const COLLAPSED_SPAN_ID_PREFIX = "collapsed:";

function isCollapsedMarker(span: Span): boolean {
  return span.span_id.startsWith(COLLAPSED_SPAN_ID_PREFIX);
}

/**
 * Collapses `spans` (already known to exceed `MAX_TRACE_SPANS`) down to the cap — a *hard*, honest
 * cap in the common case: every path below either gets the result to `MAX_TRACE_SPANS` or hits the
 * one documented exception (below), not a silent "close enough". One residual is NOT covered by
 * that exception, and is a doc-only caveat rather than something this function fixes: a
 * leaf-collapse marker (step 1) parented directly on a `mustKeep` span is permanent once created —
 * neither leaf-trim (step 2) nor subtree-drop (step 3) will ever remove a marker (both explicitly
 * exclude `isCollapsedMarker` spans; see their own doc comments) — so a trace whose must-keep
 * spans fan out into many distinct `(parent, service, operation)` groups, each producing its own
 * marker, can still land over `MAX_TRACE_SPANS` even though `mustKeep.size` alone stays comfortably
 * under it. Pathological marker saturation like that has no cap-enforcement lever left; it is
 * flagged here rather than silently ignored.
 *
 * Domain caveat this must NOT "fix": async spans (the notify fire-and-forget subtree, per
 * `generator.ts`'s `ASYNC_STEP_KEYS` branch) may legitimately end *after* their parent ends — the
 * parent doesn't wait for them. Nothing below assumes end_ms <= parent's end_ms, orders siblings
 * by wall-clock overlap, or otherwise treats that as malformed; span identity is entirely
 * `parent_span_id`-driven, never inferred from timing.
 *
 * Cap semantics, in order — each step only runs if the previous one left the result over the cap:
 *  1. **Leaf-collapse**: group ok *leaf* spans (spans with children are never grouped — collapsing
 *     one would orphan its descendants) by `(parent_span_id, service, operation)`; groups of >=2
 *     become one synthetic "…N similar ok spans" marker.
 *  2. **Leaf-trim**: a defensive fallback, only reachable when step 1 alone doesn't reach the cap
 *     (e.g. many *distinct* ok leaves with no repeats to collapse): drop the earliest-starting
 *     non-must-keep, non-marker *leaf* spans (same orphan-avoidance rule) until at the cap.
 *  3. **Subtree-drop**: reachable when even step 2 can't reach the cap because what's left is
 *     spans *with* children (wide-but-deep ok fan-out, or simply many collapse-markers) — drop
 *     whole non-error subtrees, largest first, each replaced by one synthetic
 *     "…subtree of N spans under <service>.<operation> omitted" marker parented where the
 *     subtree's root was (see `dropOversizedSubtrees`).
 *  4. **Error-path exception**: `mustKeep` (every `status: 'error'` span plus all of its ancestors
 *     up to the root — the full root→leaf error path for every error branch) is never touched by
 *     steps 1–3, so if `mustKeep` alone already exceeds `MAX_TRACE_SPANS`, no amount of
 *     collapsing/trimming/dropping non-error spans could ever bring the result under the cap.
 *     Error-path integrity outranks the cap: ALL of `mustKeep` is returned regardless, with
 *     `truncated: true` and a note explaining the cap was exceeded to preserve the error path.
 *     (Checked up front below rather than literally last — since `mustKeep` is invariant across
 *     steps 1–3, checking early is equivalent to checking last, just without the wasted work.)
 *
 * Tree validity invariant maintained throughout: a span is never left in the result with its
 * `parent_span_id` pointing at a span that got dropped — every drop (leaf-trim or subtree-drop)
 * either removes a childless span or removes an entire subtree (root + all descendants) together.
 */
function collapseTrace(spans: readonly Span[], errorLogs: readonly LogLine[]): TraceView {
  const bySpanId = new Map(spans.map((s) => [s.span_id, s] as const));
  const hasChildren = new Set<string>();
  for (const s of spans) {
    if (s.parent_span_id !== null) hasChildren.add(s.parent_span_id);
  }

  const mustKeep = new Set<string>();
  for (const s of spans) {
    if (s.status !== "error") continue;
    let cur: Span | undefined = s;
    while (cur) {
      mustKeep.add(cur.span_id);
      cur = cur.parent_span_id !== null ? bySpanId.get(cur.parent_span_id) : undefined;
    }
  }

  // Step 4 (documented exception), checked up front: see doc comment above.
  if (mustKeep.size > MAX_TRACE_SPANS) {
    const errorPathSpans = spans.filter((s) => mustKeep.has(s.span_id)).sort((a, b) => a.start_ms - b.start_ms);
    return {
      spans: errorPathSpans,
      errorLogs: [...errorLogs],
      truncated: true,
      note: `showing ${errorPathSpans.length} of ${spans.length} spans; cap of ${MAX_TRACE_SPANS} exceeded to preserve the full error path (error spans and their ancestors are never dropped)`,
    };
  }

  // Step 1: leaf-collapse.
  const groups = new Map<string, Span[]>();
  for (const s of spans) {
    if (mustKeep.has(s.span_id) || hasChildren.has(s.span_id)) continue;
    const key = `${s.parent_span_id ?? "\u0000root"}\u0000${s.service}\u0000${s.operation}`;
    const group = groups.get(key);
    if (group) group.push(s);
    else groups.set(key, [s]);
  }

  const collapsedIds = new Set<string>();
  const leafMarkers: Span[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const s of group) collapsedIds.add(s.span_id);
    const first = group[0] as Span;
    const startMs = Math.min(...group.map((s) => s.start_ms));
    const avgDurationMs = Math.round(group.reduce((sum, s) => sum + s.duration_ms, 0) / group.length);
    leafMarkers.push({
      trace_id: first.trace_id,
      span_id: `${COLLAPSED_SPAN_ID_PREFIX}${first.parent_span_id ?? "root"}:${first.service}:${first.operation}`,
      parent_span_id: first.parent_span_id,
      service: first.service,
      operation: `…${group.length} similar ok spans`,
      start_ms: startMs,
      duration_ms: avgDurationMs,
      status: "ok",
      error_type: null,
    });
  }

  let kept = [...spans.filter((s) => !collapsedIds.has(s.span_id)), ...leafMarkers];

  // Step 2: leaf-trim (defensive fallback).
  let trimmedCount = 0;
  if (kept.length > MAX_TRACE_SPANS) {
    const droppable = kept
      .filter((s) => !mustKeep.has(s.span_id) && !isCollapsedMarker(s) && !hasChildren.has(s.span_id))
      .sort((a, b) => a.start_ms - b.start_ms);
    const overBy = kept.length - MAX_TRACE_SPANS;
    const toDrop = new Set(droppable.slice(0, overBy).map((s) => s.span_id));
    trimmedCount = toDrop.size;
    kept = kept.filter((s) => !toDrop.has(s.span_id));
  }

  // Step 3: subtree-drop.
  let subtreeDroppedSpanCount = 0;
  let subtreeMarkerCount = 0;
  if (kept.length > MAX_TRACE_SPANS) {
    const dropped = dropOversizedSubtrees(kept, mustKeep);
    kept = dropped.kept;
    subtreeDroppedSpanCount = dropped.droppedSpanCount;
    subtreeMarkerCount = dropped.markerCount;
  }

  kept.sort((a, b) => a.start_ms - b.start_ms);

  const noteParts: string[] = [];
  if (leafMarkers.length > 0) {
    noteParts.push(
      `${collapsedIds.size} similar ok spans collapsed across ${leafMarkers.length} group${leafMarkers.length === 1 ? "" : "s"}`,
    );
  }
  if (trimmedCount > 0) {
    noteParts.push(`${trimmedCount} oldest ok leaves omitted`);
  }
  if (subtreeMarkerCount > 0) {
    noteParts.push(
      `${subtreeDroppedSpanCount} spans across ${subtreeMarkerCount} subtree${subtreeMarkerCount === 1 ? "" : "s"} omitted`,
    );
  }
  const note = `showing ${kept.length} of ${spans.length} spans${noteParts.length > 0 ? `; ${noteParts.join("; ")}` : ""}`;
  return { spans: kept, errorLogs: [...errorLogs], truncated: true, note };
}

/**
 * Step 3 of `collapseTrace`'s cap enforcement: only reached when leaf-collapse + leaf-trim still
 * leave `kept` over `MAX_TRACE_SPANS`. Leaf-trim removes every droppable *leaf* it can find, so
 * anything still over the cap afterward must be a span *with* children — exactly what leaf-collapse
 * refuses to touch (collapsing an internal node would orphan its descendants).
 *
 * Repeatedly finds the largest "non-error subtree" — a span `R` that is not in `mustKeep` (by
 * `mustKeep`'s own construction — error span or ancestor of one — that means no error span exists
 * anywhere under `R`) whose parent is either absent (`R` is the trace root) or itself in
 * `mustKeep` (so `R` is the *topmost* droppable node on its path; a deeper non-must-keep node is
 * left for a later iteration once its ancestor's subtree has actually been dropped) — and
 * collapses the whole thing (root + every descendant still present) into one synthetic marker
 * parented where `R` was. Recomputes subtree sizes each iteration, since removing one subtree can
 * change another node's child count (e.g. its only remaining child was just dropped as a leaf).
 * Stops at the cap, or when no droppable subtree remains (nothing left over the cap is either
 * childless or has a non-must-keep parent still above it) — the caller may still be over the cap
 * in that case, but nothing more can be done without violating the error-path or orphan rules.
 */
function dropOversizedSubtrees(
  kept: readonly Span[],
  mustKeep: ReadonlySet<string>,
): { kept: Span[]; droppedSpanCount: number; markerCount: number } {
  let current = [...kept];
  let droppedSpanCount = 0;
  let markerCount = 0;

  while (current.length > MAX_TRACE_SPANS) {
    const byId = new Map(current.map((s) => [s.span_id, s] as const));
    const childrenOf = new Map<string, string[]>();
    for (const s of current) {
      if (s.parent_span_id === null) continue;
      const arr = childrenOf.get(s.parent_span_id);
      if (arr) arr.push(s.span_id);
      else childrenOf.set(s.parent_span_id, [s.span_id]);
    }
    const sizeOf = (id: string): number => {
      let total = 1;
      for (const c of childrenOf.get(id) ?? []) total += sizeOf(c);
      return total;
    };

    const candidates = current.filter((s) => {
      if (mustKeep.has(s.span_id) || isCollapsedMarker(s)) return false;
      const children = childrenOf.get(s.span_id);
      if (!children || children.length === 0) return false; // no gain in "dropping" a childless node
      const parentId = s.parent_span_id;
      if (parentId === null) return true;
      return !byId.has(parentId) || mustKeep.has(parentId);
    });
    if (candidates.length === 0) break;

    candidates.sort((a, b) => sizeOf(b.span_id) - sizeOf(a.span_id));
    const root = candidates[0] as Span;
    const subtreeSize = sizeOf(root.span_id);

    const toRemove = new Set<string>();
    const stack = [root.span_id];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      toRemove.add(id);
      for (const c of childrenOf.get(id) ?? []) stack.push(c);
    }

    const marker: Span = {
      trace_id: root.trace_id,
      span_id: `${COLLAPSED_SPAN_ID_PREFIX}subtree:${root.span_id}`,
      parent_span_id: root.parent_span_id,
      service: root.service,
      operation: `…subtree of ${subtreeSize} spans under ${root.service}.${root.operation} omitted`,
      start_ms: root.start_ms,
      duration_ms: root.duration_ms,
      status: "ok",
      error_type: null,
    };

    current = [...current.filter((s) => !toRemove.has(s.span_id)), marker];
    droppedSpanCount += subtreeSize;
    markerCount += 1;
  }

  return { kept: current, droppedSpanCount, markerCount };
}

/**
 * The full span tree for `traceId`, capped to `MAX_TRACE_SPANS` (see `collapseTrace`) plus its
 * linked error logs. Returns an empty, non-truncated view for an unknown `traceId` (no spans to
 * cap) — callers distinguish "no such trace" from "this trace has been truncated" via `spans`
 * being empty vs. `truncated: true`.
 *
 * The cap is enforced in this order: leaf-collapse → leaf-trim → subtree-drop →
 * error-path-exception (see `collapseTrace`'s doc comment for the full detail on each step).
 */
export async function getTrace(db: D1Database, traceId: string): Promise<TraceView> {
  const { results: spanRows } = await db
    .prepare(
      "SELECT trace_id, span_id, parent_span_id, service, operation, start_ms, duration_ms, status, error_type FROM spans WHERE trace_id = ? ORDER BY start_ms ASC",
    )
    .bind(traceId)
    .all<Span>();
  const spans = spanRows ?? [];

  const { results: logRows } = await db
    .prepare(
      "SELECT ts_ms, service, level, message, trace_id, span_id FROM logs WHERE trace_id = ? AND level = 'error' ORDER BY ts_ms ASC",
    )
    .bind(traceId)
    .all<LogRowDb>();
  const errorLogs = (logRows ?? []).map(rowToLogLine);

  if (spans.length <= MAX_TRACE_SPANS) {
    return { spans, errorLogs, truncated: false };
  }
  return collapseTrace(spans, errorLogs);
}

// --- listDeploys ------------------------------------------------------------------------------

export interface ListDeploysArgs {
  fromMs: number;
  toMs: number;
}

/** Deploy/change events within `[fromMs, toMs)`, chronological ascending (a timeline, for
 * correlating with a regression's onset). No caller-facing cap: `deploys` is low-volume by
 * design (spec §7), so this never needs shape-aware truncation. `id` is deliberately never
 * selected — it embeds the injected scenario's name, and stripping it HERE (rather than in each
 * consumer) is what makes the honesty boundary un-forgettable; see `PublicDeploy`. */
export async function listDeploys(db: D1Database, args: ListDeploysArgs): Promise<PublicDeploy[]> {
  const { results } = await db
    .prepare("SELECT service, version, ts_ms, note FROM deploys WHERE ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms ASC")
    .bind(args.fromMs, args.toMs)
    .all<PublicDeploy>();
  return results ?? [];
}

// --- getIncidents -----------------------------------------------------------------------------

export type GetIncidentsArgs = { id: string } | { fromMs: number; toMs: number };

/** Row cap for `getIncidents`'s window lookup (newest-first by `opened_at`). Exported for the
 * same stale-copy-prevention reason as `SEARCH_LOGS_MAX_LIMIT`/`FIND_TRACES_MAX_LIMIT`. The `id`
 * lookup is never capped (at most one row can ever match). */
export const GET_INCIDENTS_MAX_LIMIT = 20;

export interface GetIncidentsResult {
  /** The returned page: for a window lookup, at most `GET_INCIDENTS_MAX_LIMIT` incidents, newest
   * first; for an `id` lookup, the single matching incident or none. */
  incidents: IncidentView[];
  /** Total incidents matching the same filters, ignoring the cap — see `SearchLogsResult.total`.
   * For an `id` lookup this is simply `incidents.length` (0 or 1), since there's no cap to hide
   * anything behind. */
  total: number;
}

interface IncidentRowDb {
  id: string;
  status: IncidentView["status"];
  severity: IncidentView["severity"];
  opened_at: number;
  reported_at: number | null;
  resolved_at: number | null;
  trigger_json: string;
  report_json: string | null;
  follow_up_of: string | null;
}

const INCIDENT_COLUMNS =
  "id, status, severity, opened_at, reported_at, resolved_at, trigger_json, report_json, follow_up_of";

function rowToIncidentView(row: IncidentRowDb, fingerprints: string[]): IncidentView {
  return {
    id: row.id,
    status: row.status,
    severity: row.severity,
    opened_at: row.opened_at,
    reported_at: row.reported_at,
    resolved_at: row.resolved_at,
    trigger: JSON.parse(row.trigger_json) as unknown,
    report: row.report_json !== null ? (JSON.parse(row.report_json) as unknown) : null,
    follow_up_of: row.follow_up_of,
    fingerprints,
  };
}

/** Batch-fetches each incident's fingerprint set (`incident_fingerprints`, oldest-first), keyed by
 * `incident_id` — a second small query rather than a `JOIN`, since an incident can carry several
 * fingerprints (spec §7: scenario 1's cascade produces several at open time) and a `JOIN` would
 * fan out/duplicate the incident row per fingerprint. */
async function fetchFingerprints(db: D1Database, incidentIds: readonly string[]): Promise<Map<string, string[]>> {
  const byIncident = new Map<string, string[]>();
  if (incidentIds.length === 0) return byIncident;

  const placeholders = incidentIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT incident_id, fingerprint FROM incident_fingerprints
       WHERE incident_id IN (${placeholders})
       ORDER BY first_seen_ms ASC`,
    )
    .bind(...incidentIds)
    .all<{ incident_id: string; fingerprint: string }>();

  for (const row of results ?? []) {
    const arr = byIncident.get(row.incident_id);
    if (arr) arr.push(row.fingerprint);
    else byIncident.set(row.incident_id, [row.fingerprint]);
  }
  return byIncident;
}

/**
 * Incidents either by `id` (at most one match) or by `opened_at` window, newest first and capped
 * to `GET_INCIDENTS_MAX_LIMIT` (a busy window can accumulate more incidents than any investigation
 * needs to see at once) — `trigger_json`/`report_json` are parsed into `trigger`/`report` (spec
 * §9: the report's evidence is embedded at submit time, so this reads correctly even after raw
 * telemetry has aged out of retention), and each incident's fingerprint set is joined in from
 * `incident_fingerprints`. The window branch's `total` comes from a `COUNT(*)` over the same
 * `WHERE`, batched alongside the page query (same pattern as `searchLogs`/`findTraces`), so
 * `total > incidents.length` is the exact truncation signal.
 */
export async function getIncidents(db: D1Database, args: GetIncidentsArgs): Promise<GetIncidentsResult> {
  if ("id" in args) {
    const row = await db
      .prepare(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = ?`)
      .bind(args.id)
      .first<IncidentRowDb>();
    if (!row) return { incidents: [], total: 0 };
    const fingerprints = await fetchFingerprints(db, [row.id]);
    return { incidents: [rowToIncidentView(row, fingerprints.get(row.id) ?? [])], total: 1 };
  }

  const [pageRes, countRes] = await db.batch([
    db
      .prepare(
        `SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at DESC LIMIT ?`,
      )
      .bind(args.fromMs, args.toMs, GET_INCIDENTS_MAX_LIMIT),
    db.prepare(`SELECT COUNT(*) AS total FROM incidents WHERE opened_at >= ? AND opened_at < ?`).bind(args.fromMs, args.toMs),
  ]);
  const rows = (pageRes?.results ?? []) as IncidentRowDb[];
  const totalRow = countRes?.results?.[0] as { total: number } | undefined;
  const total = totalRow?.total ?? rows.length;
  const fingerprints = await fetchFingerprints(db, rows.map((r) => r.id));
  const incidents = rows.map((row) => rowToIncidentView(row, fingerprints.get(row.id) ?? []));
  return { incidents, total };
}

// --- listInvestigationSteps ---------------------------------------------------------------------

/** One `investigation_steps` row shaped for consumption (`GET /api/incidents/:id`'s timeline —
 * Task 5.2's UI polls it at 2s during an investigation, so this shape is JSON-stable by contract):
 * `content` is the row's `content_json` parsed (an `unknown`, never a raw JSON string — matching
 * `IncidentView`'s own `trigger`/`report` convention), and the token columns ride along so the UI
 * can render per-step cost. `incident_id` is deliberately omitted: every caller already scoped the
 * query by it. */
export interface StepView {
  step_no: number;
  kind: "tool_call" | "tool_result" | "note" | "report" | "error";
  content: unknown;
  ts_ms: number;
  tokens_in: number;
  tokens_out: number;
}

interface StepRowDb {
  step_no: number;
  kind: StepView["kind"];
  content_json: string;
  ts_ms: number;
  tokens_in: number;
  tokens_out: number;
}

/**
 * Every `investigation_steps` row for `incidentId`, ordered by `step_no` ascending (the
 * investigation's own timeline order). Returns `[]` for an unknown incident id or one whose
 * investigation hasn't written a step yet — the caller ( `GET /api/incidents/:id`) distinguishes
 * "no such incident" via `getIncidents`, not via an empty step list, since a freshly-opened
 * incident legitimately has zero steps. No row cap: the investigator's own budgets bound an
 * investigation to 15 steps (Global Constraints), so this can never grow past a few dozen rows
 * even with salvage/error entries — nothing here for a shape-aware cap to protect.
 *
 * A `content_json` that fails to parse degrades to the raw string as `content` (logged) rather
 * than throwing — one corrupt row must not take down the whole timeline the UI is polling,
 * mirroring `incidents.ts`'s `parseTrigger` fail-safe convention for the same class of column.
 */
export async function listInvestigationSteps(db: D1Database, incidentId: string): Promise<StepView[]> {
  const { results } = await db
    .prepare(
      `SELECT step_no, kind, content_json, ts_ms, tokens_in, tokens_out
       FROM investigation_steps WHERE incident_id = ? ORDER BY step_no ASC`,
    )
    .bind(incidentId)
    .all<StepRowDb>();

  return (results ?? []).map((row) => {
    let content: unknown;
    try {
      content = JSON.parse(row.content_json);
    } catch (err) {
      console.error(`read: investigation_steps content_json failed to parse (incident ${incidentId}, step ${row.step_no})`, err);
      content = row.content_json;
    }
    return {
      step_no: row.step_no,
      kind: row.kind,
      content,
      ts_ms: row.ts_ms,
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
    };
  });
}
