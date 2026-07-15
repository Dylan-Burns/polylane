import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { insertDeploy, insertLogs, insertRollups, insertSpans } from "../../src/telemetry/queries";
import {
  findTraces,
  getIncidents,
  getTrace,
  listDeploys,
  queryMetrics,
  searchLogs,
} from "../../src/telemetry/read";
import type { LogLine, RollupRow, Span } from "../../src/telemetry/types";

// 14:00 UTC on a fixed date — minute-aligned AND a multiple of 120_000ms (2min), so the stepMin=2
// bucketing test's bucket boundary lands exactly on T0 with no extra arithmetic needed.
const T0 = Date.UTC(2026, 0, 5, 14, 0, 0);
const MIN = 60_000;

/**
 * Inserts one deterministic mini-world, once for the whole file (read functions never mutate
 * data, so — unlike `queries-insert.test.ts` — there's nothing to clean up between tests):
 *  - rollups: checkout across two consecutive minutes + payments for one minute (queryMetrics
 *    aggregation/bucketing fixture).
 *  - baselines: checkout only (payments deliberately has none — proves baseline/delta are
 *    omitted cleanly, not NaN, when the baselines table has no row for an entity).
 *  - five traces: a small error-cascade trace with an async (fire-and-forget) tail, a 90-span
 *    synthetic trace built to exercise the "collapse repeated healthy siblings" cap mechanism, a
 *    46-span all-distinct-leaves trace built to exercise the cap's defensive fallback trim, and
 *    two small healthy traces (different entry services) for findTraces exclusion/ordering.
 *  - logs linked to those traces (info + error), plus 60 unlinked noise logs for the searchLogs
 *    clamp test.
 *  - two deploys, two incidents (one resolved-with-report, one still open/no report).
 * Uses the EXISTING insert helpers (`insertSpans`/`insertLogs`/`insertRollups`/`insertDeploy`)
 * for the four tables that have them; `incidents`/`baselines` have no insert helper yet (Task 3.1
 * / Task 3.3 own those), so — mirroring `seed-incident.ts`'s own established pattern — those two
 * are seeded with direct, parameterized `db.prepare(...).run()` calls instead of hand-rolling the
 * tables that DO have a batch-insert helper.
 */
async function seedFixture(): Promise<void> {
  const rollups: RollupRow[] = [
    { service: "checkout", operation: "POST /checkout", minute_ts: T0, count: 100, error_count: 5, p50_ms: 40, p95_ms: 150, p99_ms: 250 },
    { service: "checkout", operation: "POST /checkout", minute_ts: T0 + MIN, count: 100, error_count: 3, p50_ms: 60, p95_ms: 170, p99_ms: 270 },
    { service: "payments", operation: "charge", minute_ts: T0, count: 80, error_count: 1, p50_ms: 30, p95_ms: 90, p99_ms: 140 },
  ];
  await insertRollups(env.DB, rollups);

  // Baselines: checkout only. Chosen so every delta in the T0-only tests is a clean integer
  // (req_rate median 50 -> 100/50=2; error_rate median 0.025 -> 0.05/0.025=2; p95 median 10 ->
  // 150/10=15) — the T0+MIN-minute and 2-min-bucket tests use non-integer deltas asserted with
  // `toBeCloseTo`.
  const baselineRows: Array<{ operation: string; metric: string; median: number; mad: number }> = [
    { operation: "POST /checkout", metric: "req_rate", median: 50, mad: 10 },
    { operation: "POST /checkout", metric: "error_rate", median: 0.025, mad: 0.01 },
    { operation: "POST /checkout", metric: "p95", median: 10, mad: 2 },
  ];
  await env.DB.batch(
    baselineRows.map((row) =>
      env.DB.prepare(
        "INSERT INTO baselines (service, operation, metric, median, mad, computed_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind("checkout", row.operation, row.metric, row.median, row.mad, T0),
    ),
  );

  // A dedicated (service, operation) pair with a zero-median baseline, isolated from the checkout
  // fixture above, purely to prove queryMetrics' delta ratio never produces NaN: 0-value-vs-0-
  // median is "no deviation" (0), nonzero-value-vs-0-median is an unbounded spike (Infinity) —
  // never 0/0's NaN.
  await insertRollups(env.DB, [
    { service: "catalog", operation: "zero_baseline_zero", minute_ts: T0 + 9 * MIN, count: 0, error_count: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0 },
    { service: "catalog", operation: "zero_baseline_nonzero", minute_ts: T0 + 9 * MIN, count: 10, error_count: 0, p50_ms: 5, p95_ms: 8, p99_ms: 9 },
  ]);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO baselines (service, operation, metric, median, mad, computed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("catalog", "zero_baseline_zero", "req_rate", 0, 0, T0),
    env.DB.prepare(
      "INSERT INTO baselines (service, operation, metric, median, mad, computed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("catalog", "zero_baseline_nonzero", "req_rate", 0, 0, T0),
  ]);

  // --- Trace A: error-cascade with an async (fire-and-forget) tail ---------------------------
  const cascadeRootStart = T0 + 5 * MIN;
  const cascadeSpans: Span[] = [
    {
      trace_id: "trace-cascade",
      span_id: "cascade-root",
      parent_span_id: null,
      service: "gateway",
      operation: "POST /checkout",
      start_ms: cascadeRootStart,
      duration_ms: 800,
      status: "error",
      error_type: "downstream",
    },
    {
      trace_id: "trace-cascade",
      span_id: "cascade-checkout",
      parent_span_id: "cascade-root",
      service: "checkout",
      operation: "POST /checkout",
      start_ms: cascadeRootStart + 5,
      duration_ms: 780,
      status: "error",
      error_type: "downstream",
    },
    {
      trace_id: "trace-cascade",
      span_id: "cascade-payments",
      parent_span_id: "cascade-checkout",
      service: "payments",
      operation: "charge",
      start_ms: cascadeRootStart + 15,
      duration_ms: 700,
      status: "error",
      error_type: "pool_exhausted",
    },
    // Fire-and-forget: spawned partway through `cascade-checkout` but its 2000ms duration ends
    // long after the root (and every synchronous ancestor) has already finished — the domain
    // caveat `getTrace` must not "fix" (see read.ts's `collapseTrace` doc comment).
    {
      trace_id: "trace-cascade",
      span_id: "cascade-notify",
      parent_span_id: "cascade-checkout",
      service: "notifications",
      operation: "send_receipt",
      start_ms: cascadeRootStart + 20,
      duration_ms: 2000,
      status: "ok",
      error_type: null,
    },
  ];
  const cascadeLogs: LogLine[] = [
    { ts_ms: cascadeRootStart, service: "gateway", level: "info", message: "POST /checkout request handled", trace_id: "trace-cascade", span_id: "cascade-root" },
    { ts_ms: cascadeRootStart + 20, service: "notifications", level: "info", message: "send_receipt request handled", trace_id: "trace-cascade", span_id: "cascade-notify" },
    { ts_ms: cascadeRootStart + 15 + 700, service: "payments", level: "error", message: "connection pool exhausted: 25/25 in use, acquire timeout 5000ms", trace_id: "trace-cascade", span_id: "cascade-payments" },
    { ts_ms: cascadeRootStart + 5 + 780, service: "checkout", level: "error", message: "downstream call to payments failed", trace_id: "trace-cascade", span_id: "cascade-checkout" },
    { ts_ms: cascadeRootStart + 800, service: "gateway", level: "error", message: "downstream call to checkout failed", trace_id: "trace-cascade", span_id: "cascade-root" },
  ];

  // --- Trace B: 90-span synthetic trace for the cap/collapse test ----------------------------
  const capRootStart = T0 + 10 * MIN;
  const capSpans: Span[] = [
    {
      trace_id: "trace-cap",
      span_id: "cap-root",
      parent_span_id: null,
      service: "gateway",
      operation: "GET /catalog",
      start_ms: capRootStart,
      duration_ms: 900,
      status: "error",
      error_type: "downstream",
    },
  ];
  for (let i = 0; i < 83; i++) {
    capSpans.push({
      trace_id: "trace-cap",
      span_id: `cap-list-${i}`,
      parent_span_id: "cap-root",
      service: "catalog",
      operation: "list_items",
      start_ms: capRootStart + 1 + i,
      duration_ms: 20,
      status: "ok",
      error_type: null,
    });
  }
  for (let i = 0; i < 4; i++) {
    capSpans.push({
      trace_id: "trace-cap",
      span_id: `cap-get-${i}`,
      parent_span_id: "cap-root",
      service: "catalog",
      operation: "get_item",
      start_ms: capRootStart + 100 + i,
      duration_ms: 15,
      status: "ok",
      error_type: null,
    });
  }
  capSpans.push(
    {
      trace_id: "trace-cap",
      span_id: "cap-checkout",
      parent_span_id: "cap-root",
      service: "checkout",
      operation: "POST /checkout",
      start_ms: capRootStart + 50,
      duration_ms: 800,
      status: "error",
      error_type: "downstream",
    },
    {
      trace_id: "trace-cap",
      span_id: "cap-payments",
      parent_span_id: "cap-checkout",
      service: "payments",
      operation: "charge",
      start_ms: capRootStart + 55,
      duration_ms: 700,
      status: "error",
      error_type: "pool_exhausted",
    },
  );
  expect(capSpans).toHaveLength(90); // fixture sanity: the brief calls for exactly 90 spans here.
  const capLogs: LogLine[] = [
    { ts_ms: capRootStart + 55 + 700, service: "payments", level: "error", message: "connection pool exhausted: 25/25 in use, acquire timeout 5000ms", trace_id: "trace-cap", span_id: "cap-payments" },
  ];

  // --- Trace C: 46 all-distinct-leaves trace, for the cap's defensive fallback trim -----------
  const fbRootStart = T0 + 20 * MIN;
  const fallbackSpans: Span[] = [
    {
      trace_id: "trace-fallback",
      span_id: "fb-root",
      parent_span_id: null,
      service: "gateway",
      operation: "GET /health",
      start_ms: fbRootStart,
      duration_ms: 50,
      status: "ok",
      error_type: null,
    },
  ];
  for (let i = 0; i < 45; i++) {
    fallbackSpans.push({
      trace_id: "trace-fallback",
      span_id: `fb-op-${i}`,
      parent_span_id: "fb-root",
      service: "catalog",
      // Every child has a *distinct* operation, so no sibling group ever reaches size >=2 —
      // nothing is collapsible, forcing getTrace's fallback trim path.
      operation: `op-${i}`,
      start_ms: fbRootStart + 1 + i,
      duration_ms: 5,
      status: "ok",
      error_type: null,
    });
  }
  expect(fallbackSpans).toHaveLength(46);

  // --- Traces D/E: small healthy traces, distinct entry services -----------------------------
  const healthySpans: Span[] = [
    {
      trace_id: "trace-healthy-a",
      span_id: "healthy-a-root",
      parent_span_id: null,
      service: "checkout",
      operation: "GET /cart",
      start_ms: T0 + 1 * MIN,
      duration_ms: 50,
      status: "ok",
      error_type: null,
    },
    {
      trace_id: "trace-healthy-b",
      span_id: "healthy-b-root",
      parent_span_id: null,
      service: "gateway",
      operation: "GET /catalog",
      start_ms: T0 + 2 * MIN,
      duration_ms: 120,
      status: "ok",
      error_type: null,
    },
  ];

  // --- Trace F: wide-but-deep ok fan-out forcing the subtree-drop pass ------------------------
  // 4 branches x 13-deep chains of ok spans-with-children (52 spans, only the last node per chain
  // is a true leaf) + a 3-span error path (root -> mid -> leaf), for 55 spans total. Leaf-collapse
  // can't touch any of the 48 internal (has-children) nodes, and leaf-trim can only drop the 4
  // true leaves — nowhere near enough to reach the 40 cap alone — so this only passes if the new
  // subtree-drop pass (step 3) kicks in. Placed well outside every other suite's shared time
  // window (T0..T0+30*MIN) so it can't perturb findTraces/searchLogs/listDeploys/getIncidents
  // assertions that scan by window rather than by trace_id.
  const wfRootStart = T0 + 40 * MIN;
  const wideFanoutSpans: Span[] = [
    {
      trace_id: "trace-wide-fanout",
      span_id: "wf-root",
      parent_span_id: null,
      service: "gateway",
      operation: "POST /checkout",
      start_ms: wfRootStart,
      duration_ms: 900,
      status: "error",
      error_type: "downstream",
    },
    {
      trace_id: "trace-wide-fanout",
      span_id: "wf-error-mid",
      parent_span_id: "wf-root",
      service: "checkout",
      operation: "POST /checkout",
      start_ms: wfRootStart + 1,
      duration_ms: 800,
      status: "error",
      error_type: "downstream",
    },
    {
      trace_id: "trace-wide-fanout",
      span_id: "wf-error-leaf",
      parent_span_id: "wf-error-mid",
      service: "payments",
      operation: "charge",
      start_ms: wfRootStart + 2,
      duration_ms: 700,
      status: "error",
      error_type: "pool_exhausted",
    },
  ];
  const WF_BRANCHES = 4;
  const WF_DEPTH = 13;
  for (let b = 0; b < WF_BRANCHES; b++) {
    for (let d = 0; d < WF_DEPTH; d++) {
      const isLeaf = d === WF_DEPTH - 1;
      wideFanoutSpans.push({
        trace_id: "trace-wide-fanout",
        span_id: `wf-b${b}-${d}`,
        parent_span_id: d === 0 ? "wf-root" : `wf-b${b}-${d - 1}`,
        service: "catalog",
        // Every node's parent_span_id is unique to its own branch/depth, so leaf-collapse's
        // (parent_span_id, service, operation) grouping never finds >=2 siblings to collapse —
        // this fixture is only reachable/testable via the subtree-drop pass.
        operation: isLeaf ? "get_item" : `fanout_step_${d}`,
        start_ms: wfRootStart + 10 + b * WF_DEPTH + d,
        duration_ms: 5,
        status: "ok",
        error_type: null,
      });
    }
  }
  expect(wideFanoutSpans).toHaveLength(3 + WF_BRANCHES * WF_DEPTH); // 55

  // --- Trace G: 45-span straight chain, leaf is the error (all 45 are error-path ancestors) ---
  // Exercises getTrace's documented exception: mustKeep (every ancestor of the error, here the
  // entire chain) already exceeds MAX_TRACE_SPANS on its own, so all 45 must still be returned.
  const chainRootStart = T0 + 45 * MIN;
  const CHAIN_LEN = 45;
  const errorChainSpans: Span[] = Array.from({ length: CHAIN_LEN }, (_, i) => ({
    trace_id: "trace-long-error-chain",
    span_id: `chain-${i}`,
    parent_span_id: i === 0 ? null : `chain-${i - 1}`,
    service: "catalog",
    operation: `step_${i}`,
    start_ms: chainRootStart + i,
    duration_ms: 5,
    status: i === CHAIN_LEN - 1 ? "error" : "ok",
    error_type: i === CHAIN_LEN - 1 ? "downstream" : null,
  }));

  await insertSpans(env.DB, [
    ...cascadeSpans,
    ...capSpans,
    ...fallbackSpans,
    ...healthySpans,
    ...wideFanoutSpans,
    ...errorChainSpans,
  ]);

  const noiseLogs: LogLine[] = Array.from({ length: 60 }, (_, i) => ({
    ts_ms: T0 + i * 1000,
    service: "catalog",
    level: "info" as const,
    message: `noise log ${i}`,
  }));
  await insertLogs(env.DB, [...cascadeLogs, ...capLogs, ...noiseLogs]);

  await insertDeploy(env.DB, { id: "deploy-1", service: "payments", version: "v2.4.1", ts_ms: T0 - 10 * MIN, note: "bump payment provider SDK" });
  await insertDeploy(env.DB, { id: "deploy-2", service: "catalog", version: "v1.8.3", ts_ms: T0 + 3 * MIN, note: "routine release" });

  const resolvedTrigger = { statement: "checkout error_rate 22% vs baseline 0.4% since 14:32Z", fingerprints: ["checkout:errors"] };
  const resolvedReport = { summary: "Bad deploy caused checkout errors.", root_cause: { hypothesis: "connection pool exhaustion" } };
  const openTrigger = { statement: "payments p95 8x baseline", fingerprints: ["payments:latency"] };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO incidents (id, status, severity, opened_at, reported_at, resolved_at, trigger_json, report_json, follow_up_of) VALUES (?, 'resolved', 'critical', ?, ?, ?, ?, ?, NULL)",
    ).bind("incident-resolved-1", T0 - 2 * MIN, T0 - 1 * MIN, T0, JSON.stringify(resolvedTrigger), JSON.stringify(resolvedReport)),
    env.DB.prepare(
      "INSERT INTO incidents (id, status, severity, opened_at, reported_at, resolved_at, trigger_json, report_json, follow_up_of) VALUES (?, 'investigating', 'warning', ?, NULL, NULL, ?, NULL, NULL)",
    ).bind("incident-open-1", T0 + 15 * MIN, JSON.stringify(openTrigger)),
  ]);

  // Two fingerprints on the resolved incident (out of insertion/first_seen_ms order below, so the
  // oldest-first assertion actually exercises the ORDER BY rather than passing by accident), one
  // on the open incident.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, ?)",
    ).bind("incident-resolved-1", "payments:latency", T0 - 2 * MIN + 30_000, 1),
    env.DB.prepare(
      "INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, ?)",
    ).bind("incident-resolved-1", "checkout:errors", T0 - 2 * MIN, 1),
    env.DB.prepare(
      "INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, ?)",
    ).bind("incident-open-1", "payments:latency", T0 + 15 * MIN, 1),
  ]);
}

beforeAll(async () => {
  await seedFixture();
});

describe("queryMetrics", () => {
  it("maps a single rollup minute 1:1 with error_rate computed and baseline+delta attached", async () => {
    const points = await queryMetrics(env.DB, { fromMs: T0, toMs: T0 + MIN, stepMin: 1 });
    expect(points).toHaveLength(2); // checkout + payments, both have a T0 row; sorted service asc

    expect(points[0]).toEqual({
      service: "checkout",
      operation: "POST /checkout",
      minute_ts: T0,
      count: 100,
      error_rate: 0.05,
      p50: 40,
      p95: 150,
      p99: 250,
      baseline: {
        req_rate: { median: 50, mad: 10 },
        error_rate: { median: 0.025, mad: 0.01 },
        p95: { median: 10, mad: 2 },
      },
      delta: { req_rate: 2, error_rate: 2, p95: 15 },
    });

    // payments has no baseline rows at all — the fields must be absent, not `{}`/NaN.
    expect(points[1]).toEqual({
      service: "payments",
      operation: "charge",
      minute_ts: T0,
      count: 80,
      error_rate: 0.0125,
      p50: 30,
      p95: 90,
      p99: 140,
    });
    expect(points[1]?.baseline).toBeUndefined();
    expect(points[1]?.delta).toBeUndefined();
  });

  it("computes the second checkout minute's aggregates and non-integer deltas", async () => {
    const points = await queryMetrics(env.DB, { fromMs: T0 + MIN, toMs: T0 + 2 * MIN, stepMin: 1 });
    expect(points).toHaveLength(1); // payments has no row at T0+MIN

    const p = points[0];
    expect(p?.count).toBe(100);
    expect(p?.error_rate).toBeCloseTo(0.03);
    expect(p?.p50).toBe(60);
    expect(p?.p95).toBe(170);
    expect(p?.p99).toBe(270);
    expect(p?.baseline).toEqual({
      req_rate: { median: 50, mad: 10 },
      error_rate: { median: 0.025, mad: 0.01 },
      p95: { median: 10, mad: 2 },
    });
    expect(p?.delta?.req_rate).toBeCloseTo(2);
    expect(p?.delta?.error_rate).toBeCloseTo(1.2);
    expect(p?.delta?.p95).toBeCloseTo(17);
  });

  it("bucketing (stepMin=2) sums counts and count-weights p50/p95/p99 across both checkout minutes", async () => {
    const points = await queryMetrics(env.DB, { fromMs: T0, toMs: T0 + 2 * MIN, stepMin: 2 });
    expect(points).toHaveLength(2);

    const checkout = points.find((p) => p.service === "checkout");
    expect(checkout).toBeDefined();
    expect(checkout?.minute_ts).toBe(T0); // epoch-aligned bucket start
    expect(checkout?.count).toBe(200);
    expect(checkout?.error_rate).toBeCloseTo(0.04); // (5+3)/200
    expect(checkout?.p50).toBe(50); // (40*100 + 60*100) / 200
    expect(checkout?.p95).toBe(160); // (150*100 + 170*100) / 200
    expect(checkout?.p99).toBe(260); // (250*100 + 270*100) / 200
    expect(checkout?.delta?.req_rate).toBe(4); // 200/50
    expect(checkout?.delta?.error_rate).toBeCloseTo(1.6); // 0.04/0.025
    expect(checkout?.delta?.p95).toBe(16); // 160/10

    const payments = points.find((p) => p.service === "payments");
    expect(payments).toBeDefined();
    expect(payments?.count).toBe(80); // only one contributing minute in this bucket
    expect(payments?.baseline).toBeUndefined();
  });

  it("filters by service", async () => {
    const points = await queryMetrics(env.DB, { service: "payments", fromMs: T0, toMs: T0 + 2 * MIN, stepMin: 1 });
    expect(points).toHaveLength(1);
    expect(points[0]?.service).toBe("payments");
  });

  it("filters by operation", async () => {
    const points = await queryMetrics(env.DB, { operation: "charge", fromMs: T0, toMs: T0 + 2 * MIN, stepMin: 1 });
    expect(points).toHaveLength(1);
    expect(points[0]?.operation).toBe("charge");
  });

  it("returns an empty array for a window with no rollups", async () => {
    const points = await queryMetrics(env.DB, { fromMs: T0 - 100 * MIN, toMs: T0 - 90 * MIN, stepMin: 1 });
    expect(points).toEqual([]);
  });

  it("never produces NaN when a baseline's median is 0 — 0-vs-0 is 0, nonzero-vs-0 is Infinity", async () => {
    const points = await queryMetrics(env.DB, {
      service: "catalog",
      fromMs: T0 + 9 * MIN,
      toMs: T0 + 9 * MIN + MIN,
      stepMin: 1,
    });
    const zero = points.find((p) => p.operation === "zero_baseline_zero");
    const nonzero = points.find((p) => p.operation === "zero_baseline_nonzero");
    expect(zero?.delta?.req_rate).toBe(0);
    expect(nonzero?.delta?.req_rate).toBe(Infinity);
    for (const p of points) {
      expect(Number.isNaN(p.delta?.req_rate)).toBe(false);
    }
  });
});

describe("searchLogs", () => {
  it("matches on contains (substring), newest first", async () => {
    const logs = await searchLogs(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN, contains: "pool exhausted" });
    expect(logs).toHaveLength(2);
    // cap-trace's payments log (ts = capRootStart+55+700) is newer than cascade-trace's
    // (ts = cascadeRootStart+15+700) since capRootStart > cascadeRootStart.
    expect(logs[0]?.trace_id).toBe("trace-cap");
    expect(logs[1]?.trace_id).toBe("trace-cascade");
    for (const log of logs) {
      expect(log.level).toBe("error");
      expect(log.message).toContain("pool exhausted");
    }
  });

  it("filters by service and level", async () => {
    const logs = await searchLogs(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN, service: "checkout", level: "error" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.span_id).toBe("cascade-checkout");
  });

  it("excludes non-matching levels/services", async () => {
    const logs = await searchLogs(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN, service: "notifications" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("info");
  });

  it("clamps limit to 50 by default, and to an explicit lower value", async () => {
    const defaulted = await searchLogs(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN, service: "catalog", level: "info" });
    expect(defaulted).toHaveLength(50); // 60 noise logs match; clamp caps it at 50

    const oversized = await searchLogs(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN, service: "catalog", level: "info", limit: 1000 });
    expect(oversized).toHaveLength(50);

    const small = await searchLogs(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN, service: "catalog", level: "info", limit: 5 });
    expect(small).toHaveLength(5);
  });

  it("falls back to the default limit (50) when `limit` is NaN, rather than propagating NaN into the query", async () => {
    // `args.limit ?? 50` doesn't catch this: NaN isn't nullish, so an explicit NaN limit would
    // otherwise flow straight into `clampInt` and then the bound SQL parameter.
    const logs = await searchLogs(env.DB, {
      fromMs: T0,
      toMs: T0 + 30 * MIN,
      service: "catalog",
      level: "info",
      limit: Number.NaN,
    });
    expect(logs).toHaveLength(50);
  });
});

describe("findTraces", () => {
  it("criteria 'errors' returns only traces containing an error span, newest first, with entry service/op and span_count", async () => {
    const traces = await findTraces(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN, criteria: "errors" });
    expect(traces.map((t) => t.trace_id)).toEqual(["trace-cap", "trace-cascade"]);
    expect(traces.map((t) => t.entry_service)).toEqual(["gateway", "gateway"]);
    expect(traces.map((t) => t.entry_operation)).toEqual(["GET /catalog", "POST /checkout"]);
    expect(traces.map((t) => t.span_count)).toEqual([90, 4]); // full persisted span count, not the capped getTrace view
    for (const t of traces) expect(t.status).toBe("error");
  });

  it("criteria 'errors' with a service filter that has no error traces returns []", async () => {
    const traces = await findTraces(env.DB, { service: "checkout", fromMs: T0, toMs: T0 + 30 * MIN, criteria: "errors" });
    expect(traces).toEqual([]); // trace-healthy-a enters via checkout but is fully ok
  });

  it("criteria 'slowest' sorts by the root span's own duration, filtered to a service", async () => {
    const traces = await findTraces(env.DB, { service: "gateway", fromMs: T0, toMs: T0 + 30 * MIN, criteria: "slowest" });
    expect(traces.map((t) => t.trace_id)).toEqual(["trace-cap", "trace-cascade", "trace-healthy-b", "trace-fallback"]);
    expect(traces.map((t) => t.duration_ms)).toEqual([900, 800, 120, 50]);
    expect(traces.map((t) => t.span_count)).toEqual([90, 4, 1, 46]);
  });

  it("clamps limit to 10 by default and to an explicit lower value", async () => {
    const limited = await findTraces(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN, criteria: "slowest", limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((t) => t.trace_id)).toEqual(["trace-cap", "trace-cascade"]);
  });

  it("reports the entry span's duration, not a max(end)-min(start) span (would be inflated by the async tail)", async () => {
    const traces = await findTraces(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN, criteria: "errors" });
    const cascade = traces.find((t) => t.trace_id === "trace-cascade");
    expect(cascade?.duration_ms).toBe(800); // root's own duration; the async tail runs to +2000ms past root start
  });
});

describe("getTrace", () => {
  it("returns every span untouched for a trace under the cap, preserving the async-tail domain caveat", async () => {
    const result = await getTrace(env.DB, "trace-cascade");
    expect(result.truncated).toBe(false);
    expect(result.note).toBeUndefined();
    expect(result.spans.map((s) => s.span_id)).toEqual(["cascade-root", "cascade-checkout", "cascade-payments", "cascade-notify"]);

    const root = result.spans.find((s) => s.span_id === "cascade-root");
    const notify = result.spans.find((s) => s.span_id === "cascade-notify");
    expect(root).toBeDefined();
    expect(notify).toBeDefined();
    // The async span ends well after its (grand)parent root — legitimate fire-and-forget
    // semantics, not something getTrace should reject or reorder away.
    expect((notify?.start_ms ?? 0) + (notify?.duration_ms ?? 0)).toBeGreaterThan((root?.start_ms ?? 0) + (root?.duration_ms ?? 0));
    expect(notify?.status).toBe("ok");

    expect(result.errorLogs.map((l) => l.span_id)).toEqual(["cascade-payments", "cascade-checkout", "cascade-root"]);
    for (const log of result.errorLogs) expect(log.level).toBe("error");
  });

  it("caps a 90-span trace to <=40, collapsing repeated healthy siblings while keeping the full error path root->leaf intact", async () => {
    const result = await getTrace(env.DB, "trace-cap");
    expect(result.truncated).toBe(true);
    expect(result.spans.length).toBeLessThanOrEqual(40);
    expect(result.spans).toHaveLength(5); // root + checkout + payments (error path) + 2 collapse markers

    const byId = new Map(result.spans.map((s) => [s.span_id, s]));
    expect(byId.get("cap-root")?.status).toBe("error");
    expect(byId.get("cap-checkout")?.status).toBe("error");
    expect(byId.get("cap-payments")?.status).toBe("error");
    expect(byId.get("cap-payments")?.error_type).toBe("pool_exhausted");

    // None of the collapsed originals survive individually.
    expect(byId.has("cap-list-0")).toBe(false);
    expect(byId.has("cap-get-0")).toBe(false);

    const markerOps = result.spans
      .filter((s) => s.operation.includes("similar ok spans"))
      .map((s) => s.operation)
      .sort();
    expect(markerOps).toEqual(["…4 similar ok spans", "…83 similar ok spans"]);
    for (const s of result.spans) {
      if (s.operation.includes("similar ok spans")) {
        expect(s.status).toBe("ok");
        expect(s.parent_span_id).toBe("cap-root");
      }
    }

    expect(result.errorLogs).toHaveLength(1);
    expect(result.errorLogs[0]?.span_id).toBe("cap-payments");

    expect(result.note).toContain("90");
    expect(result.note).toContain("5");
  });

  it("falls back to dropping the earliest leaves when nothing is collapsible (no repeated siblings)", async () => {
    const result = await getTrace(env.DB, "trace-fallback");
    expect(result.truncated).toBe(true);
    expect(result.spans).toHaveLength(40);

    const ids = new Set(result.spans.map((s) => s.span_id));
    expect(ids.has("fb-root")).toBe(true); // the parent is never dropped (would orphan survivors)
    for (let i = 0; i < 6; i++) expect(ids.has(`fb-op-${i}`)).toBe(false); // earliest-starting, dropped
    for (let i = 6; i < 45; i++) expect(ids.has(`fb-op-${i}`)).toBe(true); // the rest survive
  });

  it("returns an empty, non-truncated view for an unknown trace id", async () => {
    const result = await getTrace(env.DB, "does-not-exist");
    expect(result).toEqual({ spans: [], errorLogs: [], truncated: false });
  });
});

describe("listDeploys", () => {
  it("returns deploys within the window, chronological ascending", async () => {
    const deploys = await listDeploys(env.DB, { fromMs: T0 - 15 * MIN, toMs: T0 + 30 * MIN });
    expect(deploys.map((d) => d.id)).toEqual(["deploy-1", "deploy-2"]);
  });

  it("excludes deploys before fromMs (half-open window)", async () => {
    const deploys = await listDeploys(env.DB, { fromMs: T0, toMs: T0 + 30 * MIN });
    expect(deploys.map((d) => d.id)).toEqual(["deploy-2"]);
  });
});

describe("getIncidents", () => {
  it("by id returns a single-element array with report/trigger parsed and fingerprints oldest-first", async () => {
    const incidents = await getIncidents(env.DB, { id: "incident-resolved-1" });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      id: "incident-resolved-1",
      status: "resolved",
      severity: "critical",
      trigger: { statement: "checkout error_rate 22% vs baseline 0.4% since 14:32Z", fingerprints: ["checkout:errors"] },
      report: { summary: "Bad deploy caused checkout errors.", root_cause: { hypothesis: "connection pool exhaustion" } },
    });
    // Inserted payments:latency (later first_seen_ms) before checkout:errors (earlier) above —
    // this ordering only passes if getIncidents sorts by first_seen_ms, not insertion order.
    expect(incidents[0]?.fingerprints).toEqual(["checkout:errors", "payments:latency"]);
  });

  it("by id returns [] for an unknown id", async () => {
    const incidents = await getIncidents(env.DB, { id: "does-not-exist" });
    expect(incidents).toEqual([]);
  });

  it("by window returns matching incidents newest first, report null when absent, fingerprints attached", async () => {
    const incidents = await getIncidents(env.DB, { fromMs: T0 - 5 * MIN, toMs: T0 + 30 * MIN });
    expect(incidents.map((i) => i.id)).toEqual(["incident-open-1", "incident-resolved-1"]);
    expect(incidents[0]?.report).toBeNull();
    expect(incidents[0]?.status).toBe("investigating");
    expect(incidents[0]?.fingerprints).toEqual(["payments:latency"]);
    expect(incidents[1]?.report).not.toBeNull();
    expect(incidents[1]?.fingerprints).toEqual(["checkout:errors", "payments:latency"]);
  });
});
