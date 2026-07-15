import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { computeBaselines } from "../../src/detect/baselines";
import type { Anomaly } from "../../src/detect/rules";
import { runSweep } from "../../src/detect/sweep";
import type { Env } from "../../src/env";
import { seedForWindow } from "../../src/sim/backfill";
import { generateWindow, rollupFromStats } from "../../src/sim/generator";
import { mulberry32 } from "../../src/sim/rng";
import { effectsFor, identityEffects, type FaultState } from "../../src/sim/scenarios";
import { openIncident } from "../../src/telemetry/incidents";
import { insertRollups } from "../../src/telemetry/queries";
import type { RollupRow } from "../../src/telemetry/types";

// Mandated integration test (Task 3.3 brief): seeded mini-world fixture -> bad-deploy effect
// window written directly into rollups -> runSweep at t, t+60s (advancing nowMs) -> incident
// exists with expected fingerprints, severity critical, and the mock INVESTIGATOR binding
// recorded exactly ONE /start call (dedupe: the second sweep must not re-open or re-start).

const MIN = 60_000;
const DAY_MIN = 24 * 60;
const ANCHOR = Date.UTC(2026, 0, 20, 14, 0, 0); // minute-aligned, peak hour (generator.ts PEAK_HOUR_UTC)

/** One healthy minute of rollups — the exact deterministic-seed convention `backfill.ts` uses
 * (mirrors `rules.test.ts`'s own harness), so this is the same synthetic history a real backfilled
 * world would carry. */
function healthyMinute(minuteStart: number): RollupRow[] {
  const rng = mulberry32(seedForWindow(minuteStart));
  const batch = generateWindow(minuteStart, minuteStart + MIN, identityEffects(), rng, 1);
  return rollupFromStats(batch.requests, minuteStart);
}

/** One fault-affected minute: three 20s sub-windows with `effectsFor` evaluated at each
 * sub-window's end, mirroring `SimulatorDO.runLiveTick`'s real ~20s tick loop — so bad-deploy's
 * 30s-onset fuse is discretized exactly as production would discretize it. Seed is xored so a
 * fault minute never replays the healthy minute's rng stream for the same timestamp. */
function faultMinute(minuteStart: number, fault: FaultState): RollupRow[] {
  const rng = mulberry32(seedForWindow(minuteStart) ^ 0x5eed);
  const stats: ReturnType<typeof generateWindow>["requests"] = [];
  for (let sub = 0; sub < 3; sub++) {
    const from = minuteStart + sub * 20_000;
    const to = from + 20_000;
    const effects = effectsFor(fault, to);
    const batch = generateWindow(from, to, effects, rng, 1);
    stats.push(...batch.requests);
  }
  return rollupFromStats(stats, minuteStart);
}

/** Inserts `totalMinutes` of healthy history ending at `endMs`, chunked so no single
 * `insertRollups` call risks D1's ~1000-statement/batch cap (mirrors `backfill.ts`'s own
 * chunking rationale for the same underlying limit). */
async function insertHealthyHistory(db: D1Database, endMs: number, totalMinutes: number): Promise<void> {
  const CHUNK_MINUTES = 180;
  for (let chunkStart = 0; chunkStart < totalMinutes; chunkStart += CHUNK_MINUTES) {
    const chunkEnd = Math.min(chunkStart + CHUNK_MINUTES, totalMinutes);
    const rows: RollupRow[] = [];
    for (let m = chunkStart; m < chunkEnd; m++) {
      rows.push(...healthyMinute(endMs - totalMinutes * MIN + m * MIN));
    }
    await insertRollups(db, rows);
  }
}

interface RecordedStart {
  incidentId: string;
  statement: string;
}

/** A mock INVESTIGATOR `DurableObjectNamespace`: `idFromName`/`get` are the only two methods
 * `sweep.ts` calls, so only those are implemented for real — every `/start` POST is recorded and
 * answered like the real Task-1.4-era stub (501), matching `sweep.ts`'s "any response counts as
 * notified" contract. */
function makeMockInvestigator(recorded: RecordedStart[]): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string | undefined) ?? "{}") as RecordedStart;
        recorded.push(body);
        return new Response("Not Implemented", { status: 501 });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

function makeTestEnv(investigator: DurableObjectNamespace): Env {
  return {
    DB: env.DB,
    SIMULATOR: env.SIMULATOR,
    INVESTIGATOR: investigator,
    ANTHROPIC_API_KEY: "test-key",
    MODEL_ID: "claude-sonnet-5",
    SIM_RATE: env.SIM_RATE ?? "1.0",
  };
}

afterEach(async () => {
  for (const table of [
    "spans",
    "logs",
    "rollups",
    "deploys",
    "incident_fingerprints",
    "investigation_steps",
    "incidents",
    "baselines",
    "meta",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("runSweep: bad-deploy end-to-end", () => {
  it(
    "opens exactly one critical incident with a payments fingerprint and exactly one INVESTIGATOR /start call across two sweeps",
    async () => {
      await insertHealthyHistory(env.DB, ANCHOR, DAY_MIN);
      await computeBaselines(env.DB, ANCHOR);

      // Bad-deploy fault starts exactly at ANCHOR (30s onset per scenarios.ts); seed 6 minutes so
      // both sweep calls below always have completed, fully-in-effect minutes to evaluate.
      const fault: FaultState = { scenario: "bad-deploy", startedMs: ANCHOR };
      for (let m = 0; m < 6; m++) {
        await insertRollups(env.DB, faultMinute(ANCHOR + m * MIN, fault));
      }

      const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
      await runInDurableObject(simStub, async (_instance, state) => {
        await state.storage.put("worldStatus", "running");
      });

      const started: RecordedStart[] = [];
      const testEnv = makeTestEnv(makeMockInvestigator(started));

      // First sweep: comfortably past bad-deploy's 2.5-min (from 30s onset) detection deadline.
      await runSweep(testEnv, ANCHOR + 4 * MIN);

      const afterFirst = await env.DB
        .prepare("SELECT id, status, severity FROM incidents")
        .all<{ id: string; status: string; severity: string }>();
      expect(afterFirst.results).toHaveLength(1);
      const incident = afterFirst.results?.[0] as { id: string; status: string; severity: string };
      expect(incident.status).toBe("open");
      expect(incident.severity).toBe("critical");

      const fpRows = await env.DB
        .prepare("SELECT fingerprint FROM incident_fingerprints WHERE incident_id = ?")
        .bind(incident.id)
        .all<{ fingerprint: string }>();
      const fingerprints = (fpRows.results ?? []).map((r) => r.fingerprint);
      expect(fingerprints.some((f) => f === "payments:errors" || f === "payments:latency")).toBe(true);

      expect(started).toHaveLength(1);
      expect(started[0]?.incidentId).toBe(incident.id);
      expect(started[0]?.statement.length).toBeGreaterThan(0);

      // Second sweep, 60s later: the fault is still active, so the same fingerprint(s) keep
      // breaching -- dedupe must fold this into the SAME incident, not open a second one or fire
      // a second /start.
      await runSweep(testEnv, ANCHOR + 5 * MIN);

      const afterSecond = await env.DB.prepare("SELECT count(*) as n FROM incidents").first<{ n: number }>();
      expect(afterSecond?.n).toBe(1);
      expect(started).toHaveLength(1); // still exactly one /start across both sweeps
    },
    30_000,
  );
});

describe("runSweep: subtask isolation and the world-status gate", () => {
  it("skips every subtask (no incident, no baseline recompute) when the world is not 'running'", async () => {
    // No worldStatus written at all -> defaults to 'unseeded' in SimulatorDO's /status handler.
    await insertRollups(env.DB, healthyMinute(ANCHOR - MIN));
    const testEnv = makeTestEnv(makeMockInvestigator([]));

    await expect(runSweep(testEnv, ANCHOR)).resolves.toBeUndefined();

    const incidents = await env.DB.prepare("SELECT count(*) as n FROM incidents").first<{ n: number }>();
    expect(incidents?.n).toBe(0);
  });

  it("a throwing retention subtask does not prevent detection (which runs first) from opening an incident", async () => {
    await insertHealthyHistory(env.DB, ANCHOR, DAY_MIN);
    await computeBaselines(env.DB, ANCHOR);

    const fault: FaultState = { scenario: "bad-deploy", startedMs: ANCHOR };
    for (let m = 0; m < 6; m++) {
      await insertRollups(env.DB, faultMinute(ANCHOR + m * MIN, fault));
    }

    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
    });

    const started: RecordedStart[] = [];
    // A DB proxy that throws only on retention's own bounded-delete query shape (`DELETE FROM
    // <table> WHERE rowid IN (...)`, unique to `retention.ts`'s `deleteOldest`) -- every other
    // query (detection's `queryMetrics`/`getBaselines`/`incidents.ts` calls, all keyed on real
    // columns, never on `rowid`) passes straight through to the real DB. Every other method is
    // rebound to `target` so a native D1Database's internal `this`-identity checks don't break
    // when called through the proxy.
    const explodingDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/FROM (spans|logs|rollups) WHERE rowid/.test(sql)) {
              throw new Error("injected retention failure");
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const testEnv = makeTestEnv(makeMockInvestigator(started));
    await expect(runSweep({ ...testEnv, DB: explodingDb as unknown as D1Database }, ANCHOR + 4 * MIN)).resolves.toBeUndefined();

    // Detection subtask (which ran first, against the REAL db via the sweep's own env.DB usage --
    // note retention only explodes on its own watermark/delete queries) still opened the incident.
    const incidents = await env.DB.prepare("SELECT count(*) as n FROM incidents").first<{ n: number }>();
    expect(incidents?.n).toBe(1);
    expect(started).toHaveLength(1);
  }, 30_000);
});

describe("runSweep: batch spanning two concurrently-open incidents (review FIX 1 regression)", () => {
  function mkAnomaly(overrides: Partial<Anomaly>): Anomaly {
    return {
      fingerprint: "payments:errors",
      service: "payments",
      metricClass: "errors",
      rule: "hard",
      value: 0.5,
      baseline: 0.01,
      statement: "synthetic statement",
      ...overrides,
    };
  }

  it("health-refreshes EVERY still-breaching incident each tick -- neither auto-resolves while its fault is live, and fingerprint attribution stays put", async () => {
    // Anchor T0 on an epoch-minute % 15 == 0 boundary so the six sweeps at +1..+6 min never hit
    // the 15-minute baseline recompute (which would rebuild baselines from ONLY the sparse breach
    // rollups below and change what evaluate() sees mid-test).
    const BASE = Date.UTC(2026, 0, 21, 10, 0, 0);
    const T0 = BASE + ((15 - (Math.floor(BASE / MIN) % 15)) % 15) * MIN;

    // Baselines: only checkout latency rows (p95 + p50), inserted directly with known medians so
    // the checkout:latency hard rule fires deterministically. payments:errors needs NO baseline
    // row at all (the missing-baseline fallback is the absolute 25% floor), and with no req_rate
    // rows anywhere the traffic rules stay silent -- so evaluate() yields EXACTLY
    // [checkout:latency, payments:errors] each minute.
    await env.DB.batch([
      env.DB
        .prepare("REPLACE INTO baselines (service, operation, metric, median, mad, computed_at) VALUES ('checkout', 'place_order', 'p95', 100, 10, ?)")
        .bind(T0),
      env.DB
        .prepare("REPLACE INTO baselines (service, operation, metric, median, mad, computed_at) VALUES ('checkout', 'place_order', 'p50', 20, 2, ?)")
        .bind(T0),
    ]);

    // Two distinct incidents already open BEFORE the sweeps: A on payments:errors, B on
    // checkout:latency -- the reviewer's exact scenario (a residual FP + a real fault, both open).
    const incidentA = await openIncident(env.DB, [mkAnomaly({})], T0 - 3 * MIN);
    const incidentB = await openIncident(
      env.DB,
      [mkAnomaly({ fingerprint: "checkout:latency", service: "checkout", metricClass: "latency", value: 800, baseline: 100 })],
      T0 - 2 * MIN,
    );
    expect(incidentA.created).toBe(true);
    expect(incidentB.created).toBe(true);

    // Both faults keep breaching for the whole test: one rollup row per (service, minute) for
    // minutes T0 .. T0+5 (minute0 of the sweep at T0+m is the minute starting at T0+(m-1)).
    const rows: RollupRow[] = [];
    for (let m = 0; m < 6; m++) {
      // payments errors hard trip: rate 0.5 >= max(25%, --) with 20 errors >= 3.
      rows.push({ service: "payments", operation: "charge", minute_ts: T0 + m * MIN, count: 40, error_count: 20, p50_ms: 25, p95_ms: 60, p99_ms: 80 });
      // checkout latency hard trip: p95 8x baseline (>= 4x), p50 10x baseline (>= 2x), count >= 5.
      rows.push({ service: "checkout", operation: "place_order", minute_ts: T0 + m * MIN, count: 40, error_count: 0, p50_ms: 200, p95_ms: 800, p99_ms: 900 });
    }
    await insertRollups(env.DB, rows);

    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
    });

    // Six sweeps, one per minute -- well past the 5-minute healthy streak that (pre-fix) would
    // have auto-resolved whichever incident the batch did NOT fold onto (its last health stamp
    // would have stayed frozen at its open time, T0-3min).
    const started: RecordedStart[] = [];
    const testEnv = makeTestEnv(makeMockInvestigator(started));
    for (let m = 1; m <= 6; m++) {
      await runSweep(testEnv, T0 + m * MIN);
    }

    // NEITHER incident auto-resolved: both faults were live the whole time, so both health clocks
    // must have been refreshed every tick regardless of which incident absorbed the batch.
    const statuses = await env.DB
      .prepare("SELECT id, status FROM incidents ORDER BY opened_at")
      .all<{ id: string; status: string }>();
    expect(statuses.results).toHaveLength(2);
    const statusById = new Map((statuses.results ?? []).map((r) => [r.id, r.status]));
    expect(statusById.get(incidentA.id)).toBe("open");
    expect(statusById.get(incidentB.id)).toBe("open");

    // Fingerprint attribution stayed put: payments:errors ONLY on A, checkout:latency ONLY on B.
    const fpRows = await env.DB
      .prepare("SELECT incident_id, fingerprint FROM incident_fingerprints ORDER BY incident_id, fingerprint")
      .all<{ incident_id: string; fingerprint: string }>();
    const byIncident = new Map<string, string[]>();
    for (const row of fpRows.results ?? []) {
      const arr = byIncident.get(row.incident_id);
      if (arr) arr.push(row.fingerprint);
      else byIncident.set(row.incident_id, [row.fingerprint]);
    }
    expect(byIncident.get(incidentA.id)).toEqual(["payments:errors"]);
    expect(byIncident.get(incidentB.id)).toEqual(["checkout:latency"]);

    // Both health clocks read the LAST sweep's timestamp -- direct evidence the refresh decoupled
    // from the fold decision (pre-fix, one of these would still read its open-time stamp).
    const lastSweepMs = String(T0 + 6 * MIN);
    for (const [incidentId, fingerprint] of [
      [incidentA.id, "payments:errors"],
      [incidentB.id, "checkout:latency"],
    ] as const) {
      const healthRow = await env.DB
        .prepare("SELECT value FROM meta WHERE key = ?")
        .bind(`incident_health:${incidentId}:${fingerprint}`)
        .first<{ value: string }>();
      expect(healthRow?.value).toBe(lastSweepMs);
    }

    // And no new incident/investigation was spawned by any of the six covered sweeps.
    expect(started).toHaveLength(0);
  }, 30_000);
});
