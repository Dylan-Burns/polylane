import { describe, expect, it } from "vitest";
import { baselineKey, type BaselineMap } from "../../src/detect/baselines";
import { breachesSustainedThreshold, evaluate, type Anomaly } from "../../src/detect/rules";
import { seedForWindow } from "../../src/sim/backfill";
import { generateWindow, rollupFromStats } from "../../src/sim/generator";
import { mulberry32 } from "../../src/sim/rng";
import { effectsFor, identityEffects, type FaultState, type ScenarioId } from "../../src/sim/scenarios";
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

// --- Simulation harness shared by the FP and FN validation suites ------------------------------
// `evaluate` itself is pure/no-I/O per its contract; both validation suites stay true to that by
// computing baselines in-memory (median+MAD, mirroring `computeBaselines`' D1-backed algorithm,
// which `baselines.test.ts` already covers) instead of round-tripping through D1.

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

/** One healthy minute of rollups, deterministic per timestamp — the exact seed convention
 * `backfill.ts` uses (`mulberry32(seedForWindow(minuteStart))`), so these fixtures are the same
 * synthetic history a real backfilled world would carry. */
function healthyMinute(minuteStart: number): RollupRow[] {
  const rng = mulberry32(seedForWindow(minuteStart));
  const batch = generateWindow(minuteStart, minuteStart + MIN, identityEffects(), rng, 1);
  return rollupFromStats(batch.requests, minuteStart);
}

/** One fault-affected minute: three 20s sub-windows with `effectsFor` evaluated at each
 * sub-window's END, mirroring `SimulatorDO.runLiveTick`'s ~20s tick loop ("effects evaluated once
 * per sub-window at its end") — so ramping scenarios (latency-creep) and delayed-onset scenarios
 * (bad-deploy's 30s fuse) are discretized exactly as production would discretize them. The seed is
 * xored so the fault minute never replays the healthy minute's rng stream for the same ts. */
function faultMinute(minuteStart: number, fault: FaultState): RollupRow[] {
  const rng = mulberry32(seedForWindow(minuteStart) ^ 0x5eed);
  const stats = [];
  for (let sub = 0; sub < 3; sub++) {
    const from = minuteStart + sub * 20_000;
    const to = from + 20_000;
    const batch = generateWindow(from, to, effectsFor(fault, to), rng, 1);
    stats.push(...batch.requests);
  }
  return rollupFromStats(stats, minuteStart);
}

/** Median + MAD per (service, operation, metric ∈ {req_rate, error_rate, p95, p50}) over
 * `rollups` — the in-memory mirror of `computeBaselines` (same medians, same count>0 exclusion
 * for error_rate). */
function baselinesFrom(rollups: readonly RollupRow[]): BaselineMap {
  const groups = new Map<string, { service: string; operation: string; rows: RollupRow[] }>();
  for (const r of rollups) {
    const key = `${r.service} ${r.operation}`;
    let g = groups.get(key);
    if (!g) {
      g = { service: r.service, operation: r.operation, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  const map: BaselineMap = new Map();
  for (const { service, operation, rows } of groups.values()) {
    const reqRates = rows.map((r) => r.count);
    const reqMed = median(reqRates);
    map.set(baselineKey(service, operation, "req_rate"), { median: reqMed, mad: mad(reqRates, reqMed) });

    const p95s = rows.map((r) => r.p95_ms);
    const p95Med = median(p95s);
    map.set(baselineKey(service, operation, "p95"), { median: p95Med, mad: mad(p95s, p95Med) });

    const p50s = rows.map((r) => r.p50_ms);
    const p50Med = median(p50s);
    map.set(baselineKey(service, operation, "p50"), { median: p50Med, mad: mad(p50s, p50Med) });

    const errRates = rows.filter((r) => r.count > 0).map((r) => r.error_count / r.count);
    if (errRates.length > 0) {
      const errMed = median(errRates);
      map.set(baselineKey(service, operation, "error_rate"), { median: errMed, mad: mad(errRates, errMed) });
    }
  }
  return map;
}

function toPoints(rollups: readonly RollupRow[]): MetricPoint[] {
  return rollups.map((r) => ({
    service: r.service,
    operation: r.operation,
    minute_ts: r.minute_ts,
    count: r.count,
    error_rate: r.count === 0 ? 0 : r.error_count / r.count,
    p50: r.p50_ms,
    p95: r.p95_ms,
    p99: r.p99_ms,
  }));
}

// --- Unit fixtures: hard vs sustained, evidence gates, consolidation ---------------------------

describe("evaluate: hard trip vs. sustained", () => {
  it("hard trip fires from a single completed minute alone (no minute[1] needed)", () => {
    const baselines = mkBaselines([["checkout-edge", "POST /checkout", "error_rate", 0.01, 0.005]]);
    // 30% clears max(25%, 10*1%=10%) = 25%, with 30 errors clearing the >= 3-error evidence gate.
    const minute0 = [mkPoint("checkout-edge", "POST /checkout", T0, { count: 100, error_rate: 0.3 })];

    const anomalies = evaluate([minute0], baselines);

    expect(anomalies).toEqual<Anomaly[]>([
      {
        fingerprint: "checkout-edge:errors",
        service: "checkout-edge",
        metricClass: "errors",
        rule: "hard",
        value: 0.3,
        baseline: 0.01,
        statement: "checkout-edge error_rate 30.0% vs baseline 1.0% (hard trip) since 14:00Z",
      },
    ]);
  });

  it("sustained needs the SAME (service, operation, metric) breaching in BOTH minutes", () => {
    const baselines = mkBaselines([["checkout-edge", "POST /checkout", "error_rate", 0.01, 0.005]]);
    // 6%: below the 25% hard floor, above the sustained floor (max(5%, 1%+6*0.5%=4%) = 5%), and
    // 6 errors/minute clears the >= 3-per-minute evidence gate.
    const minute0 = [mkPoint("checkout-edge", "POST /checkout", T0, { count: 100, error_rate: 0.06 })];

    // No minute[1] at all -> sustained cannot evaluate.
    expect(evaluate([minute0], baselines)).toEqual([]);

    // minute[1] present but healthy -> the SAME metric didn't breach in both minutes.
    const healthyMinute1 = [mkPoint("checkout-edge", "POST /checkout", T0 - MIN, { count: 100, error_rate: 0.01 })];
    expect(evaluate([minute0, healthyMinute1], baselines)).toEqual([]);

    // Both minutes breach -> sustained fires.
    const breachingMinute1 = [mkPoint("checkout-edge", "POST /checkout", T0 - MIN, { count: 100, error_rate: 0.06 })];
    const anomalies = evaluate([minute0, breachingMinute1], baselines);
    expect(anomalies).toEqual<Anomaly[]>([
      {
        fingerprint: "checkout-edge:errors",
        service: "checkout-edge",
        metricClass: "errors",
        rule: "sustained",
        value: 0.06,
        baseline: 0.01,
        statement: "checkout-edge error_rate 6.0% vs baseline 1.0% (sustained) since 14:00Z",
      },
    ]);
  });
});

describe("breachesSustainedThreshold: the /api/state amber pre-incident check", () => {
  it("true for a single minute alone that clears the sustained ratio + evidence gate", () => {
    const baselines = mkBaselines([["checkout-edge", "POST /checkout", "error_rate", 0.01, 0.005]]);
    // 6%: above the sustained floor (max(5%, 1%+6*0.5%=4%) = 5%), 6 errors clears the >=3 gate --
    // identical fixture to the "sustained needs the SAME ... in BOTH minutes" test above, but here
    // asserting the single-minute half fires on its own, with no second minute involved at all.
    const point = mkPoint("checkout-edge", "POST /checkout", T0, { count: 100, error_rate: 0.06 });
    expect(breachesSustainedThreshold(point, baselines)).toBe(true);
  });

  it("false in steady state (well under every sustained floor)", () => {
    const baselines = mkBaselines([["checkout-edge", "POST /checkout", "error_rate", 0.01, 0.005]]);
    const point = mkPoint("checkout-edge", "POST /checkout", T0, { count: 100, error_rate: 0.01 });
    expect(breachesSustainedThreshold(point, baselines)).toBe(false);
  });

  it("false when the ratio breaches but the evidence gate (>= 3 errors) doesn't", () => {
    const baselines = mkBaselines([["payments-api", "charge", "error_rate", 0.005, 0.002]]);
    // 10% clears the sustained ratio, but only 2 errors -- below the >= 3-error evidence gate.
    const point = mkPoint("payments-api", "charge", T0, { count: 20, error_rate: 0.1 });
    expect(breachesSustainedThreshold(point, baselines)).toBe(false);
  });

  it("true for a hard-trip-level breach too (a bigger breach still clears the looser sustained gate)", () => {
    const baselines = mkBaselines([["checkout-edge", "POST /checkout", "error_rate", 0.01, 0.005]]);
    const point = mkPoint("checkout-edge", "POST /checkout", T0, { count: 100, error_rate: 0.3 });
    expect(breachesSustainedThreshold(point, baselines)).toBe(true);
  });

  it("checks every metric class, e.g. a latency breach with p50 confirmation", () => {
    const baselines = mkBaselines([
      ["ledger-db", "query_ledger", "p95", 30, 5],
      ["ledger-db", "query_ledger", "p50", 12, 2],
    ]);
    const point = mkPoint("ledger-db", "query_ledger", T0, { count: 15, p50: 24, p95: 90 }); // p95 3x (> 2.5x), p50 2x confirms
    expect(breachesSustainedThreshold(point, baselines)).toBe(true);
  });
});

describe("evaluate: error-count evidence gates", () => {
  it("suppresses the error hard-trip on thin evidence even at an extreme rate (2 errors < 3)", () => {
    const baselines = mkBaselines([["catalog-kv", "list_products", "error_rate", 0.01, 0.005]]);
    // 25% error rate clears the ratio threshold, but 2 errors are below the >= 3-error gate.
    const minute0 = [mkPoint("catalog-kv", "list_products", T0, { count: 8, error_rate: 0.25 })];

    expect(evaluate([minute0], baselines)).toEqual([]);
  });

  it("the identical rate fires once the error count crosses the >= 3 evidence gate", () => {
    const baselines = mkBaselines([["catalog-kv", "list_products", "error_rate", 0.01, 0.005]]);
    const minute0 = [mkPoint("catalog-kv", "list_products", T0, { count: 12, error_rate: 0.25 })]; // 3 errors

    const anomalies = evaluate([minute0], baselines);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ fingerprint: "catalog-kv:errors", rule: "hard" });
  });

  it("sustained needs >= 3 errors in EACH minute, not just a breaching rate", () => {
    const baselines = mkBaselines([["payments-api", "charge", "error_rate", 0.005, 0.002]]);
    // 10% rate breaches the sustained threshold in both minutes, but with only 2 errors/minute.
    const thin0 = [mkPoint("payments-api", "charge", T0, { count: 20, error_rate: 0.1 })];
    const thin1 = [mkPoint("payments-api", "charge", T0 - MIN, { count: 20, error_rate: 0.1 })];
    expect(evaluate([thin0, thin1], baselines)).toEqual([]);

    // Same rate with 3 errors per minute -> fires.
    const solid0 = [mkPoint("payments-api", "charge", T0, { count: 30, error_rate: 0.1 })];
    const solid1 = [mkPoint("payments-api", "charge", T0 - MIN, { count: 30, error_rate: 0.1 })];
    const anomalies = evaluate([solid0, solid1], baselines);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ fingerprint: "payments-api:errors", rule: "sustained" });
  });
});

describe("evaluate: p50 distribution-shift confirmation (latency)", () => {
  const baselines = mkBaselines([
    ["ledger-db", "query_ledger", "p95", 30, 5],
    ["ledger-db", "query_ledger", "p50", 12, 2],
  ]);

  it("a lone-outlier p95 spike without a p50 shift never fires (the outlier-killer)", () => {
    // p95 100x baseline — the classic single-3s-timeout signature — but p50 dead on baseline.
    const minute0 = [mkPoint("ledger-db", "query_ledger", T0, { count: 15, p50: 12, p95: 3000 })];
    expect(evaluate([minute0], baselines)).toEqual([]);
  });

  it("the same p95 spike WITH a >= 2x p50 shift fires the hard rule", () => {
    const minute0 = [mkPoint("ledger-db", "query_ledger", T0, { count: 15, p50: 24, p95: 3000 })];
    const anomalies = evaluate([minute0], baselines);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      fingerprint: "ledger-db:latency",
      rule: "hard",
      value: 3000,
      baseline: 30,
    });
  });

  it("suppressed below the 5-request sample floor even with both ratios breaching", () => {
    const minute0 = [mkPoint("ledger-db", "query_ledger", T0, { count: 4, p50: 48, p95: 3000 })];
    expect(evaluate([minute0], baselines)).toEqual([]);
  });

  it("sustained latency requires the p50 confirmation in BOTH minutes", () => {
    // p95 3x baseline both minutes (> 2.5x), but minute[1]'s p50 is at baseline -> silent.
    const m0 = [mkPoint("ledger-db", "query_ledger", T0, { count: 15, p50: 24, p95: 90 })];
    const m1NoShift = [mkPoint("ledger-db", "query_ledger", T0 - MIN, { count: 15, p50: 12, p95: 90 })];
    expect(evaluate([m0, m1NoShift], baselines)).toEqual([]);

    const m1Shifted = [mkPoint("ledger-db", "query_ledger", T0 - MIN, { count: 15, p50: 24, p95: 90 })];
    const anomalies = evaluate([m0, m1Shifted], baselines);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ fingerprint: "ledger-db:latency", rule: "sustained" });
  });
});

describe("evaluate: missing baseline", () => {
  it("error_rate falls back to its absolute floor; latency and traffic stay silent even at extreme values", () => {
    const baselines: BaselineMap = new Map(); // nothing recorded for this service at all
    const minute0 = [
      mkPoint("orphan-svc", "op1", T0, { count: 50, error_rate: 0.3, p50: 999_999, p95: 999_999 }),
    ];

    const anomalies = evaluate([minute0], baselines);

    // Only the error_rate floor fires (30% >= 25%, 15 errors >= 3); the absurd p50/p95 and the
    // count of 50 never anomaly because latency needs both p95+p50 baseline rows and traffic
    // needs req_rate's — they're skipped entirely, not defaulted to some floor.
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

  it("latency needs BOTH p95 and p50 baseline rows — p95 alone is not enough", () => {
    const p95Only = mkBaselines([["catalog-kv", "get_product", "p95", 20, 4]]);
    const minute0 = [mkPoint("catalog-kv", "get_product", T0, { count: 30, p50: 100, p95: 400 })];
    expect(evaluate([minute0], p95Only)).toEqual([]);

    const both = mkBaselines([
      ["catalog-kv", "get_product", "p95", 20, 4],
      ["catalog-kv", "get_product", "p50", 8, 2],
    ]);
    const anomalies = evaluate([minute0], both);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ fingerprint: "catalog-kv:latency", rule: "hard" });
  });
});

describe("evaluate: traffic rules", () => {
  it("5x traffic trips the traffic hard rule (>= 4x baseline with >= 20 requests)", () => {
    const baselines = mkBaselines([["edge-gateway", "route_browse", "req_rate", 50, 10]]);
    const minute0 = [mkPoint("edge-gateway", "route_browse", T0, { count: 250 })]; // 5x the 50 baseline

    const anomalies = evaluate([minute0], baselines);

    expect(anomalies).toEqual<Anomaly[]>([
      {
        fingerprint: "edge-gateway:traffic",
        service: "edge-gateway",
        metricClass: "traffic",
        rule: "hard",
        value: 250,
        baseline: 50,
        statement: "edge-gateway req_rate 250 req/min vs baseline 50 req/min (hard trip) since 14:00Z",
      },
    ]);
  });

  it("hard needs >= 20 requests and sustained >= 10 per minute — a '4x spike' on tiny volume stays silent", () => {
    const baselines = mkBaselines([["cron-svc", "tick", "req_rate", 2, 1]]);
    // 8 req/min is 4x the baseline of 2, but under both count floors.
    const m0 = [mkPoint("cron-svc", "tick", T0, { count: 8 })];
    const m1 = [mkPoint("cron-svc", "tick", T0 - MIN, { count: 8 })];
    expect(evaluate([m0, m1], baselines)).toEqual([]);

    // 12 req/min in both minutes: above the sustained floor (10) and > 3x baseline -> sustained
    // fires; still below the hard floor (20), so the rule is sustained, not hard.
    const s0 = [mkPoint("cron-svc", "tick", T0, { count: 12 })];
    const s1 = [mkPoint("cron-svc", "tick", T0 - MIN, { count: 12 })];
    const anomalies = evaluate([s0, s1], baselines);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ fingerprint: "cron-svc:traffic", rule: "sustained" });
  });
});

describe("evaluate: fingerprint consolidation", () => {
  it("a hard-trip and sustained hit on the same fingerprint dedupe to one anomaly with rule 'hard'", () => {
    const baselines = mkBaselines([["payments-api", "charge", "error_rate", 0.01, 0.005]]);
    // 30% clears both the hard floor (25%) and the sustained floor (5%), in both minutes, with 30
    // errors/minute clearing every evidence gate -- this single (service, operation, metric)
    // satisfies both rules simultaneously.
    const minute0 = [mkPoint("payments-api", "charge", T0, { count: 100, error_rate: 0.3 })];
    const minute1 = [mkPoint("payments-api", "charge", T0 - MIN, { count: 100, error_rate: 0.3 })];

    const anomalies = evaluate([minute0, minute1], baselines);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ fingerprint: "payments-api:errors", rule: "hard" });
  });

  it("multiple operations of one service breaching the same class consolidate to one anomaly, picking the worst", () => {
    const baselines = mkBaselines([
      ["edge-gateway", "op-a", "error_rate", 0.01, 0.005],
      ["edge-gateway", "op-b", "error_rate", 0.01, 0.005],
    ]);
    // op-a: 26% (ratio ~26x its 1% baseline). op-b: 60% (ratio ~60x) -- op-b is the worse breach.
    const minute0 = [
      mkPoint("edge-gateway", "op-a", T0, { count: 100, error_rate: 0.26 }),
      mkPoint("edge-gateway", "op-b", T0, { count: 100, error_rate: 0.6 }),
    ];

    const anomalies = evaluate([minute0], baselines);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      fingerprint: "edge-gateway:errors",
      rule: "hard",
      value: 0.6,
      baseline: 0.01,
    });
  });
});

// --- FP side: the multi-day false-positive bound ------------------------------------------------

describe("evaluate: steady-state false-positive bound (multi-day)", () => {
  // Five independent seeded 24h windows of the real generator's output (identical machinery to
  // backfill/live ticks, SIM_RATE 1.0), each replayed through `evaluate` minute-by-minute against
  // baselines computed from that same day — the reviewer's FP methodology, committed. A single
  // anomaly on ANY day fails the demo's credibility gate.
  const DAY_MIN = 24 * 60;
  const DAY_STARTS = [
    Date.UTC(2026, 0, 5),
    Date.UTC(2026, 0, 6),
    Date.UTC(2026, 0, 7),
    Date.UTC(2026, 0, 8),
    Date.UTC(2026, 0, 9),
  ];

  it.each(DAY_STARTS.map((d) => [new Date(d).toISOString().slice(0, 10), d] as const))(
    "24h of realistic steady-state traffic on %s produces zero anomalies",
    (_label, dayStart) => {
      const rollups: RollupRow[] = [];
      for (let m = 0; m < DAY_MIN; m++) rollups.push(...healthyMinute(dayStart + m * MIN));
      const baselines = baselinesFrom(rollups);

      const byMinute = new Map<number, MetricPoint[]>();
      for (const p of toPoints(rollups)) {
        const arr = byMinute.get(p.minute_ts);
        if (arr) arr.push(p);
        else byMinute.set(p.minute_ts, [p]);
      }

      const all: Anomaly[] = [];
      for (let m = 0; m < DAY_MIN; m++) {
        const ts0 = dayStart + m * MIN;
        all.push(...evaluate([byMinute.get(ts0) ?? [], byMinute.get(ts0 - MIN) ?? []], baselines));
      }

      expect(all).toEqual([]);
    },
  );
});

// --- FN side: scenario detection across the diurnal curve ---------------------------------------

describe("evaluate: scenario detection latency (all 4 scenarios x 10 times of day)", () => {
  const DAY_MIN = 24 * 60;
  /** Trial day anchor; trials start every 2h24m across it, covering peak (14:24), trough (02:24)
   * and everything between. */
  const ANCHOR = Date.UTC(2026, 0, 20);
  const OFFSETS_MIN = Array.from({ length: 10 }, (_, i) => i * 144);
  /** Minutes of fault simulated per trial — comfortably past the loosest deadline (6 min). */
  const HORIZON_MIN = 9;

  /** Effect-onset delay per scenario: bad-deploy's fault effects begin 30s after the deploy event
   * (scenarios.ts BAD_DEPLOY_ONSET_MS, spec §6); the others take effect immediately. */
  const ONSET_DELAY_MS: Record<ScenarioId, number> = {
    "bad-deploy": 30_000,
    "dependency-outage": 0,
    "latency-creep": 0,
    "traffic-spike": 0,
  };

  /** Detection deadline in minutes from effect onset (spec §8: incident opened <= 2.5 min for
   * scenarios 1, 2, 4; latency-creep fires when the ramp crosses thresholds, ~4-6 min). */
  const DEADLINE_MIN: Record<ScenarioId, number> = {
    "bad-deploy": 2.5,
    "dependency-outage": 2.5,
    "latency-creep": 6,
    "traffic-spike": 2.5,
  };

  /** What "detected" means per scenario — the anomaly must plausibly attribute the fault, not
   * just be any anomaly that happens to fire during the window. */
  const EXPECTED: Record<ScenarioId, (a: Anomaly) => boolean> = {
    "bad-deploy": (a) => ["payments-api", "checkout-edge", "edge-gateway"].includes(a.service) && a.metricClass !== "traffic",
    "dependency-outage": (a) => a.service === "notify",
    "latency-creep": (a) => a.metricClass === "latency",
    "traffic-spike": (a) => a.metricClass === "traffic",
  };

  // Healthy-minute cache spanning every trial's trailing-24h baseline window plus the minute
  // before each fault start (the sustained rule's minute[1] on the first fault minute). Built
  // lazily and shared across trials — every trial lives in the same deterministic healthy world.
  const healthyCache = new Map<number, RollupRow[]>();
  function cachedHealthy(minuteStart: number): RollupRow[] {
    let rows = healthyCache.get(minuteStart);
    if (!rows) {
      rows = healthyMinute(minuteStart);
      healthyCache.set(minuteStart, rows);
    }
    return rows;
  }

  /** Baselines from the trailing 24h of healthy minutes before `startMs` — what the 15-min
   * recompute would have last written before the fault hit. */
  function trailingBaselines(startMs: number): BaselineMap {
    const rollups: RollupRow[] = [];
    for (let m = DAY_MIN; m >= 1; m--) rollups.push(...cachedHealthy(startMs - m * MIN));
    return baselinesFrom(rollups);
  }

  interface Trial {
    scenario: ScenarioId;
    hhmm: string;
    detectedAtMin: number | null;
    via: string | null;
  }

  function runTrial(scenario: ScenarioId, startMs: number): Trial {
    const fault: FaultState = { scenario, startedMs: startMs };
    const baselines = trailingBaselines(startMs);
    const hhmm = new Date(startMs).toISOString().slice(11, 16);

    const faultMinutes: RollupRow[][] = [];
    for (let m = 0; m < HORIZON_MIN; m++) faultMinutes.push(faultMinute(startMs + m * MIN, fault));

    for (let m = 0; m < HORIZON_MIN; m++) {
      const minute0 = toPoints(faultMinutes[m] as RollupRow[]);
      const minute1 = toPoints(m === 0 ? cachedHealthy(startMs - MIN) : (faultMinutes[m - 1] as RollupRow[]));
      const anomalies = evaluate([minute0, minute1], baselines);
      const hit = anomalies.find(EXPECTED[scenario]);
      if (hit) {
        const evalAtMs = startMs + (m + 1) * MIN; // the sweep sees minute m once it completes
        const detectedAtMin = (evalAtMs - (startMs + ONSET_DELAY_MS[scenario])) / MIN;
        return { scenario, hhmm, detectedAtMin, via: `${hit.fingerprint}/${hit.rule}` };
      }
    }
    return { scenario, hhmm, detectedAtMin: null, via: null };
  }

  const SCENARIOS: ScenarioId[] = ["bad-deploy", "dependency-outage", "latency-creep", "traffic-spike"];

  it.each(SCENARIOS.map((s) => [s] as const))(
    "%s is detected within its deadline at all 10 times of day",
    (scenario) => {
      const trials = OFFSETS_MIN.map((off) => runTrial(scenario, ANCHOR + off * MIN));

      // One consolidated assertion so a failure names every missed/late trial at once.
      const violations = trials
        .filter((t) => t.detectedAtMin === null || t.detectedAtMin > DEADLINE_MIN[scenario])
        .map((t) => `${t.hhmm}: ${t.detectedAtMin === null ? "MISS" : `${t.detectedAtMin}min`} (via ${t.via ?? "-"})`);
      expect(violations).toEqual([]);

      // And every trial genuinely detected (not vacuously passing on an empty trial list).
      expect(trials).toHaveLength(10);
      expect(trials.every((t) => t.detectedAtMin !== null)).toBe(true);
    },
  );
});
