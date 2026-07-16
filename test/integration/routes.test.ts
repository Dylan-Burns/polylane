import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { IncidentMetricsResponse } from "../../src/api/routes";
import { insertInvestigationStep } from "../../src/telemetry/incidents";
import { insertDeploy, insertLogs, insertRollups, insertSpans } from "../../src/telemetry/queries";
import type { StepView } from "../../src/telemetry/read";
import type { AnalyticsResponse } from "../../src/telemetry/state";
import type { Deploy, IncidentView, LogLine, Span } from "../../src/telemetry/types";

/** Confirms the actual HTTP wiring in `src/api/routes.ts` (mounted at `/api` from `index.ts`) --
 * `serviceHealth`/`sparklineSeries`/`getOpsHealth`/`buildTopology` themselves are unit-tested in
 * `test/unit/state.test.ts`; this file only proves the routes are reachable, shaped correctly, and
 * handle the HTTP-specific concerns (query params, 404s, bad windows) those unit tests can't. */

afterEach(async () => {
  for (const table of ["spans", "logs", "rollups", "deploys", "incident_fingerprints", "investigation_steps", "incidents", "baselines", "meta"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("GET /api/state", () => {
  it("returns topology, health, sparklines, worldStatus, and opsHealth", async () => {
    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
      await state.storage.put("generation", 1);
    });

    const res = await SELF.fetch("https://example.com/api/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      topology: { services: { name: string }[]; edges: [string, string][] };
      health: Record<string, string>;
      sparklines: Record<string, unknown[]>;
      worldStatus: { worldStatus: string; fault: unknown; generation: number };
      opsHealth: { lastSweepOkMs?: number; retentionWatermarkAgeMs?: number };
    };

    expect(body.topology.services.map((s) => s.name)).toContain("gateway");
    expect(body.topology.edges.length).toBeGreaterThan(0);
    expect(body.health.gateway).toBe("green"); // steady fixture, no incidents/rollups seeded
    expect(body.sparklines).toEqual({}); // no rollups seeded in this test
    expect(body.worldStatus.worldStatus).toBe("running");
    expect(body.opsHealth.lastSweepOkMs).toBeUndefined(); // sweep never ran in this test
  });

  it("falls back to 'unseeded' worldStatus when SimulatorDO is unreachable, without ever 500ing", async () => {
    // Explicit reset: the shared 'world' SimulatorDO singleton's storage otherwise carries over
    // from the previous test in this file (which sets it to 'running'). No worldStatus written
    // at all -> SimulatorDO's own /status handler defaults to 'unseeded' (not truly a DO failure,
    // but exercises the same fallback path GET /api/state relies on for a real one).
    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.deleteAll();
    });

    const res = await SELF.fetch("https://example.com/api/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { worldStatus: { worldStatus: string } };
    expect(body.worldStatus.worldStatus).toBe("unseeded");
  });
});

describe("GET /api/incidents", () => {
  async function seedIncident(id: string, openedAt: number, status = "open"): Promise<void> {
    await env.DB
      .prepare("INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES (?, ?, 'warning', ?, '{}')")
      .bind(id, status, openedAt)
      .run();
  }

  it("defaults to the last 24h, recent first, with the {incidents, total} envelope", async () => {
    const now = Date.now();
    await seedIncident("inc-recent", now - 60 * 60_000); // 1h ago -- in the default window
    await seedIncident("inc-older", now - 2 * 60 * 60_000); // 2h ago -- also in
    await seedIncident("inc-ancient", now - 48 * 60 * 60_000); // 48h ago -- outside the 24h default

    const res = await SELF.fetch("https://example.com/api/incidents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidents: IncidentView[]; total: number };
    expect(body.incidents.map((i) => i.id)).toEqual(["inc-recent", "inc-older"]); // newest first
    expect(body.total).toBe(2);
  });

  it("honors explicit from/to query params via parseWindow", async () => {
    const now = Date.now();
    await seedIncident("inc-in-window", now - 30 * 60_000);
    await seedIncident("inc-out-of-window", now - 3 * 60 * 60_000);

    const res = await SELF.fetch("https://example.com/api/incidents?from=-1h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidents: IncidentView[]; total: number };
    expect(body.incidents.map((i) => i.id)).toEqual(["inc-in-window"]);
    expect(body.total).toBe(1);
  });

  it("400s an unparseable window bound", async () => {
    const res = await SELF.fetch("https://example.com/api/incidents?from=yesterday-ish");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("neither an ISO-8601 timestamp nor a relative offset");
  });
});

describe("GET /api/incidents/:id", () => {
  it("returns {incident, steps} with steps ordered by step_no and content parsed", async () => {
    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES ('inc-detail', 'investigating', 'critical', 1000, ?)",
        )
        .bind(JSON.stringify({ statements: ["payments error_rate 30.0% vs baseline 1.0% (hard trip) since 14:00Z"] })),
      env.DB
        .prepare("INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES ('inc-detail', 'payments:errors', 1000, 1)"),
    ]);
    // Inserted out of step_no order (1 before 0) so the ordering assertion exercises the ORDER BY.
    await insertInvestigationStep(env.DB, {
      incidentId: "inc-detail",
      stepNo: 1,
      kind: "tool_call",
      contentJson: JSON.stringify({ name: "query_metrics", input: { service: "payments" } }),
      tsMs: 2500,
      tokensIn: 1100,
      tokensOut: 60,
    });
    await insertInvestigationStep(env.DB, {
      incidentId: "inc-detail",
      stepNo: 0,
      kind: "note",
      contentJson: JSON.stringify({ note: "investigation started" }),
      tsMs: 2000,
      tokensIn: 0,
      tokensOut: 0,
    });

    const res = await SELF.fetch("https://example.com/api/incidents/inc-detail");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incident: IncidentView; steps: StepView[] };

    expect(body.incident.id).toBe("inc-detail");
    expect(body.incident.status).toBe("investigating");
    expect(body.incident.fingerprints).toEqual(["payments:errors"]);
    expect(body.incident.trigger).toEqual({ statements: ["payments error_rate 30.0% vs baseline 1.0% (hard trip) since 14:00Z"] });

    expect(body.steps.map((s) => s.step_no)).toEqual([0, 1]);
    expect(body.steps[0]?.content).toEqual({ note: "investigation started" }); // parsed, not a raw string
    expect(body.steps[1]?.content).toEqual({ name: "query_metrics", input: { service: "payments" } });
    expect(body.steps[1]?.tokens_in).toBe(1100);
    expect(body.steps[1]?.tokens_out).toBe(60);
  });

  it("returns an empty steps array for an incident with no investigation steps yet", async () => {
    await env.DB
      .prepare("INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES ('inc-stepless', 'open', 'warning', 1000, '{}')")
      .run();

    const res = await SELF.fetch("https://example.com/api/incidents/inc-stepless");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incident: IncidentView; steps: StepView[] };
    expect(body.incident.id).toBe("inc-stepless");
    expect(body.steps).toEqual([]);
  });

  it("404s an unknown incident id", async () => {
    const res = await SELF.fetch("https://example.com/api/incidents/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /api/traces/:id", () => {
  it("returns the trace view for a known trace_id", async () => {
    const span: Span = {
      trace_id: "trace-route-test",
      span_id: "root",
      parent_span_id: null,
      service: "gateway",
      operation: "GET /health",
      start_ms: 1_000,
      duration_ms: 5,
      status: "ok",
      error_type: null,
    };
    await insertSpans(env.DB, [span]);

    const res = await SELF.fetch("https://example.com/api/traces/trace-route-test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spans: Span[]; truncated: boolean };
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0]?.span_id).toBe("root");
    expect(body.truncated).toBe(false);
  });

  it("404s an unknown trace_id", async () => {
    const res = await SELF.fetch("https://example.com/api/traces/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /api/logs", () => {
  it("filters by service/level/contains and returns the {logs, total} envelope", async () => {
    const logs: LogLine[] = [
      { ts_ms: 10_000, service: "checkout", level: "error", message: "cart lookup failed: session state missing" },
      { ts_ms: 11_000, service: "checkout", level: "info", message: "GET /cart request handled" },
      { ts_ms: 12_000, service: "payments", level: "error", message: "payment authorization failed" },
    ];
    await insertLogs(env.DB, logs);

    const res = await SELF.fetch(
      `https://example.com/api/logs?service=checkout&level=error&from=${encodeURIComponent(new Date(0).toISOString())}&to=${encodeURIComponent(new Date(20_000).toISOString())}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: LogLine[]; total: number };
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.message).toContain("cart lookup failed");
    expect(body.total).toBe(1);
  });

  it("400s an invalid level query param", async () => {
    const res = await SELF.fetch("https://example.com/api/logs?level=critical");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_level" });
  });

  it("400s a degenerate window (from === to)", async () => {
    const iso = new Date(5000).toISOString();
    const res = await SELF.fetch(`https://example.com/api/logs?from=${encodeURIComponent(iso)}&to=${encodeURIComponent(iso)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("window is empty");
  });

  it("clamps an oversized limit to the default cap", async () => {
    const logs: LogLine[] = Array.from({ length: 60 }, (_, i) => ({
      ts_ms: 1000 + i,
      service: "catalog",
      level: "info" as const,
      message: `noise ${i}`,
    }));
    await insertLogs(env.DB, logs);

    const res = await SELF.fetch(
      `https://example.com/api/logs?service=catalog&limit=1000&from=${encodeURIComponent(new Date(0).toISOString())}&to=${encodeURIComponent(new Date(60_000).toISOString())}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: LogLine[]; total: number };
    expect(body.logs).toHaveLength(50);
    expect(body.total).toBe(60);
  });
});

describe("GET /api/health (moved into api/routes.ts)", () => {
  it("still responds as before", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("GET /api/analytics", () => {
  async function seedIncident(
    id: string,
    status: IncidentView["status"],
    openedAt: number,
    reportedAt: number | null,
    resolvedAt: number | null,
  ): Promise<void> {
    await env.DB
      .prepare(
        "INSERT INTO incidents (id, status, severity, opened_at, reported_at, resolved_at, trigger_json) VALUES (?, ?, 'warning', ?, ?, ?, '{}')",
      )
      .bind(id, status, openedAt, reportedAt, resolvedAt)
      .run();
  }

  it("returns zero counts and null medians/traffic on an empty DB", async () => {
    const res = await SELF.fetch("https://example.com/api/analytics");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      incidents24h: 0,
      openNow: 0,
      timeToReportP50Ms: null,
      timeToResolveP50Ms: null,
      reqPerMin: null,
      errorRatePct: null,
    });
  });

  it("computes counts, medians, and latest-minute traffic from seeded rows", async () => {
    const now = Date.now();
    // Three incidents inside the 24h count window; the 48h-old one falls outside it but still
    // inside the 7d median window -- the two lookbacks are deliberately different.
    await seedIncident("inc-a", "resolved", now - 2 * 3_600_000, now - 2 * 3_600_000 + 60_000, now - 2 * 3_600_000 + 300_000);
    await seedIncident("inc-b", "reported", now - 3_600_000, now - 3_600_000 + 180_000, null);
    await seedIncident("inc-c", "open", now - 30 * 60_000, null, null);
    await seedIncident("inc-old", "resolved", now - 48 * 3_600_000, now - 48 * 3_600_000 + 500_000, now - 48 * 3_600_000 + 700_000);

    // Two rollup minutes; only the newest one drives reqPerMin/errorRatePct (the older, busier
    // minute proves the anchor is latestRollupMinute, not a sum over the window).
    const minute = Math.floor(now / 60_000) * 60_000;
    await insertRollups(env.DB, [
      { service: "gateway", operation: "GET /", minute_ts: minute - 60_000, count: 500, error_count: 50, p50_ms: 10, p95_ms: 20, p99_ms: 30 },
      { service: "gateway", operation: "GET /", minute_ts: minute, count: 60, error_count: 3, p50_ms: 10, p95_ms: 20, p99_ms: 30 },
      { service: "checkout", operation: "POST /cart", minute_ts: minute, count: 40, error_count: 2, p50_ms: 10, p95_ms: 20, p99_ms: 30 },
    ]);

    const res = await SELF.fetch("https://example.com/api/analytics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyticsResponse;

    expect(body.incidents24h).toBe(3); // inc-old is outside the 24h window
    expect(body.openNow).toBe(2); // inc-b (reported) + inc-c (open); both resolved ones excluded
    expect(body.timeToReportP50Ms).toBe(180_000); // median of [60_000, 180_000, 500_000]
    expect(body.timeToResolveP50Ms).toBe(500_000); // mean of the two middles of [300_000, 700_000]
    expect(body.reqPerMin).toBe(100); // 60 + 40 at the newest minute only
    expect(body.errorRatePct).toBe(5); // 100 * (3 + 2) / 100
  });
});

describe("GET /api/deploys", () => {
  async function seedDeploy(id: string, tsMs: number): Promise<void> {
    await insertDeploy(env.DB, { id, service: "checkout", version: `v-${id}`, ts_ms: tsMs, note: `deploy ${id}` });
  }

  it("defaults to the last 24h and returns deploys newest-first", async () => {
    const now = Date.now();
    await seedDeploy("dep-old", now - 3 * 3_600_000);
    await seedDeploy("dep-new", now - 3_600_000);
    await seedDeploy("dep-ancient", now - 48 * 3_600_000); // outside the 24h default window

    const res = await SELF.fetch("https://example.com/api/deploys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploys: Array<Omit<Deploy, "id"> & { id?: string }> };
    // Reversed from listDeploys' chronological ascending -- the rail wants recent first.
    expect(body.deploys.map((d) => d.version)).toEqual(["v-dep-new", "v-dep-old"]);
    // Internal ids embed the originating scenario name (deploy-<scenario>-…) — they must never
    // reach the browser, same honesty boundary as the agent's list_deploys tool.
    for (const d of body.deploys) expect(d.id).toBeUndefined();
  });

  it("honors an explicit narrow window", async () => {
    const now = Date.now();
    await seedDeploy("dep-in", now - 30 * 60_000);
    await seedDeploy("dep-out", now - 2 * 3_600_000);

    const res = await SELF.fetch("https://example.com/api/deploys?from=-1h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploys: Array<Omit<Deploy, "id">> };
    expect(body.deploys.map((d) => d.version)).toEqual(["v-dep-in"]);
  });

  it("400s an unparseable from bound", async () => {
    const res = await SELF.fetch("https://example.com/api/deploys?from=last-tuesday");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("neither an ISO-8601 timestamp nor a relative offset");
  });
});

describe("GET /api/incidents/:id/metrics", () => {
  // Minute-aligned and far in the past, so the window math is fully data-driven (toMs comes from
  // resolved_at + the 10-min tail, never clamped by the route's Date.now()).
  const openedAt = 60_000_000;
  const resolvedAt = openedAt + 600_000;

  async function seedIncidentWithTrigger(id: string, triggerJson: string, resolved: number | null = resolvedAt): Promise<void> {
    await env.DB
      .prepare(
        "INSERT INTO incidents (id, status, severity, opened_at, resolved_at, trigger_json) VALUES (?, 'resolved', 'critical', ?, ?, ?)",
      )
      .bind(id, openedAt, resolved, triggerJson)
      .run();
  }

  it("builds one tile per distinct (service, metricClass) with weighted service-level points", async () => {
    const trigger = {
      statements: ["payments error_rate spiked", "payments p95 spiked"],
      anomalies: [
        { fingerprint: "payments:errors", service: "payments", metricClass: "error_rate", rule: "hard", value: 0.5, baseline: 0.003, statement: "payments error_rate spiked" },
        { fingerprint: "payments:latency", service: "payments", metricClass: "p95", rule: "sustained", value: 400, baseline: 92, statement: "payments p95 spiked" },
        // Same (service, metricClass) as the first entry -- deduped, so still exactly 2 tiles.
        { fingerprint: "payments:errors", service: "payments", metricClass: "error_rate", rule: "sustained", value: 0.4, baseline: 0.004, statement: "dup" },
      ],
    };
    await seedIncidentWithTrigger("inc-metrics", JSON.stringify(trigger));

    const m1 = openedAt;
    const m2 = openedAt + 60_000;
    await insertRollups(env.DB, [
      // m1: two payments operations -> exercises the count-weighted service-level aggregation.
      // (Counts/errors chosen binary-exact: 8/64 = 0.125 so the weighted math has no float fuzz.)
      { service: "payments", operation: "charge", minute_ts: m1, count: 64, error_count: 8, p50_ms: 50, p95_ms: 100, p99_ms: 150 },
      { service: "payments", operation: "refund", minute_ts: m1, count: 64, error_count: 0, p50_ms: 100, p95_ms: 300, p99_ms: 400 },
      // m2: the peak minute for both metrics.
      { service: "payments", operation: "charge", minute_ts: m2, count: 50, error_count: 25, p50_ms: 200, p95_ms: 400, p99_ms: 500 },
      // Before windowFromMs (opened_at - 30m) -> excluded despite its huge values.
      { service: "payments", operation: "charge", minute_ts: openedAt - 31 * 60_000, count: 999, error_count: 999, p50_ms: 1, p95_ms: 9_999, p99_ms: 9_999 },
      // Inside the window but a different service -> never aggregated into payments tiles.
      { service: "checkout", operation: "POST /cart", minute_ts: m1, count: 80, error_count: 80, p50_ms: 1, p95_ms: 8_888, p99_ms: 9_000 },
    ]);

    const res = await SELF.fetch("https://example.com/api/incidents/inc-metrics/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as IncidentMetricsResponse;

    expect(body.windowFromMs).toBe(openedAt - 30 * 60_000);
    expect(body.windowToMs).toBe(resolvedAt + 10 * 60_000);
    expect(body.tiles).toHaveLength(2);

    const [errorTile, p95Tile] = body.tiles;
    expect(errorTile?.service).toBe("payments");
    expect(errorTile?.metricClass).toBe("error_rate");
    expect(errorTile?.unit).toBe("pct");
    expect(errorTile?.points).toEqual([
      { minute_ts: m1, value: 6.25 }, // (8 + 0) errors / 128 reqs = 0.0625 -> 6.25%
      { minute_ts: m2, value: 50 }, // 25 / 50 -> 50%
    ]);
    expect(errorTile?.peak).toBe(50);
    expect(errorTile?.baseline).toBeCloseTo(0.3); // 0.003 converted to the same percent unit
    expect(errorTile?.ratio).toBeCloseTo(50 / 0.3);

    expect(p95Tile?.metricClass).toBe("p95");
    expect(p95Tile?.unit).toBe("ms");
    expect(p95Tile?.points).toEqual([
      { minute_ts: m1, value: 200 }, // (100*64 + 300*64) / 128 count-weighted
      { minute_ts: m2, value: 400 },
    ]);
    expect(p95Tile?.peak).toBe(400);
    expect(p95Tile?.baseline).toBe(92);
    expect(p95Tile?.ratio).toBeCloseTo(400 / 92);
  });

  it("derives the baseline from the window's pre-open service-level median once >= 3 pre-open minutes exist", async () => {
    // One p95 anomaly whose per-operation baseline (92) deliberately differs from the service-level
    // pre-open median -- proving the tile no longer mixes aggregation levels (the '×N' chip divides
    // a service-level peak by a service-level baseline).
    const trigger = {
      statements: ["payments p95 spiked"],
      anomalies: [{ fingerprint: "payments:latency", service: "payments", metricClass: "p95", rule: "hard", value: 400, baseline: 92, statement: "payments p95 spiked" }],
    };
    await seedIncidentWithTrigger("inc-preopen", JSON.stringify(trigger));

    // Three pre-open minutes with two operations each: service-level p95 = count-weighted mean =
    // (100 + 300) / 2 = 200 per minute -> pre-open median 200 (vs the per-op 92 fallback).
    const preMinutes = [openedAt - 3 * 60_000, openedAt - 2 * 60_000, openedAt - 60_000];
    const rows = preMinutes.flatMap((m) => [
      { service: "payments", operation: "charge", minute_ts: m, count: 10, error_count: 0, p50_ms: 50, p95_ms: 100, p99_ms: 150 },
      { service: "payments", operation: "refund", minute_ts: m, count: 10, error_count: 0, p50_ms: 80, p95_ms: 300, p99_ms: 400 },
    ]);
    // The in-incident peak minute.
    rows.push({ service: "payments", operation: "charge", minute_ts: openedAt, count: 20, error_count: 0, p50_ms: 300, p95_ms: 800, p99_ms: 900 });
    await insertRollups(env.DB, rows);

    const res = await SELF.fetch("https://example.com/api/incidents/inc-preopen/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as IncidentMetricsResponse;
    const tile = body.tiles[0];
    expect(tile?.peak).toBe(800);
    expect(tile?.baseline).toBe(200); // the series' own pre-open median, NOT the per-op 92
    expect(tile?.ratio).toBeCloseTo(800 / 200);
  });

  it("accepts a bare-array trigger, returns empty points with peak 0 when no rollups exist, and does not shadow /incidents/:id", async () => {
    await seedIncidentWithTrigger("inc-bare", JSON.stringify([{ service: "payments", metricClass: "p95", baseline: 92 }]), null);

    const res = await SELF.fetch("https://example.com/api/incidents/inc-bare/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as IncidentMetricsResponse;
    expect(body.tiles).toEqual([
      { service: "payments", metricClass: "p95", unit: "ms", points: [], peak: 0, baseline: 92, ratio: 0 },
    ]);

    // Registration-order check (the /metrics route is registered before /incidents/:id): the more
    // specific sub-path must not swallow -- or be swallowed by -- the detail route.
    const detailRes = await SELF.fetch("https://example.com/api/incidents/inc-bare");
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { incident: IncidentView };
    expect(detail.incident.id).toBe("inc-bare");
  });

  it("maps detect-domain metricClass names (errors/latency/traffic) onto tile metrics and caps at 3 tiles", async () => {
    // The shape incidents.ts actually persists: detect/rules.ts Anomaly entries under .anomalies.
    const trigger = {
      statements: ["s1", "s2", "s3", "s4"],
      anomalies: [
        { fingerprint: "payments:errors", service: "payments", metricClass: "errors", rule: "hard", value: 0.3, baseline: 0.003, statement: "s1" },
        { fingerprint: "payments:latency", service: "payments", metricClass: "latency", rule: "hard", value: 400, baseline: 92, statement: "s2" },
        { fingerprint: "gateway:traffic", service: "gateway", metricClass: "traffic", rule: "sustained", value: 90, baseline: 30, statement: "s3" },
        // A 4th distinct (service, metricClass) -> dropped by the 3-tile cap.
        { fingerprint: "checkout:errors", service: "checkout", metricClass: "errors", rule: "sustained", value: 0.1, baseline: 0.002, statement: "s4" },
      ],
    };
    await seedIncidentWithTrigger("inc-domain", JSON.stringify(trigger));

    const res = await SELF.fetch("https://example.com/api/incidents/inc-domain/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as IncidentMetricsResponse;
    expect(body.tiles.map((t) => [t.service, t.metricClass, t.unit])).toEqual([
      ["payments", "error_rate", "pct"],
      ["payments", "p95", "ms"],
      ["gateway", "req_rate", "per_min"],
    ]);
    expect(body.tiles[0]?.baseline).toBeCloseTo(0.3); // error_rate baseline in percent
    expect(body.tiles[2]?.baseline).toBe(30); // req_rate baseline untouched
  });

  it("returns 200 with empty tiles for malformed or junk-entry triggers, never a 500", async () => {
    await seedIncidentWithTrigger("inc-malformed", JSON.stringify("not an anomaly list"));
    await seedIncidentWithTrigger(
      "inc-junk-entries",
      JSON.stringify([
        null,
        { service: 42, metricClass: "p95", baseline: 1 }, // non-string service
        { service: "payments", metricClass: "bogus", baseline: 1 }, // unknown metricClass
        { service: "payments", metricClass: "p95", baseline: "92" }, // non-numeric baseline
      ]),
    );

    for (const id of ["inc-malformed", "inc-junk-entries"]) {
      const res = await SELF.fetch(`https://example.com/api/incidents/${id}/metrics`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as IncidentMetricsResponse;
      expect(body.tiles).toEqual([]);
    }
  });

  it("404s an unknown incident id", async () => {
    const res = await SELF.fetch("https://example.com/api/incidents/does-not-exist/metrics");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
