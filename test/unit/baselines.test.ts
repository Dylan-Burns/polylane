import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { baselineKey, computeBaselines, getBaselines } from "../../src/detect/baselines";
import { insertRollups } from "../../src/telemetry/queries";
import type { RollupRow } from "../../src/telemetry/types";

const T0 = Date.UTC(2026, 0, 5, 14, 0, 0); // minute-aligned
const MIN = 60_000;
const DAY = 24 * 60 * 60 * 1000;

function mkRollup(
  service: string,
  operation: string,
  minuteTs: number,
  count: number,
  errorCount: number,
  p95Ms: number,
): RollupRow {
  return {
    service,
    operation,
    minute_ts: minuteTs,
    count,
    error_count: errorCount,
    p50_ms: p95Ms / 2,
    p95_ms: p95Ms,
    p99_ms: p95Ms * 1.2,
  };
}

async function baselineRow(
  service: string,
  operation: string,
  metric: string,
): Promise<{ median: number; mad: number; computed_at: number } | null> {
  return (
    (await env.DB.prepare("SELECT median, mad, computed_at FROM baselines WHERE service = ? AND operation = ? AND metric = ?")
      .bind(service, operation, metric)
      .first<{ median: number; mad: number; computed_at: number }>()) ?? null
  );
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM rollups");
  await env.DB.exec("DELETE FROM baselines");
});

describe("computeBaselines", () => {
  it("returns 0 and writes nothing for an empty rollups table (no throw)", async () => {
    const written = await computeBaselines(env.DB, T0);
    expect(written).toBe(0);
    const total = await env.DB.prepare("SELECT count(*) as n FROM baselines").first<{ n: number }>();
    expect(total?.n).toBe(0);
  });

  it("computes the standard median (middle element) for an odd number of trailing minutes", async () => {
    // Unsorted insertion order on purpose, to prove the implementation sorts before taking the
    // middle element rather than relying on row order.
    await insertRollups(env.DB, [
      mkRollup("checkout-edge", "POST /checkout", T0 - 3 * MIN, 30, 0, 300),
      mkRollup("checkout-edge", "POST /checkout", T0 - 2 * MIN, 10, 0, 100),
      mkRollup("checkout-edge", "POST /checkout", T0 - 1 * MIN, 20, 0, 200),
    ]);

    const written = await computeBaselines(env.DB, T0);
    expect(written).toBe(4); // req_rate + error_rate + p95 + p50

    const reqRate = await baselineRow("checkout-edge", "POST /checkout", "req_rate");
    expect(reqRate).toEqual({ median: 20, mad: 10, computed_at: T0 }); // sorted [10,20,30]; devs [10,0,10] -> median 10

    const p95 = await baselineRow("checkout-edge", "POST /checkout", "p95");
    expect(p95).toEqual({ median: 200, mad: 100, computed_at: T0 });

    // mkRollup sets p50_ms = p95Ms / 2, so the p50 series is [150, 50, 100] -> median 100, MAD 50.
    const p50 = await baselineRow("checkout-edge", "POST /checkout", "p50");
    expect(p50).toEqual({ median: 100, mad: 50, computed_at: T0 });

    const errorRate = await baselineRow("checkout-edge", "POST /checkout", "error_rate");
    expect(errorRate).toEqual({ median: 0, mad: 0, computed_at: T0 }); // all error_count 0
  });

  it("computes the mean-of-two-middles median for an even number of trailing minutes", async () => {
    await insertRollups(env.DB, [
      mkRollup("catalog-kv", "GET /catalog", T0 - 4 * MIN, 10, 0, 0),
      mkRollup("catalog-kv", "GET /catalog", T0 - 3 * MIN, 40, 0, 0),
      mkRollup("catalog-kv", "GET /catalog", T0 - 2 * MIN, 20, 0, 0),
      mkRollup("catalog-kv", "GET /catalog", T0 - 1 * MIN, 30, 0, 0),
    ]);

    const reqRate = await (async () => {
      await computeBaselines(env.DB, T0);
      return baselineRow("catalog-kv", "GET /catalog", "req_rate");
    })();

    // sorted [10,20,30,40] -> median (20+30)/2 = 25
    // deviations |10-25|=15,|20-25|=5,|30-25|=5,|40-25|=15 -> sorted [5,5,15,15] -> MAD (5+15)/2=10
    expect(reqRate).toEqual({ median: 25, mad: 10, computed_at: T0 });
  });

  it("MAD is 0 for a flat series (every minute identical)", async () => {
    await insertRollups(env.DB, [
      mkRollup("payments-api", "charge", T0 - 3 * MIN, 50, 2, 90),
      mkRollup("payments-api", "charge", T0 - 2 * MIN, 50, 2, 90),
      mkRollup("payments-api", "charge", T0 - 1 * MIN, 50, 2, 90),
    ]);

    await computeBaselines(env.DB, T0);
    const reqRate = await baselineRow("payments-api", "charge", "req_rate");
    expect(reqRate).toEqual({ median: 50, mad: 0, computed_at: T0 });
    const p95 = await baselineRow("payments-api", "charge", "p95");
    expect(p95).toEqual({ median: 90, mad: 0, computed_at: T0 });
    const p50 = await baselineRow("payments-api", "charge", "p50");
    expect(p50).toEqual({ median: 45, mad: 0, computed_at: T0 });
  });

  it("excludes count=0 minutes from error_rate but still includes them (as 0) in req_rate/p95", async () => {
    await insertRollups(env.DB, [
      mkRollup("notify", "send_receipt", T0 - 3 * MIN, 100, 5, 100), // error_rate 0.05
      mkRollup("notify", "send_receipt", T0 - 2 * MIN, 0, 0, 40), // excluded from error_rate
      mkRollup("notify", "send_receipt", T0 - 1 * MIN, 50, 0, 60), // error_rate 0
    ]);

    const written = await computeBaselines(env.DB, T0);
    expect(written).toBe(4);

    // req_rate includes the zero-traffic minute as a literal 0: sorted [0,50,100] -> median 50.
    const reqRate = await baselineRow("notify", "send_receipt", "req_rate");
    expect(reqRate?.median).toBe(50);

    // error_rate only sees [0.05, 0] (the count=0 minute excluded) -> mean-of-two-middles.
    const errorRate = await baselineRow("notify", "send_receipt", "error_rate");
    expect(errorRate?.median).toBeCloseTo(0.025);
  });

  it("writes no error_rate row at all when every minute in the window had zero traffic", async () => {
    await insertRollups(env.DB, [
      mkRollup("idle-service", "noop", T0 - 2 * MIN, 0, 0, 0),
      mkRollup("idle-service", "noop", T0 - 1 * MIN, 0, 0, 0),
    ]);

    const written = await computeBaselines(env.DB, T0);
    expect(written).toBe(3); // req_rate + p95 + p50 only, no error_rate

    const errorRate = await baselineRow("idle-service", "noop", "error_rate");
    expect(errorRate).toBeNull();
    const reqRate = await baselineRow("idle-service", "noop", "req_rate");
    expect(reqRate).toEqual({ median: 0, mad: 0, computed_at: T0 });
  });

  it("respects the trailing-24h half-open window: [nowMs-24h, nowMs) — includes the lower boundary, excludes the upper", async () => {
    await insertRollups(env.DB, [
      mkRollup("edge-svc", "op", T0 - DAY - MIN, 999, 0, 0), // just outside (too old) — excluded
      mkRollup("edge-svc", "op", T0 - DAY, 42, 0, 0), // exactly the lower boundary — included
      mkRollup("edge-svc", "op", T0, 888, 0, 0), // exactly `nowMs` — excluded (half-open upper bound)
    ]);

    await computeBaselines(env.DB, T0);
    const reqRate = await baselineRow("edge-svc", "op", "req_rate");
    // If either excluded row leaked in, the median would not be a clean single-value 42.
    expect(reqRate).toEqual({ median: 42, mad: 0, computed_at: T0 });
  });

  it("REPLACE semantics: recomputing overwrites existing rows for the same key — no duplicates", async () => {
    const service = "svc-replace";
    const operation = "op-replace";
    await insertRollups(env.DB, [
      mkRollup(service, operation, T0 - 2 * MIN, 10, 0, 100),
      mkRollup(service, operation, T0 - 1 * MIN, 20, 0, 200),
    ]);

    const firstWritten = await computeBaselines(env.DB, T0);
    expect(firstWritten).toBe(4);
    const rowCountAfterFirst = await env.DB.prepare(
      "SELECT count(*) as n FROM baselines WHERE service = ? AND operation = ?",
    )
      .bind(service, operation)
      .first<{ n: number }>();
    expect(rowCountAfterFirst?.n).toBe(4);
    expect((await baselineRow(service, operation, "req_rate"))?.median).toBe(15); // median of [10,20]

    // A new rollup minute lands, and time advances — still within the trailing 24h of everything
    // above, so the recompute sees three data points instead of two.
    await insertRollups(env.DB, [mkRollup(service, operation, T0, 90, 0, 300)]);
    const secondWritten = await computeBaselines(env.DB, T0 + MIN);
    expect(secondWritten).toBe(4);

    const rowCountAfterSecond = await env.DB.prepare(
      "SELECT count(*) as n FROM baselines WHERE service = ? AND operation = ?",
    )
      .bind(service, operation)
      .first<{ n: number }>();
    expect(rowCountAfterSecond?.n).toBe(4); // still 4 rows, not 8 — REPLACE, not INSERT

    const reqRateAfterSecond = await baselineRow(service, operation, "req_rate");
    expect(reqRateAfterSecond?.median).toBe(20); // sorted [10,20,90] -> median 20
    expect(reqRateAfterSecond?.computed_at).toBe(T0 + MIN); // computed_at refreshed
  });

  it("writes independent rows per (service, operation) group in the same window", async () => {
    await insertRollups(env.DB, [
      mkRollup("service-a", "op-a", T0 - MIN, 10, 0, 10),
      mkRollup("service-b", "op-b", T0 - MIN, 999, 0, 999),
    ]);
    const written = await computeBaselines(env.DB, T0);
    expect(written).toBe(8); // 4 metrics x 2 groups

    expect((await baselineRow("service-a", "op-a", "req_rate"))?.median).toBe(10);
    expect((await baselineRow("service-b", "op-b", "req_rate"))?.median).toBe(999);
  });
});

describe("getBaselines", () => {
  it("returns an empty map when the baselines table is empty", async () => {
    const map = await getBaselines(env.DB);
    expect(map.size).toBe(0);
  });

  it("round-trips computeBaselines' output, keyed by baselineKey(service, operation, metric)", async () => {
    await insertRollups(env.DB, [mkRollup("checkout-edge", "POST /checkout", T0 - MIN, 100, 5, 150)]);
    await computeBaselines(env.DB, T0);

    const map = await getBaselines(env.DB);
    expect(map.size).toBe(4);
    expect(map.get(baselineKey("checkout-edge", "POST /checkout", "req_rate"))).toEqual({ median: 100, mad: 0 });
    expect(map.get(baselineKey("checkout-edge", "POST /checkout", "error_rate"))).toEqual({ median: 0.05, mad: 0 });
    expect(map.get(baselineKey("checkout-edge", "POST /checkout", "p95"))).toEqual({ median: 150, mad: 0 });
    expect(map.get(baselineKey("checkout-edge", "POST /checkout", "p50"))).toEqual({ median: 75, mad: 0 });
    expect(map.get(baselineKey("checkout-edge", "POST /checkout", "req_rate" as const))).not.toBeUndefined();
    expect(map.get("nonexistent:key:req_rate")).toBeUndefined();
  });
});

describe("baselineKey", () => {
  it("joins service, operation, metric with ':'", () => {
    expect(baselineKey("checkout-edge", "POST /checkout", "p95")).toBe("checkout-edge:POST /checkout:p95");
  });
});
