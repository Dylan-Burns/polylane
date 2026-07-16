import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { baselineKey, type BaselineMap } from "../../src/detect/baselines";
import { LAST_SWEEP_OK_META_KEY } from "../../src/detect/sweep";
import { insertRollups } from "../../src/telemetry/queries";
import { latestRollupMinute } from "../../src/telemetry/read";
import { RETENTION_WATERMARK_META_KEY } from "../../src/telemetry/retention";
import { buildTopology, getOpsHealth, serviceHealth, sparklineSeries } from "../../src/telemetry/state";
import type { RollupRow } from "../../src/telemetry/types";

const MIN = 60_000;
// Minute-aligned anchor so `serviceHealth`/`sparklineSeries`'s "most recent completed minute"
// arithmetic (`floor(nowMs / MIN) * MIN`) lands exactly where each fixture expects.
const NOW = Date.UTC(2026, 0, 5, 15, 0, 0);

function emptyBaselines(): BaselineMap {
  return new Map();
}

afterEach(async () => {
  for (const table of ["spans", "logs", "rollups", "deploys", "incident_fingerprints", "investigation_steps", "incidents", "baselines", "meta"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("buildTopology", () => {
  it("derives the spec §6 service graph from sim/topology.ts's FLOWS, deduped and sorted", () => {
    const topology = buildTopology();

    expect(topology.services.map((s) => s.name)).toEqual([
      "gateway",
      "checkout",
      "payments",
      "payments-db",
      "notifications",
      "catalog",
      "email-provider",
    ]);
    expect(topology.services.find((s) => s.name === "email-provider")).toEqual({ name: "email-provider", external: true });
    expect(topology.services.find((s) => s.name === "gateway")?.external).toBeUndefined();

    expect(topology.edges).toEqual([
      ["checkout", "notifications"],
      ["checkout", "payments"],
      ["gateway", "catalog"],
      ["gateway", "checkout"],
      ["notifications", "email-provider"],
      ["payments", "payments-db"],
    ]);

    // No intra-service edge from notifications.send_email -> notifications.render_template.
    expect(topology.edges.some(([from, to]) => from === to)).toBe(false);
  });

  it("is deterministic across calls (pure function of static topology data)", () => {
    expect(buildTopology()).toEqual(buildTopology());
  });
});

describe("latestRollupMinute", () => {
  it("returns null on an empty rollups table and the max minute_ts otherwise", async () => {
    expect(await latestRollupMinute(env.DB)).toBeNull();

    await insertRollups(env.DB, [
      { service: "checkout", operation: "POST /checkout", minute_ts: NOW - 3 * MIN, count: 10, error_count: 0, p50_ms: 40, p95_ms: 150, p99_ms: 250 },
      { service: "gateway", operation: "GET /", minute_ts: NOW - 2 * MIN, count: 50, error_count: 0, p50_ms: 10, p95_ms: 30, p99_ms: 60 },
    ]);
    expect(await latestRollupMinute(env.DB)).toBe(NOW - 2 * MIN);
  });
});

describe("serviceHealth", () => {
  it("red: a service appearing in an open/investigating/reported incident's fingerprints", async () => {
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES (?, 'investigating', 'critical', ?, '{}')")
        .bind("inc-red", NOW - 3 * MIN),
      env.DB
        .prepare("INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, 1)")
        .bind("inc-red", "payments:errors", NOW - 3 * MIN),
    ]);

    const health = await serviceHealth(env.DB, emptyBaselines(), NOW);
    expect(health.payments).toBe("red");
    // Every other topology service defaults green (steady fixture, no incidents/breaches of its own).
    expect(health.gateway).toBe("green");
    expect(health.checkout).toBe("green");
  });

  it("amber (pre-incident): last completed minute breaches a sustained-rule threshold but isn't an incident yet", async () => {
    const baselines: BaselineMap = new Map([[baselineKey("checkout", "POST /checkout", "error_rate"), { median: 0.01, mad: 0.005 }]]);
    const lastCompletedMinuteStart = Math.floor(NOW / MIN) * MIN - MIN;
    // 6% error rate: above the sustained floor (max(5%, 1%+6*0.5%=4%)=5%), 6 errors clears the >=3
    // evidence gate -- breaches the SUSTAINED threshold in this one minute alone (no incident open).
    await insertRollups(env.DB, [
      { service: "checkout", operation: "POST /checkout", minute_ts: lastCompletedMinuteStart, count: 100, error_count: 6, p50_ms: 40, p95_ms: 150, p99_ms: 250 },
    ]);

    const health = await serviceHealth(env.DB, baselines, NOW);
    expect(health.checkout).toBe("amber");
  });

  it("amber (pre-incident) still shows when the newest rolled-up minute lags the wall clock (rollup write lag)", async () => {
    const baselines: BaselineMap = new Map([[baselineKey("checkout", "POST /checkout", "error_rate"), { median: 0.01, mad: 0.005 }]]);
    // The newest minute PRESENT is two minutes old by wall clock — the simulator's 20s-cadence
    // tick hasn't yet written the wall-clock last-completed minute when a poll lands early in
    // the minute. Health must anchor on the data, not the clock, or amber is permanently blind.
    const laggedMinuteStart = Math.floor(NOW / MIN) * MIN - 2 * MIN;
    await insertRollups(env.DB, [
      { service: "checkout", operation: "POST /checkout", minute_ts: laggedMinuteStart, count: 100, error_count: 6, p50_ms: 40, p95_ms: 150, p99_ms: 250 },
    ]);

    const health = await serviceHealth(env.DB, baselines, NOW);
    expect(health.checkout).toBe("amber");
  });

  it("green: steady state, no incidents and no breaching minute", async () => {
    const baselines: BaselineMap = new Map([[baselineKey("checkout", "POST /checkout", "error_rate"), { median: 0.01, mad: 0.005 }]]);
    const lastCompletedMinuteStart = Math.floor(NOW / MIN) * MIN - MIN;
    await insertRollups(env.DB, [
      { service: "checkout", operation: "POST /checkout", minute_ts: lastCompletedMinuteStart, count: 100, error_count: 1, p50_ms: 40, p95_ms: 150, p99_ms: 250 },
    ]);

    const health = await serviceHealth(env.DB, baselines, NOW);
    expect(health.checkout).toBe("green");
    for (const service of ["gateway", "payments", "payments-db", "notifications", "catalog"]) {
      expect(health[service]).toBe("green");
    }
  });

  it("amber (recovering): a service belonging to an incident resolved less than 5 minutes ago", async () => {
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO incidents (id, status, severity, opened_at, resolved_at, trigger_json) VALUES (?, 'resolved', 'warning', ?, ?, '{}')")
        .bind("inc-recovering", NOW - 20 * MIN, NOW - 2 * MIN),
      env.DB
        .prepare("INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, 1)")
        .bind("inc-recovering", "notifications:latency", NOW - 20 * MIN),
    ]);

    const health = await serviceHealth(env.DB, emptyBaselines(), NOW);
    expect(health.notifications).toBe("amber");
  });

  it("a resolved incident more than 5 minutes ago no longer marks its service amber", async () => {
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO incidents (id, status, severity, opened_at, resolved_at, trigger_json) VALUES (?, 'resolved', 'warning', ?, ?, '{}')")
        .bind("inc-long-resolved", NOW - 30 * MIN, NOW - 10 * MIN),
      env.DB
        .prepare("INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, 1)")
        .bind("inc-long-resolved", "catalog:traffic", NOW - 30 * MIN),
    ]);

    const health = await serviceHealth(env.DB, emptyBaselines(), NOW);
    expect(health.catalog).toBe("green");
  });

  it("red wins over a recovering-amber signal on the same service", async () => {
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO incidents (id, status, severity, opened_at, resolved_at, trigger_json) VALUES (?, 'resolved', 'warning', ?, ?, '{}')")
        .bind("inc-resolved", NOW - 20 * MIN, NOW - 1 * MIN),
      env.DB
        .prepare("INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, 1)")
        .bind("inc-resolved", "payments:latency", NOW - 20 * MIN),
      env.DB
        .prepare("INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES (?, 'open', 'critical', ?, '{}')")
        .bind("inc-open", NOW - 5 * MIN),
      env.DB
        .prepare("INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, 1)")
        .bind("inc-open", "payments:errors", NOW - 5 * MIN),
    ]);

    const health = await serviceHealth(env.DB, emptyBaselines(), NOW);
    expect(health.payments).toBe("red");
  });
});

describe("sparklineSeries", () => {
  it("aggregates rollups per (service, minute) across operations, from completed minutes only", async () => {
    const currentMinuteStart = Math.floor(NOW / MIN) * MIN;
    const m0 = currentMinuteStart - MIN; // last completed minute
    const m1 = currentMinuteStart - 2 * MIN;

    const rows: RollupRow[] = [
      { service: "checkout", operation: "POST /checkout", minute_ts: m0, count: 100, error_count: 5, p50_ms: 40, p95_ms: 150, p99_ms: 250 },
      { service: "checkout", operation: "GET /cart", minute_ts: m0, count: 20, error_count: 0, p50_ms: 10, p95_ms: 20, p99_ms: 30 },
      { service: "checkout", operation: "POST /checkout", minute_ts: m1, count: 50, error_count: 0, p50_ms: 30, p95_ms: 100, p99_ms: 150 },
      // Belongs to the CURRENT (in-progress) minute -- must be excluded from the series.
      { service: "checkout", operation: "POST /checkout", minute_ts: currentMinuteStart, count: 999, error_count: 999, p50_ms: 1, p95_ms: 1, p99_ms: 1 },
    ];
    await insertRollups(env.DB, rows);

    const series = await sparklineSeries(env.DB, NOW);
    expect(series.checkout).toHaveLength(2);
    expect(series.checkout?.map((p) => p.minute_ts)).toEqual([m1, m0]); // ascending

    const at0 = series.checkout?.find((p) => p.minute_ts === m0);
    expect(at0?.count).toBe(120); // 100 + 20, summed across both operations
    expect(at0?.error_rate).toBeCloseTo(5 / 120);
    expect(at0?.p95).toBeCloseTo((150 * 100 + 20 * 20) / 120); // count-weighted average

    const at1 = series.checkout?.find((p) => p.minute_ts === m1);
    expect(at1?.count).toBe(50);
    expect(at1?.p95).toBe(100);
  });

  it("a service with no rollups at all in the window is simply absent from the result", async () => {
    const series = await sparklineSeries(env.DB, NOW);
    expect(series).toEqual({});
  });
});

describe("getOpsHealth", () => {
  it("reads lastSweepOkMs and computes retentionWatermarkAgeMs from the spans watermark", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind(LAST_SWEEP_OK_META_KEY, String(NOW - 45_000)),
      env.DB
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
        .bind(RETENTION_WATERMARK_META_KEY, JSON.stringify({ spans: NOW - 6 * 60 * MIN, logs: NOW - 6 * 60 * MIN, rollups: 0 })),
    ]);

    const opsHealth = await getOpsHealth(env.DB, NOW);
    expect(opsHealth.lastSweepOkMs).toBe(NOW - 45_000);
    expect(opsHealth.retentionWatermarkAgeMs).toBe(6 * 60 * MIN);
  });

  it("both fields are undefined when neither meta key has ever been written", async () => {
    const opsHealth = await getOpsHealth(env.DB, NOW);
    expect(opsHealth.lastSweepOkMs).toBeUndefined();
    expect(opsHealth.retentionWatermarkAgeMs).toBeUndefined();
  });

  it("degrades to undefined (not a throw) on a corrupt retention watermark value", async () => {
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind(RETENTION_WATERMARK_META_KEY, "not json").run();
    const opsHealth = await getOpsHealth(env.DB, NOW);
    expect(opsHealth.retentionWatermarkAgeMs).toBeUndefined();
  });
});
