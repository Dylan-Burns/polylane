import { describe, expect, it } from "vitest";
import { generateWindow } from "../../src/sim/generator";
import { mulberry32 } from "../../src/sim/rng";
import { deployEventsFor, effectsFor, identityEffects, SCENARIOS, type FaultState, type ScenarioId } from "../../src/sim/scenarios";
import { EXTERNAL_SERVICE } from "../../src/sim/topology";

// 14:00 UTC == diurnalMult's peak hour (see generator.ts) -> predictable request volume.
const START = Date.UTC(2026, 0, 5, 14, 0, 0);
const MIN = 60_000;

describe("identityEffects", () => {
  it("is the no-op baseline: empty maps, trafficMult 1", () => {
    const effects = identityEffects();
    expect(effects.latencyMult.size).toBe(0);
    expect(effects.errorRateOverride.size).toBe(0);
    expect(effects.trafficMult).toBe(1);
  });
});

describe("effectsFor", () => {
  it("returns identity effects when fault is null, at any nowMs", () => {
    for (const nowMs of [0, START, START + 10 * MIN]) {
      const effects = effectsFor(null, nowMs);
      expect(effects.latencyMult.size).toBe(0);
      expect(effects.errorRateOverride.size).toBe(0);
      expect(effects.trafficMult).toBe(1);
    }
  });

  describe("bad-deploy", () => {
    const fault: FaultState = { scenario: "bad-deploy", startedMs: START };

    it("has no effect at t=0 (deploy just happened, onset is 30s later)", () => {
      const effects = effectsFor(fault, START);
      expect(effects).toEqual(identityEffects());
    });

    it("has no effect right up to the 30s onset boundary", () => {
      const effects = effectsFor(fault, START + 29_999);
      expect(effects).toEqual(identityEffects());
    });

    it("applies payments latency x6 + 25% pool-exhaustion errors at t=2min (after onset)", () => {
      const effects = effectsFor(fault, START + 2 * MIN);
      expect(effects.latencyMult.get("payments")).toBe(6);
      expect(effects.errorRateOverride.get("payments")).toEqual({
        rate: 0.25,
        errorType: "pool_exhausted",
        logMessage: "connection pool exhausted: 25/25 in use, acquire timeout 5000ms",
      });
      expect(effects.trafficMult).toBe(1);

      // The checkout-timeout / gateway-5xx cascade must come free from generator propagation —
      // no explicit overrides on payments-db, checkout, or gateway.
      expect(effects.latencyMult.has("payments-db")).toBe(false);
      expect(effects.latencyMult.has("checkout")).toBe(false);
      expect(effects.latencyMult.has("gateway")).toBe(false);
      expect(effects.errorRateOverride.has("payments-db")).toBe(false);
      expect(effects.errorRateOverride.has("checkout")).toBe(false);
      expect(effects.errorRateOverride.has("gateway")).toBe(false);
    });

    it("still applies at t=10min (no self-healing)", () => {
      const effects = effectsFor(fault, START + 10 * MIN);
      expect(effects.latencyMult.get("payments")).toBe(6);
      expect(effects.errorRateOverride.get("payments")?.rate).toBe(0.25);
    });

    it("never names the scenario/deploy/fault in the error logMessage (honesty calibration)", () => {
      const effects = effectsFor(fault, START + 2 * MIN);
      const message = effects.errorRateOverride.get("payments")?.logMessage ?? "";
      for (const pattern of [/deploy/i, /v2\.4\.1/i, /scenario/i, /\bfault\b/i, /chaos/i, /bad-deploy/i, /root cause/i]) {
        expect(message).not.toMatch(pattern);
      }
    });
  });

  describe("dependency-outage", () => {
    const fault: FaultState = { scenario: "dependency-outage", startedMs: START };

    it("sets email-provider errors to 100% immediately at t=0, latency/traffic untouched", () => {
      const effects = effectsFor(fault, START);
      expect(effects.errorRateOverride.get(EXTERNAL_SERVICE)?.rate).toBe(1);
      expect(effects.latencyMult.size).toBe(0);
      expect(effects.trafficMult).toBe(1);
    });

    it("holds 100% at t=2min and t=10min, touching no other service", () => {
      for (const offset of [2 * MIN, 10 * MIN]) {
        const effects = effectsFor(fault, START + offset);
        expect(effects.errorRateOverride.size).toBe(1);
        expect(effects.errorRateOverride.get(EXTERNAL_SERVICE)?.rate).toBe(1);
        expect(effects.latencyMult.size).toBe(0);
        expect(effects.trafficMult).toBe(1);
      }
    });
  });

  describe("latency-creep", () => {
    const fault: FaultState = { scenario: "latency-creep", startedMs: START };

    it("is x1 at t=0 and never overrides error rates (log-silent by design)", () => {
      const effects = effectsFor(fault, START);
      expect(effects.latencyMult.get("payments-db")).toBe(1);
      expect(effects.errorRateOverride.size).toBe(0);
      expect(effects.trafficMult).toBe(1);
    });

    it("ramps to exactly x2.5 at t=2min (halfway through the 4-minute ramp)", () => {
      const effects = effectsFor(fault, START + 2 * MIN);
      expect(effects.latencyMult.get("payments-db")).toBe(2.5);
      expect(effects.errorRateOverride.size).toBe(0);
    });

    it("reaches x4 at t=4min and holds x4 at t=10min", () => {
      const at4 = effectsFor(fault, START + 4 * MIN);
      expect(at4.latencyMult.get("payments-db")).toBe(4);
      const at10 = effectsFor(fault, START + 10 * MIN);
      expect(at10.latencyMult.get("payments-db")).toBe(4);
      expect(at10.errorRateOverride.size).toBe(0);
    });
  });

  describe("traffic-spike", () => {
    const fault: FaultState = { scenario: "traffic-spike", startedMs: START };

    it("sets trafficMult to 5 with no latency/error changes, holding across time", () => {
      for (const offset of [0, 2 * MIN, 10 * MIN]) {
        const effects = effectsFor(fault, START + offset);
        expect(effects.trafficMult).toBe(5);
        expect(effects.latencyMult.size).toBe(0);
        expect(effects.errorRateOverride.size).toBe(0);
      }
    });
  });
});

describe("deployEventsFor", () => {
  it("returns no deploys when fault is null", () => {
    expect(deployEventsFor(null)).toEqual([]);
  });

  it("bad-deploy emits both the real payments deploy and the red-herring catalog deploy", () => {
    const fault: FaultState = { scenario: "bad-deploy", startedMs: START };
    const deploys = deployEventsFor(fault);
    expect(deploys).toHaveLength(2);

    const payments = deploys.find((d) => d.service === "payments");
    expect(payments).toBeDefined();
    expect(payments?.version).toBe("v2.4.1");
    expect(payments?.ts_ms).toBe(START);

    const catalog = deploys.find((d) => d.service === "catalog");
    expect(catalog).toBeDefined();
    expect(catalog?.version).toBe("v1.8.3");
    expect(catalog?.ts_ms).toBe(START + 90_000);

    expect(payments?.id).not.toBe(catalog?.id);
    expect(payments?.id.length).toBeGreaterThan(0);
    expect(catalog?.id.length).toBeGreaterThan(0);
  });

  it("every non-bad-deploy scenario emits only the benign red-herring catalog deploy", () => {
    const others: ScenarioId[] = ["dependency-outage", "latency-creep", "traffic-spike"];
    for (const scenario of others) {
      const fault: FaultState = { scenario, startedMs: START };
      const deploys = deployEventsFor(fault);
      expect(deploys).toHaveLength(1);
      expect(deploys[0]?.service).toBe("catalog");
      expect(deploys[0]?.version).toBe("v1.8.3");
      expect(deploys[0]?.ts_ms).toBe(START + 90_000);
    }
  });

  it("produces stable ids for the same scenario regardless of startedMs (idempotent dedupe key)", () => {
    const first = deployEventsFor({ scenario: "bad-deploy", startedMs: START });
    const second = deployEventsFor({ scenario: "bad-deploy", startedMs: START + 5 * MIN });
    expect(second.map((d) => d.id).sort()).toEqual(first.map((d) => d.id).sort());
  });

  it("gives different scenarios distinct catalog-deploy ids (no cross-scenario collision)", () => {
    const badDeploy = deployEventsFor({ scenario: "bad-deploy", startedMs: START });
    const trafficSpike = deployEventsFor({ scenario: "traffic-spike", startedMs: START });
    const badDeployCatalogId = badDeploy.find((d) => d.service === "catalog")?.id;
    const trafficSpikeCatalogId = trafficSpike.find((d) => d.service === "catalog")?.id;
    expect(badDeployCatalogId).toBeDefined();
    expect(trafficSpikeCatalogId).toBeDefined();
    expect(badDeployCatalogId).not.toBe(trafficSpikeCatalogId);
  });

  it("never names the scenario/fault/chaos in a deploy note (honesty calibration)", () => {
    const fault: FaultState = { scenario: "bad-deploy", startedMs: START };
    for (const deploy of deployEventsFor(fault)) {
      for (const pattern of [/scenario/i, /\bfault\b/i, /chaos/i, /inject/i, /bad-deploy/i, /regress/i]) {
        expect(deploy.note).not.toMatch(pattern);
      }
    }
  });
});

describe("bad-deploy cascade via the real generator (no explicit upstream overrides)", () => {
  it("propagates payments' pool-exhaustion errors up to checkout and gateway for free", () => {
    const fault: FaultState = { scenario: "bad-deploy", startedMs: START };
    // Well past the 30s onset so effects are active for the whole window.
    const from = START + 2 * MIN;
    const to = from + 5 * MIN;
    const effects = effectsFor(fault, from);
    const batch = generateWindow(from, to, effects, mulberry32(17), 1);

    const paymentsErrors = batch.spans.filter(
      (s) => s.service === "payments" && s.status === "error" && s.error_type === "pool_exhausted",
    );
    expect(paymentsErrors.length).toBeGreaterThan(0);

    const paymentsErrorLogs = batch.logs.filter(
      (l) => l.service === "payments" && l.message === "connection pool exhausted: 25/25 in use, acquire timeout 5000ms",
    );
    expect(paymentsErrorLogs.length).toBeGreaterThan(0);

    // scenarios.ts never sets an override on checkout/gateway/payments-db — this propagation is
    // purely generator.ts's own downstream-error walk.
    let sawDownstreamCheckout = false;
    let sawDownstreamGateway = false;
    for (const span of paymentsErrors) {
      const traceSpans = batch.spans.filter((s) => s.trace_id === span.trace_id);
      const checkoutErr = traceSpans.find((s) => s.service === "checkout" && s.status === "error");
      const gatewayErr = traceSpans.find((s) => s.service === "gateway" && s.status === "error");
      if (checkoutErr) {
        expect(checkoutErr.error_type).toBe("downstream");
        sawDownstreamCheckout = true;
      }
      if (gatewayErr) {
        expect(gatewayErr.error_type).toBe("downstream");
        sawDownstreamGateway = true;
      }
    }
    expect(sawDownstreamCheckout).toBe(true);
    expect(sawDownstreamGateway).toBe(true);
  });
});

describe("SCENARIOS", () => {
  it("has a label/description/expectedDetection entry for all four scenario ids", () => {
    const ids: ScenarioId[] = ["bad-deploy", "dependency-outage", "latency-creep", "traffic-spike"];
    expect(Object.keys(SCENARIOS).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const entry = SCENARIOS[id];
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.expectedDetection.length).toBeGreaterThan(0);
    }
  });
});
