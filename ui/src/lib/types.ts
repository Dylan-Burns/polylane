/**
 * JSON shapes the UI consumes from the API (spec §10/§11). Two sourcing strategies, deliberately
 * mixed:
 *
 *  - Types from dependency-free server modules (`src/telemetry/types.ts`, `src/sim/scenarios.ts`)
 *    are imported directly below — a real single source of truth, not a copy that can drift.
 *    `ui/tsconfig.app.json`'s `include` is widened to cover exactly these files (plus their own
 *    dependency-free imports) so `tsc -b` can typecheck across the project boundary.
 *  - Types whose *source* module transitively imports D1-typed code (`D1Database`,
 *    `DurableObjectState` — `src/telemetry/state.ts`, `src/telemetry/read.ts`,
 *    `src/agent/report-schema.ts`, `src/sim/simulator-do.ts`) are hand-mirrored here instead:
 *    importing those modules would drag `@cloudflare/workers-types`-only globals into a Vite
 *    project that never installs that package. Each mirror below cites its source file/type name;
 *    keep them in sync by hand when the matching server-side shape changes.
 */

import type { FaultState, ScenarioId } from "../../../src/sim/scenarios";
import type { IncidentView, LogLine, PublicDeploy, Span, TraceView } from "../../../src/telemetry/types";

export type { FaultState, IncidentView, LogLine, PublicDeploy, ScenarioId, Span, TraceView };

// --- /api/state (mirrors src/telemetry/state.ts's exported interfaces) --------------------------

export type HealthStatus = "red" | "amber" | "green";

/** Mirrors `src/sim/topology.ts`'s `ServiceKind` (not imported directly — see this file's header
 * comment on why D1-typed server modules are hand-mirrored instead). */
export type ServiceKind = "worker" | "d1" | "kv" | "queue" | "external";

export interface TopologyServiceNode {
  name: string;
  external?: boolean;
  kind: ServiceKind;
}

export interface TopologyPayload {
  services: TopologyServiceNode[];
  edges: [string, string][];
}

export interface SparklinePoint {
  minute_ts: number;
  count: number;
  error_rate: number;
  p95: number;
}

/** Mirrors `src/sim/simulator-do.ts`'s `WorldStatus` (not imported directly — that module pulls in
 * the full Durable Object/D1 write path). */
export type WorldStatus = "unseeded" | "seeding" | "running" | "resetting";

export interface WorldStatusView {
  worldStatus: WorldStatus;
  fault: FaultState;
  generation: number;
  seedProgress?: number;
}

export interface OpsHealth {
  lastSweepOkMs?: number;
  retentionWatermarkAgeMs?: number;
}

/** The open (not-yet-closed) minute's accumulated per-service stats — mirrors
 * `src/sim/simulator-do.ts`'s `handleStatus` live aggregation. Omitted when the world isn't
 * running. See `docs/plans/2026-07-17-cf-native-revamp.md` Canonical Table 7. */
export interface LiveMetrics {
  minuteTs: number;
  elapsedMs: number;
  services: Record<string, { count: number; errPct: number; p95: number }>;
}

export interface StateResponse {
  topology: TopologyPayload;
  health: Record<string, HealthStatus>;
  sparklines: Record<string, SparklinePoint[]>;
  worldStatus: WorldStatusView;
  opsHealth: OpsHealth;
  live?: LiveMetrics;
}

// --- /api/incidents/:id (mirrors src/telemetry/read.ts's StepView + src/api/routes.ts's
// IncidentDetailResponse) -------------------------------------------------------------------------

export interface StepView {
  step_no: number;
  kind: "tool_call" | "tool_result" | "note" | "report" | "error";
  content: unknown;
  ts_ms: number;
  tokens_in: number;
  tokens_out: number;
}

export interface IncidentDetailResponse {
  incident: IncidentView;
  steps: StepView[];
}

export interface IncidentListResponse {
  incidents: IncidentView[];
  total: number;
}

// --- /api/analytics (mirrors src/telemetry/state.ts's AnalyticsResponse) ------------------------

export interface AnalyticsResponse {
  incidents24h: number;
  openNow: number;
  timeToReportP50Ms: number | null;
  timeToResolveP50Ms: number | null;
  reqPerMin: number | null;
  errorRatePct: number | null;
}

// --- /api/deploys (id-free rows straight from the query seam — src/telemetry/read.ts's
// listDeploys never selects the scenario-revealing internal id) ----------------------------------

export interface DeployListResponse {
  deploys: PublicDeploy[];
}

// --- /api/incidents/:id/logs (mirrors src/api/routes.ts's IncidentLogsResponse — hand-mirrored,
// not imported, for the same D1-typed-source reason as this file's header comment) ---------------

export interface IncidentLogsResponse {
  logs: LogLine[];
  total: number;
  truncated: boolean;
}

// --- /api/incidents/:id/metrics (mirrors src/api/routes.ts's IncidentMetricsResponse) -----------

export interface IncidentMetricTile {
  service: string;
  metricClass: "req_rate" | "error_rate" | "p95";
  unit: "per_min" | "pct" | "ms";
  points: { minute_ts: number; value: number }[];
  peak: number;
  baseline: number;
  ratio: number | null;
}

export interface IncidentMetricsResponse {
  windowFromMs: number;
  windowToMs: number;
  tiles: IncidentMetricTile[];
}

// --- Report (mirrors src/agent/report-schema.ts's Report + friends) ------------------------------

export interface ReportTimelineEntry {
  time: string;
  description: string;
}

export interface ReportRootCause {
  hypothesis: string;
  mechanism: string;
}

export interface ReportEvidenceEntry {
  description: string;
  trace_id: string | null;
  metric: string | null;
  log_excerpt: string | null;
  /** Present for every entry whose `trace_id` is non-null once the report has been submitted
   * (`embedEvidence` runs before `report_json` is ever written) — the trace's span-tree view
   * fetched at submit time, or `{error}` if that fetch itself failed. */
  embedded?: TraceView | { error: string };
}

export interface ReportBlastRadius {
  affected_services: string[];
  customer_impact: string;
}

export interface ReportConfidence {
  level: "low" | "medium" | "high";
  why: string;
}

export interface Report {
  summary: string;
  timeline: ReportTimelineEntry[];
  root_cause: ReportRootCause;
  evidence: ReportEvidenceEntry[];
  blast_radius: ReportBlastRadius;
  confidence: ReportConfidence;
  suggested_action: string;
}

// --- Chaos endpoints (mirror src/sim/simulator-do.ts's handler response bodies) ------------------

export interface ChaosFaultBody {
  fault: FaultState;
}

export interface ChaosErrorBody {
  error?: string;
  retryAfterMs?: number;
}

// --- /api/chat (mirrors src/api/chat.ts's ChatSSEEvent) -----------------------------------------
// Hand-mirrored, not imported: `chat.ts` pulls in Hono/the Anthropic SDK, which the Vite project
// never installs (same reasoning as this file's header comment for the D1-typed server modules).

export type ChatSSEEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking" }
  | { type: "tool_call"; name: string; summary: string }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "budget_reached" }
  | { type: "done" }
  | { type: "error"; message: string };
