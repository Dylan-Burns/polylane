import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { insertInvestigationStep } from "../../src/telemetry/incidents";
import { insertLogs, insertSpans } from "../../src/telemetry/queries";
import type { StepView } from "../../src/telemetry/read";
import type { IncidentView, LogLine, Span } from "../../src/telemetry/types";

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
