/** A single span, persisted for error traces plus a sampled subset of healthy traces (spec §6). */
export interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service: string;
  operation: string;
  start_ms: number;
  duration_ms: number;
  status: "ok" | "error";
  error_type: string | null;
}

/** A single log line, persisted alongside its trace's spans. */
export interface LogLine {
  ts_ms: number;
  service: string;
  level: "info" | "warn" | "error";
  message: string;
  trace_id?: string;
  span_id?: string;
}

/** A 1-minute rollup for a (service, operation) pair, computed from 100% of traffic. */
export interface RollupRow {
  service: string;
  operation: string;
  minute_ts: number;
  count: number;
  error_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

/** A deploy event (benign or fault-injecting). */
export interface Deploy {
  id: string;
  service: string;
  version: string;
  ts_ms: number;
  note: string;
}

/** The four metric classes baselines are computed over (spec §8 v2.1): `req_rate` maps to a
 * `MetricPoint`'s `count`, `error_rate`/`p95`/`p50` map to the like-named fields. `p50` exists to
 * back the latency rules' distribution-shift confirmation (p50 >= 2.0x its baseline), not as an
 * alerting metric of its own. */
export type BaselineMetric = "req_rate" | "error_rate" | "p95" | "p50";

/**
 * One bucketed point of a metrics timeseries (`read.ts`'s `queryMetrics`), optionally overlaid
 * with its trailing-24h baseline (median + MAD, Task 3.1) and a `delta` ratio (`value / median`)
 * derived from it per metric. `baseline`/`delta` are omitted entirely — not present as `{}` — when
 * no baseline row exists yet for this (service, operation): the `baselines` table may still be
 * empty (Task 3.1 hasn't run), and this must degrade cleanly rather than surface as `NaN`.
 */
export interface MetricPoint {
  service: string;
  operation: string;
  minute_ts: number;
  count: number;
  error_rate: number;
  p50: number;
  p95: number;
  p99: number;
  baseline?: Partial<Record<BaselineMetric, { median: number; mad: number }>>;
  delta?: Partial<Record<BaselineMetric, number>>;
}

/** One row of `findTraces` — the entry (root) span's identity and duration, not a full span
 * tree (use `getTrace` for that). `duration_ms` is the root span's own duration, not a
 * `max(end) - min(start)` across the tree, which an async fire-and-forget tail could inflate.
 * `span_count` is the total number of *persisted* spans for this trace (not necessarily every
 * span the request actually produced — only error traces plus a 10% sample persist, spec §6). */
export interface TraceSummary {
  trace_id: string;
  entry_service: string;
  entry_operation: string;
  start_ms: number;
  duration_ms: number;
  status: "ok" | "error";
  span_count: number;
}

/** `getTrace`'s shape-aware, capped view of one trace's span tree. */
export interface TraceView {
  spans: Span[];
  errorLogs: LogLine[];
  truncated: boolean;
  note?: string;
}

/** An `incidents` row with its JSON columns parsed for consumption (agent tools, UI, chat) —
 * `trigger_json`/`report_json` are never handed back as raw strings. `fingerprints` is the
 * incident's fingerprint set joined in from `incident_fingerprints`, oldest-first. */
export interface IncidentView {
  id: string;
  status: "open" | "investigating" | "reported" | "resolved" | "failed";
  severity: "warning" | "critical";
  opened_at: number;
  reported_at: number | null;
  resolved_at: number | null;
  trigger: unknown;
  report: unknown | null;
  follow_up_of: string | null;
  fingerprints: string[];
}
