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
 * Honesty calibration still applies to anything the agent could observe live (the deploy `note`),
 * but not to the report's own prose — the root-cause naming the deploy is the *agent's conclusion*
 * in a finished report, which spec §6 explicitly allows ("that's the AGENT's conclusion — allowed
 * and expected in a report; the honesty rule constrains telemetry, not reports").
 */

import { insertDeploy } from "../telemetry/queries";

/** Incident opens ~3h before reset time (task brief: "hand-authored resolved bad-deploy incident
 * ~3h before nowMs"). */
const INCIDENT_AGE_MS = 3 * 60 * 60 * 1000;

/** Deploy precedes "opened" by onset (30s, mirroring the live bad-deploy scenario's
 * `BAD_DEPLOY_ONSET_MS`) plus the time a sustained-rule detector needs to confirm the anomaly. */
const DETECTION_LAG_MS = 3 * 60_000;

const INVESTIGATION_DURATION_MS = 3 * 60_000;
const RESOLUTION_LAG_MS = 4 * 60_000;

interface StepSpec {
  kind: "tool_call" | "tool_result" | "note" | "report";
  offsetMs: number;
  content: unknown;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Builds the fingerprint set, timeline offsets, and report content for the seeded incident. Split
 * out from `insertSeededIncident` purely so the (fairly long) content literal doesn't crowd the
 * D1-facing insert logic.
 */
function buildStory(deployMs: number, openedAtMs: number, reportedAtMs: number, resolvedAtMs: number) {
  const onsetMs = deployMs + 30_000;

  const report = {
    summary:
      "A payments deploy (v3.0.0) triggered a connection-pool exhaustion regression starting ~30s " +
      "after rollout, degrading payments latency and reliability and cascading into checkout " +
      "timeouts and gateway 5xx responses for roughly six minutes before rollback.",
    timeline: [
      { ts_ms: deployMs, label: "payments v3.0.0 deployed" },
      { ts_ms: onsetMs, label: "payments error rate and p95 latency begin climbing" },
      { ts_ms: openedAtMs, label: "sustained anomaly crosses detection threshold; incident opened" },
      { ts_ms: openedAtMs + 60_000, label: "investigation correlates the deploy timestamp with the regression onset" },
      { ts_ms: reportedAtMs, label: "report submitted: payments deploy identified as root cause" },
      { ts_ms: resolvedAtMs, label: "payments rolled back; metrics recover; incident resolved" },
    ],
    root_cause: {
      hypothesis: "The payments v3.0.0 deploy introduced a database connection-pool regression under normal load.",
      mechanism:
        "The new release reduced (or misconfigured) the payments-db connection pool. Roughly 30s after " +
        "rollout, charge/refund calls began timing out waiting for a free connection, which cascaded into " +
        "checkout timeouts and gateway 5xx responses for the affected fraction of requests.",
    },
    evidence: [
      {
        type: "metric_delta",
        service: "payments",
        operation: "charge",
        metric: "error_rate",
        baseline: 0.002,
        observed: 0.241,
        window: "5m ending at incident open",
      },
      {
        type: "metric_delta",
        service: "payments",
        operation: "charge",
        metric: "p95_ms",
        baseline: 92,
        observed: 578,
        window: "5m ending at incident open",
      },
      {
        type: "metric_delta",
        service: "checkout",
        operation: "place_order",
        metric: "error_rate",
        baseline: 0.002,
        observed: 0.061,
        window: "5m ending at incident open",
      },
      {
        type: "deploy",
        service: "payments",
        version: "v3.0.0",
        ts_ms: deployMs,
        note: "routine release",
      },
      {
        type: "log",
        service: "payments-db",
        level: "error",
        message: "connection pool exhausted: 25/25 in use, acquire timeout 5000ms",
        ts_ms: onsetMs + 45_000,
      },
      {
        type: "trace",
        trace_id: "seed0bad0dep10y0000000000000001",
        summary:
          "gateway.route_checkout -> checkout.place_order -> payments.charge (error: pool_exhausted) " +
          "-> checkout (downstream error) -> gateway (downstream error)",
        spans: [
          { service: "gateway", operation: "route_checkout", status: "error", duration_ms: 3120 },
          { service: "checkout", operation: "place_order", status: "error", duration_ms: 3080 },
          { service: "payments", operation: "charge", status: "error", duration_ms: 3000 },
        ],
      },
    ],
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

  const trigger = {
    statement:
      "payments error rate 24.1% (baseline 0.3%), p95 latency 578ms (baseline 92ms); sustained 3 consecutive minutes",
    fingerprints: ["payments:errors", "payments:latency", "checkout:errors"],
    detected_at_ms: openedAtMs,
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
      content: { tool: "get_rollup_metrics", input: { service: "payments", window: "-15m" } },
      tokensIn: 1850,
      tokensOut: 62,
    },
    {
      kind: "tool_result",
      offsetMs: 16_000,
      content: {
        tool: "get_rollup_metrics",
        output: { summary: "error_rate and p95_ms both step-change upward starting ~5.5m ago", truncated: false },
      },
      tokensIn: 0,
      tokensOut: 0,
    },
    {
      kind: "tool_call",
      offsetMs: 45_000,
      content: { tool: "list_recent_deploys", input: { window: "-30m" } },
      tokensIn: 2380,
      tokensOut: 54,
    },
    {
      kind: "tool_result",
      offsetMs: 46_000,
      content: {
        tool: "list_recent_deploys",
        output: {
          deploys: [
            { service: "payments", version: "v3.0.0", ts_ms: deployMs },
            { service: "catalog", version: "v1.8.2", ts_ms: deployMs + 90_000 },
          ],
          truncated: false,
        },
      },
      tokensIn: 0,
      tokensOut: 0,
    },
    {
      kind: "tool_call",
      offsetMs: 75_000,
      content: { tool: "find_traces", input: { service: "payments", status: "error", window: "-15m", limit: 5 } },
      tokensIn: 2820,
      tokensOut: 71,
    },
    {
      kind: "tool_result",
      offsetMs: 76_000,
      content: {
        tool: "find_traces",
        output: {
          traces: [{ trace_id: "seed0bad0dep10y0000000000000001", status: "error" }],
          logExcerpt: "connection pool exhausted: 25/25 in use, acquire timeout 5000ms",
          truncated: false,
        },
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
      kind: "report",
      offsetMs: reportedAtMs - openedAtMs,
      content: report,
      tokensIn: 3400,
      tokensOut: 740,
    },
  ];

  return { report, trigger, steps };
}

export async function insertSeededIncident(db: D1Database, nowMs: number): Promise<void> {
  const openedAtMs = nowMs - INCIDENT_AGE_MS;
  const deployMs = openedAtMs - DETECTION_LAG_MS;
  const reportedAtMs = openedAtMs + INVESTIGATION_DURATION_MS;
  const resolvedAtMs = reportedAtMs + RESOLUTION_LAG_MS;

  const { report, trigger, steps } = buildStory(deployMs, openedAtMs, reportedAtMs, resolvedAtMs);

  await insertDeploy(db, {
    id: `seed-deploy-payments-${nowMs}`,
    service: "payments",
    version: "v3.0.0",
    ts_ms: deployMs,
    note: "routine release",
  });

  const incidentId = `seed-bad-deploy-${nowMs}`;
  await db
    .prepare(
      `INSERT INTO incidents (id, status, severity, opened_at, reported_at, resolved_at, trigger_json, report_json, follow_up_of)
       VALUES (?, 'resolved', 'critical', ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(incidentId, openedAtMs, reportedAtMs, resolvedAtMs, JSON.stringify(trigger), JSON.stringify(report))
    .run();

  const fingerprintStatements = ["payments:errors", "payments:latency", "checkout:errors"].map((fingerprint) =>
    db
      .prepare(
        `INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, 1)`,
      )
      .bind(incidentId, fingerprint, openedAtMs),
  );

  const stepStatements = steps.map((step, i) =>
    db
      .prepare(
        `INSERT INTO investigation_steps (incident_id, step_no, kind, content_json, ts_ms, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(incidentId, i + 1, step.kind, JSON.stringify(step.content), openedAtMs + step.offsetMs, step.tokensIn, step.tokensOut),
  );

  await db.batch([...fingerprintStatements, ...stepStatements]);
}
