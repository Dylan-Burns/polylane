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
