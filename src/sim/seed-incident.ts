/**
 * Seeds one hand-authored, already-resolved "bad deploy" incident ~3h before reset time (spec §6:
 * "the backfill also seeds one resolved incident with a full investigation timeline and report,
 * so a reviewer's first 10 seconds show the end product without waiting for a live cycle"). Takes
 * `nowMs` as an explicit parameter rather than reading `Date.now()` itself — like `backfill.ts`,
 * this stays deterministic given its inputs; only `SimulatorDO` reads the wall clock.
 *
 * The report/timeline/evidence below are fabricated content, not derived from re-running the
 * generator over this historical window — spec §9 explicitly allows this ("Evidence payloads ...
 * are embedded into report_json at submit time — reports stay fully viewable after raw telemetry
 * expires"), so the embedded trace/log excerpts here don't need matching rows in `spans`/`logs`.
 * The one exception is the `deploys` row: backfill (see `backfill.ts`) always runs with
 * `identityEffects`, so without an explicit insert here `deploys` would be empty after every
 * reset, and a future "list recent deploys" tool would find nothing to corroborate the report's
 * root-cause narrative.
 *
 * Honesty calibration still applies to anything the agent could observe live (the deploy `note`,
 * the log excerpt), but not to the report's own prose — the root-cause naming the deploy is the
 * *agent's conclusion* in a finished report, which spec §6 explicitly allows ("that's the AGENT's
 * conclusion — allowed and expected in a report; the honesty rule constrains telemetry, not
 * reports").
 *
 * **Schema fidelity (Task 5.2 fix):** every piece of hand-authored content here is shaped to be
 * byte-for-byte indistinguishable, structurally, from what a real investigation produces:
 *  - `report`/`embeddedReport` match `agent/report-schema.ts`'s `Report` exactly (validated by
 *    `test/unit/seed-incident.test.ts` via `validateReport`), with `embeddedReport`'s trace
 *    evidence entry carrying the same `embedded: TraceView` decoration `embedEvidence` bakes onto
 *    a live report at submit time — hand-built here (no real `spans`/`logs` rows back this trace)
 *    rather than run through `embedEvidence` itself, which would 404 against this seed's
 *    non-existent raw telemetry.
 *  - `steps` use the exact `tool_call`/`tool_result` shapes `agent/loop.ts`'s `record` calls
 *    write (`{tool_use_id, name, input}` / `{tool_use_id, name, output, is_error}`), and every
 *    `name` is a real `agent/tools.ts` tool (`query_metrics`, `list_deploys`, `find_traces`) with
 *    input/output shaped to that tool's own schema/executor — never the ad hoc tool names or
 *    result shapes an earlier version of this file invented.
 *  - The `report`-kind step's `content` is the RAW (pre-embed) report — exactly mirroring
 *    `agent/loop.ts`'s `record("report", reportUse.input, ...)`, which fires before
 *    `InvestigatorDO.handleOutcome` ever calls `embedEvidence`. Only `incidents.report_json`
 *    (this file's `embeddedReport`) carries the `.embedded` decoration.
 */

import type { Report, ReportEvidenceEntry, ReportTimelineEntry } from "../agent/report-schema";
import type { Deploy, LogLine, MetricPoint, Span, TraceSummary, TraceView } from "../telemetry/types";

// All inserts below use INSERT OR IGNORE on deterministic ids/PKs: the final backfill chunk can
// be retried after a crash that landed these rows but died before the worldStatus -> 'running'
// flip, and the retry must skip cleanly instead of throwing on PK collisions forever.

/** Incident opens ~3h before reset time (task brief: "hand-authored resolved bad-deploy incident
 * ~3h before nowMs"). */
const INCIDENT_AGE_MS = 3 * 60 * 60 * 1000;

/** Deploy precedes "opened" by onset (30s, mirroring the live bad-deploy scenario's
 * `BAD_DEPLOY_ONSET_MS`) plus the time a sustained-rule detector needs to confirm the anomaly. */
const DETECTION_LAG_MS = 3 * 60_000;

const INVESTIGATION_DURATION_MS = 3 * 60_000;
const RESOLUTION_LAG_MS = 4 * 60_000;

/** Fabricated trace_id for the one representative failing request cited in evidence — never a
 * real `spans` row (see this file's top doc comment). */
const SEED_TRACE_ID = "seed0bad0dep10y0000000000000001";

interface StepSpec {
  kind: "tool_call" | "tool_result" | "note" | "report";
  offsetMs: number;
  content: unknown;
  tokensIn: number;
  tokensOut: number;
}

export interface SeedStory {
  incidentId: string;
  deployId: string;
  deployMs: number;
  openedAtMs: number;
  reportedAtMs: number;
  resolvedAtMs: number;
  trigger: { statement: string; fingerprints: string[]; detected_at_ms: number };
  /** RAW (pre-embed) report — what `submit_report` would have carried, and what the `report`-kind
   * step's `content` holds. Passes `agent/report-schema.ts`'s `validateReport` unchanged. */
  report: Report;
  /** `report` plus `embedEvidence`'s decoration on the trace evidence entry — what
   * `incidents.report_json` actually stores for a resolved incident. */
  embeddedReport: Report;
  steps: StepSpec[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Builds every deterministic, nowMs-derived piece of the seeded incident: the fingerprint
 * trigger, the report (raw + embedded), and the investigation timeline's step records. Exported
 * so `test/unit/seed-incident.test.ts` can validate `report` against the real schema directly,
 * without needing a D1 instance.
 */
export function buildSeedStory(nowMs: number): SeedStory {
  const openedAtMs = nowMs - INCIDENT_AGE_MS;
  const deployMs = openedAtMs - DETECTION_LAG_MS;
  const reportedAtMs = openedAtMs + INVESTIGATION_DURATION_MS;
  const resolvedAtMs = reportedAtMs + RESOLUTION_LAG_MS;
  const onsetMs = deployMs + 30_000;

  const incidentId = `seed-bad-deploy-${nowMs}`;
  const deployId = `seed-deploy-payments-${nowMs}`;

  const timeline: ReportTimelineEntry[] = [
    { time: iso(deployMs), description: "payments v3.0.0 deployed" },
    { time: iso(onsetMs), description: "payments error rate and p95 latency begin climbing" },
    { time: iso(openedAtMs), description: "sustained anomaly crosses detection threshold; incident opened" },
    { time: iso(openedAtMs + 60_000), description: "investigation correlates the deploy timestamp with the regression onset" },
    { time: iso(reportedAtMs), description: "report submitted: payments deploy identified as root cause" },
    { time: iso(resolvedAtMs), description: "payments rolled back; metrics recover; incident resolved" },
  ];

  // --- The one representative failing trace, hand-built to the exact TraceView shape
  // `agent/report-schema.ts`'s `embedEvidence` would have produced had this trace's raw spans/
  // logs actually existed at submit time. --------------------------------------------------------
  const traceStartMs = onsetMs + 40_000;
  const gatewaySpan: Span = {
    trace_id: SEED_TRACE_ID,
    span_id: "seed-span-gateway",
    parent_span_id: null,
    service: "gateway",
    operation: "route_checkout",
    start_ms: traceStartMs,
    duration_ms: 3120,
    status: "error",
    error_type: "downstream_error",
  };
  const checkoutSpan: Span = {
    trace_id: SEED_TRACE_ID,
    span_id: "seed-span-checkout",
    parent_span_id: "seed-span-gateway",
    service: "checkout",
    operation: "place_order",
    start_ms: traceStartMs + 20,
    duration_ms: 3080,
    status: "error",
    error_type: "downstream_error",
  };
  const paymentsSpan: Span = {
    trace_id: SEED_TRACE_ID,
    span_id: "seed-span-payments",
    parent_span_id: "seed-span-checkout",
    service: "payments",
    operation: "charge",
    start_ms: traceStartMs + 60,
    duration_ms: 3000,
    status: "error",
    error_type: "pool_exhausted",
  };
  const poolExhaustedLog: LogLine = {
    ts_ms: onsetMs + 45_000,
    service: "payments-db",
    level: "error",
    message: "connection pool exhausted: 25/25 in use, acquire timeout 5000ms",
    trace_id: SEED_TRACE_ID,
    span_id: "seed-span-payments",
  };
  const embeddedTrace: TraceView = {
    spans: [gatewaySpan, checkoutSpan, paymentsSpan],
    errorLogs: [poolExhaustedLog],
    truncated: false,
  };

  const evidence: ReportEvidenceEntry[] = [
    {
      description: "Payments charge error rate jumped to 24.1% (baseline ~0.3%) in the 5 minutes before the incident opened.",
      trace_id: null,
      metric: "payments.charge error_rate: 0.241 vs baseline 0.002 (5m window ending at incident open)",
      log_excerpt: null,
    },
    {
      description: "Payments charge p95 latency rose to 578ms (baseline ~92ms) over the same window.",
      trace_id: null,
      metric: "payments.charge p95_ms: 578 vs baseline 92 (5m window ending at incident open)",
      log_excerpt: null,
    },
    {
      description:
        "Checkout place_order error rate also rose to 6.1% (baseline ~0.3%), consistent with payments failures cascading into checkout.",
      trace_id: null,
      metric: "checkout.place_order error_rate: 0.061 vs baseline 0.002 (5m window ending at incident open)",
      log_excerpt: null,
    },
    {
      description:
        "A payments v3.0.0 deploy landed ~30s before the regression onset; no other deploy touched an affected service in " +
        "this window (a co-occurring catalog deploy is a different, unaffected service).",
      trace_id: null,
      metric: null,
      log_excerpt: null,
    },
    {
      description: "A payments-db log line captured right at onset shows the connection pool fully exhausted.",
      trace_id: null,
      metric: null,
      log_excerpt: "connection pool exhausted: 25/25 in use, acquire timeout 5000ms",
    },
    {
      description:
        "A representative failing checkout request shows the causal chain end to end: gateway routes to checkout, which " +
        "calls payments, which errors waiting on the exhausted connection pool.",
      trace_id: SEED_TRACE_ID,
      metric: null,
      log_excerpt: null,
    },
  ];

  const report: Report = {
    summary:
      "A payments deploy (v3.0.0) triggered a connection-pool exhaustion regression starting ~30s " +
      "after rollout, degrading payments latency and reliability and cascading into checkout " +
      "timeouts and gateway 5xx responses for roughly six minutes before rollback.",
    timeline,
    root_cause: {
      hypothesis: "The payments v3.0.0 deploy introduced a database connection-pool regression under normal load.",
      mechanism:
        "The new release reduced (or misconfigured) the payments-db connection pool. Roughly 30s after " +
        "rollout, charge/refund calls began timing out waiting for a free connection, which cascaded into " +
        "checkout timeouts and gateway 5xx responses for the affected fraction of requests.",
    },
    evidence,
    blast_radius: {
      affected_services: ["payments", "checkout", "gateway"],
      customer_impact:
        "Checkout attempts during the window had an elevated failure rate; browse/catalog and " +
        "notifications traffic were unaffected.",
    },
    confidence: {
      level: "high",
      why:
        "Regression onset lands consistently ~30s after the payments deploy across every affected " +
        "operation, and no other deploy or config change occurred in the window; the co-occurring " +
        "catalog deploy is a different, unaffected service.",
    },
    suggested_action:
      "Roll back payments to the prior release (or fix the connection-pool configuration in v3.0.0) " +
      "and re-deploy; monitor pool utilization before re-enabling full traffic.",
  };

  // `embedEvidence`'s own decoration rule: bake `.embedded` onto every entry with a non-null
  // `trace_id`, leave every other entry untouched.
  const embeddedReport: Report = {
    ...report,
    evidence: report.evidence.map((entry) => (entry.trace_id === null ? entry : { ...entry, embedded: embeddedTrace })),
  };

  const trigger = {
    statement:
      "payments error rate 24.1% (baseline 0.3%), p95 latency 578ms (baseline 92ms); sustained 3 consecutive minutes",
    fingerprints: ["payments:errors", "payments:latency", "checkout:errors"],
    detected_at_ms: openedAtMs,
  };

  // --- Tool call/result steps: real `agent/tools.ts` tool names, schema-shaped input, and
  // executor-shaped output (`agent/tools.ts`'s `runQueryMetrics`/`runListDeploys`/`runFindTraces`),
  // so a live investigation's steps and these seeded ones are structurally identical. -------------
  const onsetMinuteMs = Math.floor(onsetMs / 60_000) * 60_000;
  const normalMinuteMs = onsetMinuteMs - 5 * 60_000;
  const baselineOverlay = { error_rate: { median: 0.002, mad: 0.0005 }, p95: { median: 92, mad: 9 } };
  const metricPoints: MetricPoint[] = [
    {
      service: "payments",
      operation: "charge",
      minute_ts: normalMinuteMs,
      count: 640,
      error_rate: 0.002,
      p50: 41,
      p95: 92,
      p99: 130,
      baseline: baselineOverlay,
      delta: { error_rate: 1.0, p95: 1.0 },
    },
    {
      service: "payments",
      operation: "charge",
      minute_ts: onsetMinuteMs,
      count: 610,
      error_rate: 0.241,
      p50: 180,
      p95: 578,
      p99: 810,
      baseline: baselineOverlay,
      delta: { error_rate: 120.5, p95: 6.28 },
    },
  ];

  const paymentsDeploy: Deploy = { id: deployId, service: "payments", version: "v3.0.0", ts_ms: deployMs, note: "routine release" };
  // Fabricated-only (never inserted into `deploys`) — the narrative's "ruled out" red herring the
  // investigation's own note step below dismisses as unrelated.
  const catalogDeploy: Deploy = {
    id: "seed-deploy-catalog-fabricated",
    service: "catalog",
    version: "v1.8.2",
    ts_ms: deployMs + 90_000,
    note: "routine release",
  };

  const traceSummary: TraceSummary = {
    trace_id: SEED_TRACE_ID,
    entry_service: "gateway",
    entry_operation: "route_checkout",
    start_ms: traceStartMs,
    duration_ms: 3120,
    status: "error",
    span_count: 3,
  };

  const steps: StepSpec[] = [
    {
      kind: "note",
      offsetMs: 0,
      content: { text: "Investigation opened on fingerprints payments:errors, payments:latency, checkout:errors." },
      tokensIn: 0,
      tokensOut: 0,
    },
    {
      kind: "tool_call",
      offsetMs: 15_000,
      content: {
        tool_use_id: "seed-tool-1",
        name: "query_metrics",
        input: { service: "payments", operation: null, metrics: null, window: { from: "-15m", to: null }, step: null },
      },
      tokensIn: 1850,
      tokensOut: 62,
    },
    {
      kind: "tool_result",
      offsetMs: 16_000,
      content: {
        tool_use_id: "seed-tool-1",
        name: "query_metrics",
        output: { points: metricPoints, count: metricPoints.length, truncated: false },
        is_error: false,
      },
      tokensIn: 0,
      tokensOut: 0,
    },
    {
      kind: "tool_call",
      offsetMs: 45_000,
      content: { tool_use_id: "seed-tool-2", name: "list_deploys", input: { window: { from: "-30m", to: null } } },
      tokensIn: 2380,
      tokensOut: 54,
    },
    {
      kind: "tool_result",
      offsetMs: 46_000,
      content: {
        tool_use_id: "seed-tool-2",
        name: "list_deploys",
        output: { deploys: [paymentsDeploy, catalogDeploy], count: 2 },
        is_error: false,
      },
      tokensIn: 0,
      tokensOut: 0,
    },
    {
      kind: "tool_call",
      offsetMs: 75_000,
      content: {
        tool_use_id: "seed-tool-3",
        name: "find_traces",
        input: { service: "payments", window: { from: "-15m", to: null }, criteria: "errors", limit: 5 },
      },
      tokensIn: 2820,
      tokensOut: 71,
    },
    {
      kind: "tool_result",
      offsetMs: 76_000,
      content: {
        tool_use_id: "seed-tool-3",
        name: "find_traces",
        output: { traces: [traceSummary], count: 1, total: 1, truncated: false },
        is_error: false,
      },
      tokensIn: 0,
      tokensOut: 0,
    },
    {
      kind: "note",
      offsetMs: 95_000,
      content: {
        text:
          "Regression onset (deploy_ts+30s) matches the error/latency spike start; the catalog deploy is " +
          "unrelated (different service, unaffected error rate). Root cause: payments v3.0.0 connection-pool regression.",
      },
      tokensIn: 0,
      tokensOut: 0,
    },
    {
      // RAW report, matching `agent/loop.ts`'s `record("report", reportUse.input, ...)` — embedding
      // happens later, only in `incidents.report_json` (see `embeddedReport` above).
      kind: "report",
      offsetMs: reportedAtMs - openedAtMs,
      content: report,
      tokensIn: 3400,
      tokensOut: 740,
    },
  ];

  return { incidentId, deployId, deployMs, openedAtMs, reportedAtMs, resolvedAtMs, trigger, report, embeddedReport, steps };
}

export async function insertSeededIncident(db: D1Database, nowMs: number): Promise<void> {
  const story = buildSeedStory(nowMs);

  await db
    .prepare(`INSERT OR IGNORE INTO deploys (id, service, version, ts_ms, note) VALUES (?, ?, ?, ?, ?)`)
    .bind(story.deployId, "payments", "v3.0.0", story.deployMs, "routine release")
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO incidents (id, status, severity, opened_at, reported_at, resolved_at, trigger_json, report_json, follow_up_of)
       VALUES (?, 'resolved', 'critical', ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      story.incidentId,
      story.openedAtMs,
      story.reportedAtMs,
      story.resolvedAtMs,
      JSON.stringify(story.trigger),
      JSON.stringify(story.embeddedReport),
    )
    .run();

  const fingerprintStatements = story.trigger.fingerprints.map((fingerprint) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, 1)`,
      )
      .bind(story.incidentId, fingerprint, story.openedAtMs),
  );

  const stepStatements = story.steps.map((step, i) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO investigation_steps (incident_id, step_no, kind, content_json, ts_ms, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(story.incidentId, i + 1, step.kind, JSON.stringify(step.content), story.openedAtMs + step.offsetMs, step.tokensIn, step.tokensOut),
  );

  await db.batch([...fingerprintStatements, ...stepStatements]);
}
