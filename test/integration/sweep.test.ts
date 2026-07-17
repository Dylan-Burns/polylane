import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { computeBaselines } from "../../src/detect/baselines";
import type { Anomaly } from "../../src/detect/rules";
import { LAST_SWEEP_OK_META_KEY, runSweep } from "../../src/detect/sweep";
import type { Env } from "../../src/env";
import { seedForWindow } from "../../src/sim/backfill";
import { generateWindow, rollupFromStats } from "../../src/sim/generator";
import { mulberry32 } from "../../src/sim/rng";
import { effectsFor, identityEffects, type FaultState } from "../../src/sim/scenarios";
import { openIncident, setStatus } from "../../src/telemetry/incidents";
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
 * answered per the REAL DO's contract: 200 + the synchronous `open → investigating` status flip
 * (`InvestigatorDO.handleStart` does both before returning), which is what the sweep's deferred
 * retry keys on. `rejectFirst` makes the first call answer 409 `investigation_active` instead —
 * the "busy with another incident" case; `alwaysReject` holds that state forever (an investigator
 * occupied for the whole test, so incidents legitimately stay `open`). */
function makeMockInvestigator(
  recorded: RecordedStart[],
  opts: { rejectFirst?: boolean; alwaysReject?: boolean } = {},
): DurableObjectNamespace {
  let calls = 0;
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string | undefined) ?? "{}") as RecordedStart;
        recorded.push(body);
        calls += 1;
        if (opts.alwaysReject === true || (opts.rejectFirst === true && calls === 1)) {
          return Response.json({ error: "investigation_active" }, { status: 409 });
        }
        await setStatus(env.DB, body.incidentId, "investigating");
        return Response.json({ ok: true });
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
    "opens exactly one critical incident with a payments-api fingerprint and exactly one INVESTIGATOR /start call across two sweeps",
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
      // `investigating`, not `open`: a successful /start flips the status synchronously (the mock
      // mirrors the real DO's contract) — which is also what tells the retry subtask it started.
      expect(incident.status).toBe("investigating");
      expect(incident.severity).toBe("critical");

      const fpRows = await env.DB
        .prepare("SELECT fingerprint FROM incident_fingerprints WHERE incident_id = ?")
        .bind(incident.id)
        .all<{ fingerprint: string }>();
      const fingerprints = (fpRows.results ?? []).map((r) => r.fingerprint);
      expect(fingerprints.some((f) => f === "payments-api:errors" || f === "payments-api:latency")).toBe(true);

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

describe("runSweep: rollup write-lag (production timing)", () => {
  // The production reality this reproduces: SimulatorDO's 20s-cadence tick writes a closed
  // minute's rollups up to ~20s AFTER the minute boundary, while the cron fires at an arbitrary
  // early offset (observed :03-:08). Wall-clock minute selection would therefore evaluate a
  // minute whose rows haven't landed yet — an empty minute0, every single tick — which is
  // exactly how live detection shipped blind while every fixture-seeded test stayed green.
  it("detects on the newest minutes PRESENT in rollups when the wall-clock last-completed minute hasn't been rolled up yet", async () => {
    await insertHealthyHistory(env.DB, ANCHOR, DAY_MIN);
    await computeBaselines(env.DB, ANCHOR);

    const fault: FaultState = { scenario: "bad-deploy", startedMs: ANCHOR };
    for (let m = 0; m < 4; m++) {
      await insertRollups(env.DB, faultMinute(ANCHOR + m * MIN, fault));
    }

    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
    });
    const started: RecordedStart[] = [];
    const testEnv = makeTestEnv(makeMockInvestigator(started));

    // Newest rollup minute is ANCHOR+3min; the cron fires 4s into ANCHOR+5min, so the wall-clock
    // "last completed minute" (ANCHOR+4min) has no rows yet.
    await runSweep(testEnv, ANCHOR + 5 * MIN + 4_000);

    const incidents = await env.DB.prepare("SELECT count(*) AS n FROM incidents").first<{ n: number }>();
    expect(incidents?.n).toBe(1);
    expect(started).toHaveLength(1);
  }, 30_000);

  it("skips detection entirely when the newest rollup minute is older than the staleness guard (stalled simulator)", async () => {
    await insertHealthyHistory(env.DB, ANCHOR, DAY_MIN);
    await computeBaselines(env.DB, ANCHOR);

    const fault: FaultState = { scenario: "bad-deploy", startedMs: ANCHOR };
    for (let m = 0; m < 4; m++) {
      await insertRollups(env.DB, faultMinute(ANCHOR + m * MIN, fault));
    }

    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
    });
    const started: RecordedStart[] = [];
    const testEnv = makeTestEnv(makeMockInvestigator(started));

    // Newest rollup minute (ANCHOR+3min) is 6min4s old at sweep time — beyond the 5-minute
    // staleness guard, so detection must not fire on long-stale data.
    await runSweep(testEnv, ANCHOR + 9 * MIN + 4_000);

    const incidents = await env.DB.prepare("SELECT count(*) AS n FROM incidents").first<{ n: number }>();
    expect(incidents?.n).toBe(0);
    expect(started).toHaveLength(0);
  }, 30_000);
});

describe("runSweep: investigation budget kill-switch (Task 7.1)", () => {
  it("opens the incident but records a 'deferred — budget' note and fires no /start when the hourly budget is exhausted", async () => {
    await insertHealthyHistory(env.DB, ANCHOR, DAY_MIN);
    await computeBaselines(env.DB, ANCHOR);
    const fault: FaultState = { scenario: "bad-deploy", startedMs: ANCHOR };
    for (let m = 0; m < 4; m++) {
      await insertRollups(env.DB, faultMinute(ANCHOR + m * MIN, fault));
    }
    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
    });
    // Pre-set the hourly counter to the limit so this tick's open is denied an investigation.
    await env.DB
      .prepare("REPLACE INTO meta (key, value) VALUES ('investigation_count_hour', ?)")
      .bind(JSON.stringify({ windowStartMs: ANCHOR, count: 10 }))
      .run();

    const started: RecordedStart[] = [];
    await runSweep(makeTestEnv(makeMockInvestigator(started)), ANCHOR + 4 * MIN);

    const incident = await env.DB.prepare("SELECT id FROM incidents").first<{ id: string }>();
    expect(incident).not.toBeNull(); // the incident still opens — not silently dropped
    expect(started).toHaveLength(0); // but no investigation is started

    const note = await env.DB
      .prepare("SELECT content_json FROM investigation_steps WHERE incident_id = ? AND kind = 'note'")
      .bind(incident?.id)
      .first<{ content_json: string }>();
    expect(note).not.toBeNull();
    expect(JSON.parse(note!.content_json).note).toMatch(/deferred/i);
  }, 30_000);
});

describe("runSweep: deferred-start retry (investigator busy)", () => {
  it("a 409'd /start burns no budget, leaves a visible busy note, and the NEXT sweep retries and starts it", async () => {
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
    const testEnv = makeTestEnv(makeMockInvestigator(started, { rejectFirst: true }));

    // Sweep 1: incident opens, /start is attempted once and 409s (investigator busy elsewhere).
    await runSweep(testEnv, ANCHOR + 4 * MIN);
    const incident = await env.DB.prepare("SELECT id, status FROM incidents").first<{ id: string; status: string }>();
    expect(incident?.status).toBe("open"); // never started — the real DO's 200 path flips this
    expect(started).toHaveLength(1);

    // The rejection burned NO hourly budget slot (consumed only after a successful start)…
    const budgetAfterReject = await env.DB
      .prepare("SELECT value FROM meta WHERE key = 'investigation_count_hour'")
      .first<{ value: string }>();
    expect(budgetAfterReject).toBeNull();

    // …and the timeline says WHY it's empty.
    const note = await env.DB
      .prepare("SELECT content_json FROM investigation_steps WHERE incident_id = ? AND kind = 'note'")
      .bind(incident?.id)
      .first<{ content_json: string }>();
    expect(JSON.parse(note!.content_json).note).toMatch(/busy/i);

    // Sweep 2 (next tick): the retry subtask finds the still-open incident and starts it for real.
    await runSweep(testEnv, ANCHOR + 5 * MIN);
    expect(started).toHaveLength(2);
    expect(started[1]?.incidentId).toBe(incident?.id);
    const after = await env.DB.prepare("SELECT status FROM incidents WHERE id = ?").bind(incident?.id).first<{ status: string }>();
    expect(after?.status).toBe("investigating");
    const budgetAfterStart = await env.DB
      .prepare("SELECT value FROM meta WHERE key = 'investigation_count_hour'")
      .first<{ value: string }>();
    expect(JSON.parse(budgetAfterStart!.value).count).toBe(1); // exactly one slot, consumed on success

    // Sweep 3: nothing left to retry — no third /start.
    await runSweep(testEnv, ANCHOR + 6 * MIN);
    expect(started).toHaveLength(2);
  }, 30_000);
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

  it("does NOT record last_sweep_ok_ms when the world isn't running (every subtask, including this one, is skipped)", async () => {
    // Explicit, not relied-upon-default: other tests in this file leave the shared 'world'
    // SimulatorDO singleton's storage at 'running', so this pins the precondition instead of
    // trusting whatever an earlier test left behind.
    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "unseeded");
    });
    const testEnv = makeTestEnv(makeMockInvestigator([]));
    await runSweep(testEnv, ANCHOR);

    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(LAST_SWEEP_OK_META_KEY).first<{ value: string }>();
    expect(row).toBeNull();
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

describe("runSweep: last-sweep-ok watermark", () => {
  it("records last_sweep_ok_ms in meta once a tick against a running world runs to completion", async () => {
    await insertRollups(env.DB, healthyMinute(ANCHOR - MIN));
    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
    });
    const testEnv = makeTestEnv(makeMockInvestigator([]));

    await runSweep(testEnv, ANCHOR);

    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(LAST_SWEEP_OK_META_KEY).first<{ value: string }>();
    expect(row?.value).toBe(String(ANCHOR));
  });

  it("advances on every subsequent successful tick (not a write-once value)", async () => {
    await insertRollups(env.DB, healthyMinute(ANCHOR - MIN));
    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
    });
    const testEnv = makeTestEnv(makeMockInvestigator([]));

    await runSweep(testEnv, ANCHOR);
    await runSweep(testEnv, ANCHOR + MIN);

    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(LAST_SWEEP_OK_META_KEY).first<{ value: string }>();
    expect(row?.value).toBe(String(ANCHOR + MIN));
  });
});

describe("runSweep: batch spanning two concurrently-open incidents (review FIX 1 regression)", () => {
  function mkAnomaly(overrides: Partial<Anomaly>): Anomaly {
    return {
      fingerprint: "payments-api:errors",
      service: "payments-api",
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

    // Baselines: only checkout-edge latency rows (p95 + p50), inserted directly with known medians so
    // the checkout-edge:latency hard rule fires deterministically. payments-api:errors needs NO baseline
    // row at all (the missing-baseline fallback is the absolute 25% floor), and with no req_rate
    // rows anywhere the traffic rules stay silent -- so evaluate() yields EXACTLY
    // [checkout-edge:latency, payments-api:errors] each minute.
    await env.DB.batch([
      env.DB
        .prepare("REPLACE INTO baselines (service, operation, metric, median, mad, computed_at) VALUES ('checkout-edge', 'place_order', 'p95', 100, 10, ?)")
        .bind(T0),
      env.DB
        .prepare("REPLACE INTO baselines (service, operation, metric, median, mad, computed_at) VALUES ('checkout-edge', 'place_order', 'p50', 20, 2, ?)")
        .bind(T0),
    ]);

    // Two distinct incidents already open BEFORE the sweeps: A on payments-api:errors, B on
    // checkout-edge:latency -- the reviewer's exact scenario (a residual FP + a real fault, both open).
    const incidentA = await openIncident(env.DB, [mkAnomaly({})], T0 - 3 * MIN);
    const incidentB = await openIncident(
      env.DB,
      [mkAnomaly({ fingerprint: "checkout-edge:latency", service: "checkout-edge", metricClass: "latency", value: 800, baseline: 100 })],
      T0 - 2 * MIN,
    );
    expect(incidentA.created).toBe(true);
    expect(incidentB.created).toBe(true);

    // Both faults keep breaching for the whole test: one rollup row per (service, minute) for
    // minutes T0 .. T0+5 (minute0 of the sweep at T0+m is the minute starting at T0+(m-1)).
    const rows: RollupRow[] = [];
    for (let m = 0; m < 6; m++) {
      // payments-api errors hard trip: rate 0.5 >= max(25%, --) with 20 errors >= 3.
      rows.push({ service: "payments-api", operation: "charge", minute_ts: T0 + m * MIN, count: 40, error_count: 20, p50_ms: 25, p95_ms: 60, p99_ms: 80 });
      // checkout-edge latency hard trip: p95 8x baseline (>= 4x), p50 10x baseline (>= 2x), count >= 5.
      rows.push({ service: "checkout-edge", operation: "place_order", minute_ts: T0 + m * MIN, count: 40, error_count: 0, p50_ms: 200, p95_ms: 800, p99_ms: 900 });
    }
    await insertRollups(env.DB, rows);

    const simStub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(simStub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
    });

    // Six sweeps, one per minute -- well past the 5-minute healthy streak that (pre-fix) would
    // have auto-resolved whichever incident the batch did NOT fold onto (its last health stamp
    // would have stayed frozen at its open time, T0-3min). The investigator stays busy for the
    // whole test (alwaysReject) so both incidents legitimately remain `open` — this test is about
    // health refresh and fingerprint attribution, not investigation startup.
    const started: RecordedStart[] = [];
    const testEnv = makeTestEnv(makeMockInvestigator(started, { alwaysReject: true }));
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

    // Fingerprint attribution stayed put: payments-api:errors ONLY on A, checkout-edge:latency ONLY on B.
    const fpRows = await env.DB
      .prepare("SELECT incident_id, fingerprint FROM incident_fingerprints ORDER BY incident_id, fingerprint")
      .all<{ incident_id: string; fingerprint: string }>();
    const byIncident = new Map<string, string[]>();
    for (const row of fpRows.results ?? []) {
      const arr = byIncident.get(row.incident_id);
      if (arr) arr.push(row.fingerprint);
      else byIncident.set(row.incident_id, [row.fingerprint]);
    }
    expect(byIncident.get(incidentA.id)).toEqual(["payments-api:errors"]);
    expect(byIncident.get(incidentB.id)).toEqual(["checkout-edge:latency"]);

    // Both health clocks read the LAST sweep's timestamp -- direct evidence the refresh decoupled
    // from the fold decision (pre-fix, one of these would still read its open-time stamp).
    const lastSweepMs = String(T0 + 6 * MIN);
    for (const [incidentId, fingerprint] of [
      [incidentA.id, "payments-api:errors"],
      [incidentB.id, "checkout-edge:latency"],
    ] as const) {
      const healthRow = await env.DB
        .prepare("SELECT value FROM meta WHERE key = ?")
        .bind(`incident_health:${incidentId}:${fingerprint}`)
        .first<{ value: string }>();
      expect(healthRow?.value).toBe(lastSweepMs);
    }

    // The deferred-start retry kept attempting BOTH open incidents each sweep (every attempt
    // 409'd — the investigator stayed busy), but no third incident ever appeared in the attempts
    // and none of them succeeded (statuses asserted `open` above).
    expect(new Set(started.map((s) => s.incidentId))).toEqual(new Set([incidentA.id, incidentB.id]));
  }, 30_000);
});
