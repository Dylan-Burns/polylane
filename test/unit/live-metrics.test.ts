import { describe, expect, it } from "vitest";
import type { RequestStat } from "../../src/sim/generator";
import { aggregateLiveServices } from "../../src/sim/simulator-do";

/** Pure unit tests for `aggregateLiveServices` (Table 7's per-service live-metric aggregation over
 * `SimulatorDO`'s in-memory `partialMinute` stats). No D1/DO involved — this is exactly the same
 * kind of pure `RequestStat[] -> ...` reduction `generator.test.ts`'s `rollupFromStats` suite
 * covers, just one aggregation step further (per-service, not per-(service, operation)). The
 * integration coverage for `/status`/`/api/state.live` end-to-end lives in
 * `test/integration/simulator.test.ts` and `test/integration/routes.test.ts`. */

const MIN = 60_000;
const MINUTE_TS = 1_700_000_000_000 - (1_700_000_000_000 % MIN);

describe("aggregateLiveServices (Table 7 live-metric aggregation)", () => {
  it("aggregates a single-operation service to count/errPct/p95 matching rollupFromStats' own nearest-rank p95", () => {
    // Identical fixture shape to generator.test.ts's rollupFromStats "payments-api:charge" group
    // (12 requests, durations 100..210 step 10, 1 error at index 0) -- nearest-rank p95, N=12:
    // rank = ceil(0.95*12) = 12 -> max = 210.
    const stats: RequestStat[] = Array.from({ length: 12 }, (_, i) => ({
      service: "payments-api",
      operation: "charge",
      duration_ms: 100 + i * 10,
      isError: i === 0,
    }));

    const services = aggregateLiveServices(stats, MINUTE_TS);

    expect(Object.keys(services)).toEqual(["payments-api"]);
    expect(services["payments-api"]?.count).toBe(12);
    expect(services["payments-api"]?.errPct).toBeCloseTo((1 / 12) * 100);
    expect(services["payments-api"]?.p95).toBe(210);
  });

  it("count-weight-averages errPct/p95 across a service's multiple operations (same method sparklineSeries/aggregateToServiceMinutes use)", () => {
    // charge: 10 requests, all duration_ms=100 (p95=100), 0 errors.
    const chargeStats: RequestStat[] = Array.from({ length: 10 }, () => ({
      service: "payments-api",
      operation: "charge",
      duration_ms: 100,
      isError: false,
    }));
    // refund: 10 requests, all duration_ms=200 (p95=200), 2 errors.
    const refundStats: RequestStat[] = Array.from({ length: 10 }, (_, i) => ({
      service: "payments-api",
      operation: "refund",
      duration_ms: 200,
      isError: i < 2,
    }));

    const services = aggregateLiveServices([...chargeStats, ...refundStats], MINUTE_TS);

    expect(services["payments-api"]?.count).toBe(20);
    expect(services["payments-api"]?.errPct).toBeCloseTo(10); // 2/20 * 100
    // count-weighted average across the two per-operation p95s: (100*10 + 200*10) / 20 = 150.
    expect(services["payments-api"]?.p95).toBeCloseTo(150);
  });

  it("keeps services separate and reports errPct=0/100 correctly for single-request groups", () => {
    const stats: RequestStat[] = [
      { service: "edge-gateway", operation: "GET /", duration_ms: 20, isError: false },
      { service: "catalog-kv", operation: "list_products", duration_ms: 40, isError: true },
    ];

    const services = aggregateLiveServices(stats, MINUTE_TS);

    expect(Object.keys(services).sort()).toEqual(["catalog-kv", "edge-gateway"]);
    expect(services["edge-gateway"]).toEqual({ count: 1, errPct: 0, p95: 20 });
    expect(services["catalog-kv"]).toEqual({ count: 1, errPct: 100, p95: 40 });
  });

  it("returns an empty object for no stats (the caller — buildLiveMetrics — is what omits `live` entirely)", () => {
    expect(aggregateLiveServices([], MINUTE_TS)).toEqual({});
  });
});
