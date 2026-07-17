import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { computeBaselines } from "../../src/detect/baselines";
import { BACKFILL_CHUNK_MS, MINUTE_MS } from "../../src/sim/backfill";
import { insertSeededIncident } from "../../src/sim/seed-incident";
import { insertSpans } from "../../src/telemetry/queries";
import type { Span } from "../../src/telemetry/types";

// Documented pattern (task brief): vitest-pool-workers' `runDurableObjectAlarm` only fires an
// *already-scheduled* alarm immediately, which doesn't let us control what wall-clock time the
// handler perceives. Instead we drive alarm-based flows by calling `instance.alarm()` directly
// via `runInDurableObject` (which gives raw instance + state access, bypassing HTTP), combined
// with `SimulatorDO`'s `setTestNow` seam so `this.now()` inside the DO is fully test-controlled.

const PEAK_HOUR_T0 = Date.UTC(2026, 0, 5, 14, 0, 0); // minute-aligned, diurnal peak for reliable volume

interface StatusBody {
  worldStatus: string;
  fault: { scenario: string; startedMs: number } | null;
  generation: number;
  seedProgress?: number;
  live?: {
    minuteTs: number;
    elapsedMs: number;
    services: Record<string, { count: number; errPct: number; p95: number }>;
  };
}

async function statusOf(stub: DurableObjectStub): Promise<StatusBody> {
  const res = await stub.fetch("http://simulator/status");
  return (await res.json()) as StatusBody;
}

function makeSpan(i: number): Span {
  return {
    trace_id: `pre-existing-trace-${i}`,
    span_id: `pre-existing-span-${i}`,
    parent_span_id: null,
    service: "checkout-edge",
    operation: "place_order",
    start_ms: 1_700_000_000_000 + i,
    duration_ms: 10,
    status: "ok",
    error_type: null,
  };
}

afterEach(async () => {
  // Children (FK-referencing `incidents`) must be cleared before `incidents` itself.
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

describe("SimulatorDO tick", () => {
  it("writes sampled spans every tick and closes rollups only for minutes that fully finished within the tick", async () => {
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("test-tick-1"));

    const alarmAfter = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("worldStatus", "running");
      await state.storage.put("generation", 1);
      await state.storage.put("lastTickMs", PEAK_HOUR_T0);
      instance.setTestNow(PEAK_HOUR_T0 + 70_000); // crosses exactly one minute boundary
      await instance.alarm();
      return state.storage.getAlarm();
    });

    // Re-armed at the top of the handler: a pending alarm exists after the call returns.
    expect(alarmAfter).not.toBeNull();

    const spanCount = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
    expect(spanCount?.n).toBeGreaterThan(0);

    const closedMinuteRollups = await env.DB.prepare("SELECT count(*) as n FROM rollups WHERE minute_ts = ?")
      .bind(PEAK_HOUR_T0)
      .first<{ n: number }>();
    expect(closedMinuteRollups?.n).toBeGreaterThan(0);

    // The still-open minute (T0+60s..T0+70s) hasn't closed yet — no rollup row for it, its stats
    // carry to the next tick via `partialMinute` storage instead.
    const openMinuteRollups = await env.DB.prepare("SELECT count(*) as n FROM rollups WHERE minute_ts = ?")
      .bind(PEAK_HOUR_T0 + MINUTE_MS)
      .first<{ n: number }>();
    expect(openMinuteRollups?.n).toBe(0);
  });
});

describe("SimulatorDO fault/restore", () => {
  it("rejects /fault with 409 world_not_ready unless the world is running (break-it: chaos during seeding)", async () => {
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("test-fault-not-ready"));

    // A reset clears `fault` and the backfill outlives the 30s chaos cooldown, so neither of the
    // other /fault gates catches a mid-seed inject — the worldStatus gate has to.
    for (const worldStatus of ["unseeded", "seeding", "resetting"] as const) {
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("worldStatus", worldStatus);
      });
      const res = await stub.fetch("http://simulator/fault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "bad-deploy" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "world_not_ready", worldStatus });
    }
  });

  it("fault set 200 -> effects visible in next tick; second fault while active -> 409; restore -> 200 and effects clear", async () => {
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("test-fault-1"));

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("worldStatus", "running");
      await state.storage.put("generation", 1);
      await state.storage.put("lastTickMs", PEAK_HOUR_T0);
      instance.setTestNow(PEAK_HOUR_T0);
    });

    const setRes = await stub.fetch("http://simulator/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "bad-deploy" }),
    });
    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({ fault: { scenario: "bad-deploy", startedMs: PEAK_HOUR_T0 } });

    const secondRes = await stub.fetch("http://simulator/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "traffic-spike" }),
    });
    expect(secondRes.status).toBe(409);
    expect(await secondRes.json()).toEqual({ error: "scenario_active" });

    // Advance well past the 30s onset with a wide (5min) window so pool-exhaustion errors are
    // all but certain to appear (25% error rate on payments-api once active).
    await runInDurableObject(stub, async (instance) => {
      instance.setTestNow(PEAK_HOUR_T0 + 5 * MINUTE_MS);
      await instance.alarm();
    });

    const faultedErrors = await env.DB.prepare(
      "SELECT count(*) as n FROM spans WHERE service = 'payments-api' AND error_type = 'pool_exhausted'",
    ).first<{ n: number }>();
    expect(faultedErrors?.n).toBeGreaterThan(0);

    const restoreRes = await stub.fetch("http://simulator/restore", { method: "POST" });
    expect(restoreRes.status).toBe(200);
    expect(await restoreRes.json()).toEqual({ fault: null });

    const statusAfterRestore = await statusOf(stub);
    expect(statusAfterRestore.fault).toBeNull();

    // A tick entirely after restore must not add any *new* pool-exhaustion spans.
    const restoreTickStart = PEAK_HOUR_T0 + 5 * MINUTE_MS;
    await runInDurableObject(stub, async (instance) => {
      instance.setTestNow(restoreTickStart + 5 * MINUTE_MS);
      await instance.alarm();
    });

    const postRestoreErrors = await env.DB.prepare(
      "SELECT count(*) as n FROM spans WHERE service = 'payments-api' AND error_type = 'pool_exhausted' AND start_ms >= ?",
    )
      .bind(restoreTickStart)
      .first<{ n: number }>();
    expect(postRestoreErrors?.n).toBe(0);
  }, 20_000);
});

describe("SimulatorDO reset", () => {
  it(
    "transitions unseeded -> seeding -> running; wipes telemetry; preserves incidents; invokes the real computeBaselines once after the final chunk, leaving baselines non-empty",
    async () => {
      const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("test-reset-1"));

      // Pre-existing rows prove the wipe is scoped to telemetry only.
      await insertSpans(env.DB, [makeSpan(1)]);
      await env.DB.prepare(
        "INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES ('pre-existing', 'resolved', 'warning', 1, '{}')",
      ).run();

      const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // already minute-aligned
      // Wraps (rather than replaces) the real `computeBaselines` (Task 3.1's default hook) so this
      // test both proves the call-count/timing contract (`hookCalls`) AND exercises the real
      // computation, letting the assertion below confirm `baselines` is actually populated after a
      // reset — the carry-forward assertion this task's brief calls for.
      const hookCalls: number[] = [];
      await runInDurableObject(stub, async (instance) => {
        instance.setTestNow(T0);
        instance.recomputeBaselines = async (db, nowMs) => {
          hookCalls.push(nowMs);
          return computeBaselines(db, nowMs);
        };
      });

      const before = await statusOf(stub);
      expect(before.worldStatus).toBe("unseeded");

      const resetRes = await stub.fetch("http://simulator/reset", { method: "POST" });
      expect(resetRes.status).toBe(202);

      const afterReset = await statusOf(stub);
      expect(afterReset.worldStatus).toBe("seeding");
      expect(afterReset.seedProgress).toBe(0);

      const spansAfterWipe = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
      expect(spansAfterWipe?.n).toBe(0);
      const incidentsAfterWipe = await env.DB.prepare("SELECT count(*) as n FROM incidents").first<{ n: number }>();
      expect(incidentsAfterWipe?.n).toBe(1); // pre-existing incident survives the wipe

      // Drive the chunked backfill to completion by invoking alarm() repeatedly (each firing
      // processes exactly one ~4h chunk); 24h / 4h = 6 chunks exactly.
      let status = "seeding";
      let iterations = 0;
      while (status !== "running" && iterations < 10) {
        await runInDurableObject(stub, async (instance, state) => {
          instance.setTestNow(T0);
          await instance.alarm();
          status = (await state.storage.get<string>("worldStatus")) ?? "";
        });
        iterations++;
      }

      expect(status).toBe("running");
      expect(iterations).toBe(6);

      expect(hookCalls).toEqual([T0]); // invoked exactly once, after the final chunk, with backfill's end time

      const incidentsAfterSeed = await env.DB.prepare("SELECT count(*) as n FROM incidents").first<{ n: number }>();
      expect(incidentsAfterSeed?.n).toBe(2); // pre-existing (preserved) + the newly seeded incident

      const spansAfterBackfill = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
      expect(spansAfterBackfill?.n).toBeGreaterThan(0);

      // The detector must never be armed without baselines (spec §6): the synchronous post-backfill
      // recompute above must have actually written rows, not just been invoked.
      const baselinesAfterSeed = await env.DB.prepare("SELECT count(*) as n FROM baselines").first<{ n: number }>();
      expect(baselinesAfterSeed?.n).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe("SimulatorDO reset self-heal", () => {
  it("accepts a new /reset when status is 'resetting' with no pending alarm (wedged), and reaches running", async () => {
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("test-wedge-1"));
    const T0 = Date.UTC(2026, 0, 6, 0, 0, 0); // minute-aligned

    // Simulate the wedge: a previous reset committed status 'resetting' and deleted the alarm,
    // then died before re-arming. lastResetAtMs is recent to prove the escape hatch also bypasses
    // the 10-minute reset cooldown (a wedged world must not stay bricked).
    await runInDurableObject(stub, async (instance, state) => {
      instance.setTestNow(T0);
      await state.storage.put("worldStatus", "resetting");
      await state.storage.put("generation", 3);
      await state.storage.put("lastResetAtMs", T0 - 30_000);
      await state.storage.deleteAlarm();
    });

    const resetRes = await stub.fetch("http://simulator/reset", { method: "POST" });
    expect(resetRes.status).toBe(202);

    const afterReset = await statusOf(stub);
    expect(afterReset.worldStatus).toBe("seeding");
    expect(afterReset.generation).toBe(4); // took over with a fresh generation

    // Sanity: a NON-wedged in-progress state (alarm pending, as /reset just armed one) still 429s.
    const competing = await stub.fetch("http://simulator/reset", { method: "POST" });
    expect(competing.status).toBe(429);

    let status = "seeding";
    for (let i = 0; i < 10 && status !== "running"; i++) {
      await runInDurableObject(stub, async (instance, state) => {
        instance.setTestNow(T0);
        await instance.alarm();
        status = (await state.storage.get<string>("worldStatus")) ?? "";
      });
    }
    expect(status).toBe("running");
  }, 60_000);
});

describe("SimulatorDO idempotent final chunk", () => {
  it("retries the final backfill chunk cleanly after seed rows already committed (crash before the running flip)", async () => {
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("test-idem-1"));
    const T0 = Date.UTC(2026, 0, 6, 12, 0, 0); // minute-aligned

    await runInDurableObject(stub, (instance) => instance.setTestNow(T0));
    const resetRes = await stub.fetch("http://simulator/reset", { method: "POST" });
    expect(resetRes.status).toBe(202);

    // Drive the first 5 of 6 chunks; world is still seeding with only the final chunk left.
    for (let i = 0; i < 5; i++) {
      await runInDurableObject(stub, async (instance) => {
        instance.setTestNow(T0);
        await instance.alarm();
      });
    }
    const beforeFinal = await statusOf(stub);
    expect(beforeFinal.worldStatus).toBe("seeding");
    const cursor = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<{ cursorMs: number; endMs: number }>("backfill"),
    );
    expect(cursor?.endMs).toBe(T0);
    expect(cursor?.cursorMs).toBe(T0 - BACKFILL_CHUNK_MS); // exactly one chunk remaining

    // Simulate "crash after the seed rows committed but before the flip to running": pre-commit
    // the seed rows exactly as the final chunk will (same nowMs => same deterministic ids).
    await insertSeededIncident(env.DB, T0);
    const preSeeded = await env.DB.prepare("SELECT count(*) as n FROM incidents").first<{ n: number }>();
    expect(preSeeded?.n).toBe(1);

    // The retried final chunk must not throw on the PK collisions, and must reach running.
    await runInDurableObject(stub, async (instance) => {
      instance.setTestNow(T0);
      await instance.alarm();
    });

    const after = await statusOf(stub);
    expect(after.worldStatus).toBe("running");

    // Exactly one seeded incident (and its children) — the retry was a clean skip, not a duplicate.
    const incidents = await env.DB.prepare("SELECT count(*) as n FROM incidents WHERE id LIKE 'seed-%'").first<{ n: number }>();
    expect(incidents?.n).toBe(1);
    const steps = await env.DB.prepare("SELECT count(*) as n FROM investigation_steps").first<{ n: number }>();
    expect(steps?.n).toBe(9);
    const fingerprints = await env.DB.prepare("SELECT count(*) as n FROM incident_fingerprints").first<{ n: number }>();
    expect(fingerprints?.n).toBe(3);
    const seedDeploys = await env.DB.prepare("SELECT count(*) as n FROM deploys WHERE id LIKE 'seed-deploy-%'").first<{
      n: number;
    }>();
    expect(seedDeploys?.n).toBe(1);
  }, 60_000);
});

describe("SimulatorDO stale-generation guard", () => {
  it("discards a tick's write if its captured generation no longer matches storage after a reset", async () => {
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("test-stale-gen-1"));

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("worldStatus", "running");
      await state.storage.put("generation", 1);
      await state.storage.put("lastTickMs", PEAK_HOUR_T0);
      instance.setTestNow(PEAK_HOUR_T0);
    });
    const preResetGeneration = 1;

    // A reset lands — bumping generation to 2 and wiping telemetry — as if it happened while a
    // tick that had already captured generation 1 was still in flight.
    await runInDurableObject(stub, (instance) => instance.setTestNow(PEAK_HOUR_T0 + MINUTE_MS));
    const resetRes = await stub.fetch("http://simulator/reset", { method: "POST" });
    expect(resetRes.status).toBe(202);

    const spansAfterReset = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
    expect(spansAfterReset?.n).toBe(0);

    // The stale tick (still holding the pre-reset generation) finally reaches its write check.
    const staleResult = await runInDurableObject(stub, (instance) => instance.runLiveTickForTest(preResetGeneration));
    expect(staleResult.wrote).toBe(false);

    const spansAfterStaleWrite = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
    expect(spansAfterStaleWrite?.n).toBe(0); // discarded — nothing was inserted

    // Sanity check the guard is a real, reachable branch: a matching (current) generation does write.
    const currentResult = await runInDurableObject(stub, (instance) => instance.runLiveTickForTest(2));
    expect(currentResult.wrote).toBe(true);
  });
});

describe("SimulatorDO live metrics (Table 7)", () => {
  it("GET /status omits `live` unless the world is running AND the open minute has accumulated stats", async () => {
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("test-live-1"));

    // Not running yet: `live` omitted even with a partialMinute already sitting in storage.
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("worldStatus", "seeding");
      await state.storage.put("partialMinute", {
        minuteTs: PEAK_HOUR_T0,
        stats: [{ service: "checkout-edge", operation: "place_order", duration_ms: 50, isError: false }],
      });
      instance.setTestNow(PEAK_HOUR_T0 + 15_000);
    });
    expect((await statusOf(stub)).live).toBeUndefined();

    // Running, but the open minute has no accumulated stats at all (no partialMinute key): still omitted.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("worldStatus", "running");
      await state.storage.delete("partialMinute");
    });
    expect((await statusOf(stub)).live).toBeUndefined();
  });

  it("GET /status's `live` aggregates partialMinute per service (count/errPct/p95) with the correct elapsedMs", async () => {
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("test-live-2"));

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("worldStatus", "running");
      await state.storage.put("partialMinute", {
        minuteTs: PEAK_HOUR_T0,
        stats: [
          { service: "checkout-edge", operation: "place_order", duration_ms: 50, isError: false },
          { service: "checkout-edge", operation: "place_order", duration_ms: 150, isError: true },
          { service: "edge-gateway", operation: "GET /", duration_ms: 10, isError: false },
        ],
      });
      instance.setTestNow(PEAK_HOUR_T0 + 15_000); // 15s into the open minute
    });

    const status = await statusOf(stub);
    expect(status.live).toEqual({
      minuteTs: PEAK_HOUR_T0,
      elapsedMs: 15_000,
      services: {
        "checkout-edge": { count: 2, errPct: 50, p95: 150 }, // nearest-rank p95 of [50,150] -> 150
        "edge-gateway": { count: 1, errPct: 0, p95: 10 },
      },
    });

    // The same aggregate is threaded through `/api/state` (routes.test.ts covers the HTTP shape) --
    // this file only proves SimulatorDO's own `/status` body is correct, which `/api/state` passes
    // through verbatim per Table 7.
  });
});
