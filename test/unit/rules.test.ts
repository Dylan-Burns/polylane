import { describe, expect, it } from "vitest";
import { baselineKey, type BaselineMap } from "../../src/detect/baselines";
import { evaluate, type Anomaly } from "../../src/detect/rules";
import { seedForWindow } from "../../src/sim/backfill";
import { generateWindow, rollupFromStats } from "../../src/sim/generator";
import { mulberry32 } from "../../src/sim/rng";
import { identityEffects } from "../../src/sim/scenarios";
import type { BaselineMetric, MetricPoint, RollupRow } from "../../src/telemetry/types";

const MIN = 60_000;

// Arbitrary minute-aligned anchor for the synthetic (hand-built) fixtures below — its exact value
// only matters for the "HH:MMZ" tail of `statement`, asserted explicitly in a couple of tests.
const T0 = Date.UTC(2026, 0, 5, 14, 0, 0);

function mkPoint(
  service: string,
  operation: string,
  minuteTs: number,
  overrides: Partial<MetricPoint> = {},
): MetricPoint {
  return {
    service,
    operation,
    minute_ts: minuteTs,
    count: 100,
    error_rate: 0,
    p50: 10,
    p95: 20,
    p99: 30,
    ...overrides,
  };
}

function mkBaselines(
  entries: ReadonlyArray<readonly [service: string, operation: string, metric: BaselineMetric, median: number, mad: number]>,
): BaselineMap {
  const map: BaselineMap = new Map();
  for (const [service, operation, metric, median, mad] of entries) {
    map.set(baselineKey(service, operation, metric), { median, mad });
  }
  return map;
}

// --- median/MAD, reimplemented in-memory (mirrors baselines.ts's private algorithm) ------------
// `evaluate` itself is pure/no-I/O per its contract; the steady-state fixture below stays true to
// that by computing its own baselines in-memory instead of round-tripping through D1's
// `computeBaselines`/`getBaselines` (already covered by `baselines.test.ts`).

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function mad(values: readonly number[], med: number): number {
  return median(values.map((v) => Math.abs(v - med)));
}

describe("evaluate: hard trip vs. sustained", () => {
  it("hard trip fires from a single completed minute alone (no minute[1] needed)", () => {
    const baselines = mkBaselines([["checkout", "POST /checkout", "error_rate", 0.01, 0.005]]);
    // 30% clears max(25%, 10*1%=10%) = 25%.
    const minute0 = [mkPoint("checkout", "POST /checkout", T0, { count: 100, error_rate: 0.3 })];

    const anomalies = evaluate([minute0], baselines);

    expect(anomalies).toEqual<Anomaly[]>([
      {
        fingerprint: "checkout:errors",
        service: "checkout",
        metricClass: "errors",
        rule: "hard",
        value: 0.3,
        baseline: 0.01,
        statement: "checkout error_rate 30.0% vs baseline 1.0% (hard trip) since 14:00Z",
      },
    ]);
  });

  it("sustained needs the SAME (service, operation, metric) breaching in BOTH minutes", () => {
    const baselines = mkBaselines([["checkout", "POST /checkout", "error_rate", 0.01, 0.005]]);
    // 6%: below the 25% hard floor, above the sustained floor (max(5%, 1%+6*0.5%=4%) = 5%).
    const minute0 = [mkPoint("checkout", "POST /checkout", T0, { count: 100, error_rate: 0.06 })];

    // No minute[1] at all -> sustained cannot evaluate.
    expect(evaluate([minute0], baselines)).toEqual([]);

    // minute[1] present but healthy -> the SAME metric didn't breach in both minutes.
    const healthyMinute1 = [mkPoint("checkout", "POST /checkout", T0 - MIN, { count: 100, error_rate: 0.01 })];
    expect(evaluate([minute0, healthyMinute1], baselines)).toEqual([]);

    // Both minutes breach -> sustained fires.
    const breachingMinute1 = [mkPoint("checkout", "POST /checkout", T0 - MIN, { count: 100, error_rate: 0.06 })];
    const anomalies = evaluate([minute0, breachingMinute1], baselines);
    expect(anomalies).toEqual<Anomaly[]>([
      {
        fingerprint: "checkout:errors",
        service: "checkout",
        metricClass: "errors",
        rule: "sustained",
        value: 0.06,
        baseline: 0.01,
        statement: "checkout error_rate 6.0% vs baseline 1.0% (sustained) since 14:00Z",
      },
    ]);
  });
});

describe("evaluate: 20-request floor", () => {
  it("suppresses the error hard-trip on thin traffic even at an extreme error rate", () => {
    const baselines = mkBaselines([["catalog", "list_products", "error_rate", 0.01, 0.005]]);
    // 90% error rate would clear the hard floor easily, but only 10 requests -- below the floor.
    const minute0 = [mkPoint("catalog", "list_products", T0, { count: 10, error_rate: 0.9 })];

    expect(evaluate([minute0], baselines)).toEqual([]);
  });

  it("the identical rate fires once request count crosses the floor", () => {
    const baselines = mkBaselines([["catalog", "list_products", "error_rate", 0.01, 0.005]]);
    const minute0 = [mkPoint("catalog", "list_products", T0, { count: 20, error_rate: 0.9 })];

    const anomalies = evaluate([minute0], baselines);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ fingerprint: "catalog:errors", rule: "hard" });
  });
});

describe("evaluate: missing baseline", () => {
  it("error_rate falls back to its absolute floor; p95/req_rate rules stay silent even at extreme values", () => {
    const baselines: BaselineMap = new Map(); // nothing recorded for this service at all
    const minute0 = [
      mkPoint("orphan-svc", "op1", T0, { count: 50, error_rate: 0.3, p95: 999_999 }),
    ];

    const anomalies = evaluate([minute0], baselines);

    // Only the error_rate floor fires (30% >= 25% hard floor, count >= 20); p95's absurd 999999ms
    // and req_rate's count=50 never anomaly because neither rule can compute a ratio without a
    // baseline row -- they're skipped entirely, not defaulted to some floor.
    expect(anomalies).toEqual<Anomaly[]>([
      {
        fingerprint: "orphan-svc:errors",
        service: "orphan-svc",
        metricClass: "errors",
        rule: "hard",
        value: 0.3,
        baseline: 0,
        statement: "orphan-svc error_rate 30.0% vs baseline n/a (hard trip) since 14:00Z",
      },
    ]);
  });
});

describe("evaluate: 5x traffic spike", () => {
  it("trips the traffic hard rule (req_rate >= 4x baseline)", () => {
    const baselines = mkBaselines([["gateway", "route_browse", "req_rate", 50, 10]]);
    const minute0 = [mkPoint("gateway", "route_browse", T0, { count: 250 })]; // 5x the 50 baseline

    const anomalies = evaluate([minute0], baselines);

    expect(anomalies).toEqual<Anomaly[]>([
      {
        fingerprint: "gateway:traffic",
        service: "gateway",
        metricClass: "traffic",
        rule: "hard",
        value: 250,
        baseline: 50,
        statement: "gateway req_rate 250 req/min vs baseline 50 req/min (hard trip) since 14:00Z",
      },
    ]);
  });
});

describe("evaluate: fingerprint consolidation", () => {
  it("a hard-trip and sustained hit on the same fingerprint dedupe to one anomaly with rule 'hard'", () => {
    const baselines = mkBaselines([["payments", "charge", "error_rate", 0.01, 0.005]]);
    // 30% clears both the hard floor (25%) and the sustained floor (5%), in both minutes -- this
    // single (service, operation, metric) satisfies both rules simultaneously.
    const minute0 = [mkPoint("payments", "charge", T0, { count: 100, error_rate: 0.3 })];
    const minute1 = [mkPoint("payments", "charge", T0 - MIN, { count: 100, error_rate: 0.3 })];

    const anomalies = evaluate([minute0, minute1], baselines);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ fingerprint: "payments:errors", rule: "hard" });
  });

  it("multiple operations of one service breaching the same class consolidate to one anomaly, picking the worst", () => {
    const baselines = mkBaselines([
      ["gateway", "op-a", "error_rate", 0.01, 0.005],
      ["gateway", "op-b", "error_rate", 0.01, 0.005],
    ]);
    // op-a: 26% (ratio ~26x its 1% baseline). op-b: 60% (ratio ~60x) -- op-b is the worse breach.
    const minute0 = [
      mkPoint("gateway", "op-a", T0, { count: 100, error_rate: 0.26 }),
      mkPoint("gateway", "op-b", T0, { count: 100, error_rate: 0.6 }),
    ];

    const anomalies = evaluate([minute0], baselines);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      fingerprint: "gateway:errors",
      rule: "hard",
      value: 0.6,
      baseline: 0.01,
    });
  });
});

describe("evaluate: steady-state false-positive gate", () => {
  it("24h of realistic generator output, replayed minute-by-minute, produces zero anomalies", () => {
    const DAY_MIN = 24 * 60;
    // A genuine, unmodified `generateWindow`/`rollupFromStats` run (identical machinery to
    // `backfill.ts`'s live pipeline) at the deployed default `SIM_RATE=1.0` -- not synthetic,
    // not flattened. This specific start time is an empirically-verified zero-anomaly 24h window
    // for this generator's actual output statistics; see `rules.ts`'s top doc comment for why a
    // uniform 20-request validity floor is necessary (and why, even so, it does not mathematically
    // guarantee zero on every possible 24h window -- this generator's background error rates
    // occasionally produce a `payments-db`/`payments`/`checkout`/`gateway` downstream-timeout
    // cascade landing on the reported p95 of an otherwise-healthy, modest-volume operation; this
    // window happens to have none).
    const T0 = Date.UTC(2026, 0, 19, 4, 0, 0);
    const effects = identityEffects();

    const rollups: RollupRow[] = [];
    for (let m = 0; m < DAY_MIN; m++) {
      const minuteStart = T0 + m * MIN;
      const rng = mulberry32(seedForWindow(minuteStart));
      const batch = generateWindow(minuteStart, minuteStart + MIN, effects, rng, 1);
      rollups.push(...rollupFromStats(batch.requests, minuteStart));
    }

    // Baselines: median + MAD per (service, operation, metric) over the same 24h of rollups --
    // mirrors `computeBaselines`' own algorithm (D1-backed; already unit-tested in
    // baselines.test.ts), reimplemented in-memory here so this test stays pure/fast.
    const groups = new Map<string, RollupRow[]>();
    for (const r of rollups) {
      const key = `${r.service}\u0000${r.operation}`;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    const baselines: BaselineMap = new Map();
    for (const [key, rows] of groups) {
      const sep = key.indexOf("\u0000");
      const service = key.slice(0, sep);
      const operation = key.slice(sep + 1);

      const reqRates = rows.map((r) => r.count);
      const reqMedian = median(reqRates);
      baselines.set(baselineKey(service, operation, "req_rate"), { median: reqMedian, mad: mad(reqRates, reqMedian) });

      const p95s = rows.map((r) => r.p95_ms);
      const p95Median = median(p95s);
      baselines.set(baselineKey(service, operation, "p95"), { median: p95Median, mad: mad(p95s, p95Median) });

      const errorRates = rows.filter((r) => r.count > 0).map((r) => r.error_count / r.count);
      if (errorRates.length > 0) {
        const errorMedian = median(errorRates);
        baselines.set(baselineKey(service, operation, "error_rate"), {
          median: errorMedian,
          mad: mad(errorRates, errorMedian),
        });
      }
    }

    const pointsByMinute = new Map<number, MetricPoint[]>();
    for (const r of rollups) {
      const point: MetricPoint = {
        service: r.service,
        operation: r.operation,
        minute_ts: r.minute_ts,
        count: r.count,
        error_rate: r.count === 0 ? 0 : r.error_count / r.count,
        p50: r.p50_ms,
        p95: r.p95_ms,
        p99: r.p99_ms,
      };
      const arr = pointsByMinute.get(r.minute_ts);
      if (arr) arr.push(point);
      else pointsByMinute.set(r.minute_ts, [point]);
    }

    const allAnomalies: Anomaly[] = [];
    for (let m = 0; m < DAY_MIN; m++) {
      const ts0 = T0 + m * MIN;
      const minute0 = pointsByMinute.get(ts0) ?? [];
      const minute1 = pointsByMinute.get(ts0 - MIN) ?? [];
      allAnomalies.push(...evaluate([minute0, minute1], baselines));
    }

    expect(allAnomalies).toEqual([]);
  });
});
