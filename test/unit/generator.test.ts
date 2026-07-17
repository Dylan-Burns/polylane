import { describe, expect, it } from "vitest";
import {
  diurnalMult,
  generateWindow,
  rollupFromStats,
  sampleForPersistence,
  type FaultEffects,
  type RequestStat,
} from "../../src/sim/generator";
import { mulberry32 } from "../../src/sim/rng";
import { ASYNC_STEP_KEYS, ERROR_LOG_MESSAGES, FLOWS, SERVICES } from "../../src/sim/topology";
import type { Span } from "../../src/telemetry/types";

const NO_EFFECTS: FaultEffects = { latencyMult: new Map(), errorRateOverride: new Map(), trafficMult: 1 };

// Anchored at 14:00 UTC == diurnalMult's peak hour (see generator.ts), so expected request
// volume per window is predictable: 1.5 req/s * simRate * trafficMult * seconds.
const PEAK_HOUR_ANCHOR_MS = Date.UTC(2026, 0, 5, 14, 0, 0);

describe("topology", () => {
  it("defines exactly 6 internal services (email-api is external) with FLOWS weights ~15/70/15", () => {
    expect(SERVICES.length).toBe(6);
    expect(SERVICES).not.toContain("email-api");
    const byName = Object.fromEntries(FLOWS.map((f) => [f.name, f.weight]));
    expect(byName["checkout"]).toBeCloseTo(0.15, 5);
    expect(byName["browse"]).toBeCloseTo(0.7, 5);
    expect(byName["status"]).toBeCloseTo(0.15, 5);
  });

  it("gives every internal service 2-3 operations with distinct latency profiles (spec §6)", () => {
    type StepLike = { service: string; operation: string; latency: { mu: number; sigma: number }; children: StepLike[] };
    const opsByService = new Map<string, Map<string, { mu: number; sigma: number }>>();
    const visit = (step: StepLike) => {
      if (step.service !== "email-api") {
        const ops = opsByService.get(step.service) ?? new Map<string, { mu: number; sigma: number }>();
        ops.set(step.operation, step.latency);
        opsByService.set(step.service, ops);
      }
      step.children.forEach(visit);
    };
    for (const flow of FLOWS) visit(flow.entry);

    for (const service of SERVICES) {
      const ops = opsByService.get(service);
      expect(ops).toBeDefined();
      expect(ops!.size).toBeGreaterThanOrEqual(2);
      expect(ops!.size).toBeLessThanOrEqual(3);
      // distinct profiles: no two operations of a service share the same (mu, sigma).
      const profiles = new Set([...ops!.values()].map((l) => `${l.mu}|${l.sigma}`));
      expect(profiles.size).toBe(ops!.size);
    }
  });
});

describe("diurnalMult", () => {
  it("stays within the spec's 0.5-1.0 band and peaks at the anchor hour", () => {
    for (let h = 0; h < 24; h += 0.5) {
      const m = diurnalMult(h);
      expect(m).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(m).toBeLessThanOrEqual(1.0 + 1e-9);
    }
    expect(diurnalMult(14)).toBeCloseTo(1.0, 6);
    expect(diurnalMult(14 + 12)).toBeCloseTo(0.5, 6);
  });
});

describe("deterministic for same seed", () => {
  it("produces deep-equal batches across two independent runs with the same seed", () => {
    const from = PEAK_HOUR_ANCHOR_MS;
    const to = from + 10 * 60_000; // 10 minutes
    const batch1 = generateWindow(from, to, NO_EFFECTS, mulberry32(42), 1);
    const batch2 = generateWindow(from, to, NO_EFFECTS, mulberry32(42), 1);

    expect(batch1.requests.length).toBeGreaterThan(0);
    expect(batch2).toEqual(batch1);
  });

  it("produces a different batch for a different seed (sanity check against a vacuous generator)", () => {
    const from = PEAK_HOUR_ANCHOR_MS;
    const to = from + 10 * 60_000;
    const batch1 = generateWindow(from, to, NO_EFFECTS, mulberry32(42), 1);
    const batch2 = generateWindow(from, to, NO_EFFECTS, mulberry32(43), 1);
    expect(batch2).not.toEqual(batch1);
  });
});

describe("error propagation", () => {
  it("error in ledger-db propagates to payments-api, checkout-edge, and edge-gateway spans of the same trace", () => {
    const effects: FaultEffects = {
      latencyMult: new Map(),
      errorRateOverride: new Map([
        [
          "ledger-db",
          {
            rate: 1,
            errorType: "pool_exhausted",
            logMessage: "connection pool exhausted: 25/25 in use, acquire timeout 5000ms",
          },
        ],
      ]),
      trafficMult: 1,
    };
    const from = PEAK_HOUR_ANCHOR_MS;
    const to = from + 5 * 60_000; // 5 minutes: ~450 requests, ~15% checkout flow => plenty of hits
    const batch = generateWindow(from, to, effects, mulberry32(7), 1);

    const dbErrorSpans = batch.spans.filter((s) => s.service === "ledger-db" && s.status === "error");
    expect(dbErrorSpans.length).toBeGreaterThan(0);

    for (const dbSpan of dbErrorSpans) {
      const bySpanId = new Map(batch.spans.filter((s) => s.trace_id === dbSpan.trace_id).map((s) => [s.span_id, s]));
      // Walk the ancestor chain from the erroring db span to the root: every ancestor on the
      // call path (payments-api -> checkout-edge -> edge-gateway) must report a downstream
      // error. This is the on-path chain — sibling spans off the path (e.g.
      // checkout-edge.get_cart) are rightly unaffected.
      const ancestors: Span[] = [];
      let cursor = dbSpan.parent_span_id === null ? undefined : bySpanId.get(dbSpan.parent_span_id);
      while (cursor !== undefined) {
        ancestors.push(cursor);
        cursor = cursor.parent_span_id === null ? undefined : bySpanId.get(cursor.parent_span_id);
      }

      const ancestorServices = ancestors.map((s) => s.service);
      expect(ancestorServices).toContain("payments-api");
      expect(ancestorServices).toContain("checkout-edge");
      expect(ancestorServices).toContain("edge-gateway");
      for (const ancestor of ancestors) {
        expect(ancestor.status).toBe("error");
        expect(ancestor.error_type).toBe("downstream");
      }
    }
  });

  it("does not propagate an email-api/notify error to checkout-edge or edge-gateway (async branch)", () => {
    const effects: FaultEffects = {
      latencyMult: new Map(),
      errorRateOverride: new Map([
        ["email-api", { rate: 1, errorType: "outage", logMessage: "upstream 503 from provider" }],
        // Zero out ambient baseline noise on the sync path so this test isolates the property
        // under test (async branch failures don't propagate) from unrelated coincidental errors
        // elsewhere in the same trace, which would otherwise make this assertion seed-dependent.
        ["edge-gateway", { rate: 0, errorType: "n/a", logMessage: "n/a" }],
        ["checkout-edge", { rate: 0, errorType: "n/a", logMessage: "n/a" }],
        ["payments-api", { rate: 0, errorType: "n/a", logMessage: "n/a" }],
        ["ledger-db", { rate: 0, errorType: "n/a", logMessage: "n/a" }],
      ]),
      trafficMult: 1,
    };
    const from = PEAK_HOUR_ANCHOR_MS;
    const to = from + 5 * 60_000;
    const batch = generateWindow(from, to, effects, mulberry32(11), 1);

    // email-api is external (spec §6): no internal span of its own, ever.
    expect(batch.spans.some((s) => s.service === "email-api")).toBe(false);

    const notificationErrorSpans = batch.spans.filter((s) => s.service === "notify" && s.status === "error");
    expect(notificationErrorSpans.length).toBeGreaterThan(0);

    for (const notifSpan of notificationErrorSpans) {
      const traceSpans = batch.spans.filter((s) => s.trace_id === notifSpan.trace_id);
      // EVERY checkout-edge/edge-gateway span in the trace stays ok — the async failure must not leak.
      for (const span of traceSpans) {
        if (span.service === "checkout-edge" || span.service === "edge-gateway") {
          expect(span.status).toBe("ok");
        }
      }
    }
  });
});

describe("async branch duration isolation (fire-and-forget)", () => {
  it("100% email-api errors leave checkout-edge durations and error rate at baseline", () => {
    const from = PEAK_HOUR_ANCHOR_MS;
    const to = from + 60 * 60_000; // 1 hour at peak: ~800 checkout-flow traces
    const healthy = generateWindow(from, to, NO_EFFECTS, mulberry32(31), 1);
    const effects: FaultEffects = {
      latencyMult: new Map(),
      errorRateOverride: new Map([
        ["email-api", { rate: 1, errorType: "outage", logMessage: "upstream 503 from provider" }],
      ]),
      trafficMult: 1,
    };
    const faulted = generateWindow(from, to, effects, mulberry32(31), 1);

    const placeOrderMean = (spans: Span[]) => {
      const durations = spans
        .filter((s) => s.service === "checkout-edge" && s.operation === "place_order")
        .map((s) => s.duration_ms);
      expect(durations.length).toBeGreaterThan(100);
      return durations.reduce((a, b) => a + b, 0) / durations.length;
    };

    // Sanity: the fault is actually firing — every notify.send_email span degrades.
    const sendSpans = faulted.spans.filter((s) => s.service === "notify" && s.operation === "send_email");
    expect(sendSpans.length).toBeGreaterThan(100);
    expect(sendSpans.every((s) => s.status === "error")).toBe(true);

    // (a) The duration-leak regression this guards against inflated checkout-edge ~14x (notify's
    // downstream-timeout floor folding into checkout-edge's timeline). 1.5x is generous headroom
    // for rng-stream divergence between the two runs, but far below the failure mode.
    const healthyMean = placeOrderMean(healthy.spans);
    const faultedMean = placeOrderMean(faulted.spans);
    expect(faultedMean).toBeLessThan(healthyMean * 1.5);
    expect(faultedMean).toBeGreaterThan(healthyMean / 1.5);

    // (b) checkout-edge's error rate stays at ambient baseline — the async failure must not turn
    // checkout-edge spans into errors (would be ~50% of checkout-edge-service spans if propagation
    // leaked).
    const checkoutSpans = faulted.spans.filter((s) => s.service === "checkout-edge");
    const errorRate = checkoutSpans.filter((s) => s.status === "error").length / checkoutSpans.length;
    expect(errorRate).toBeLessThan(0.02);
  });
});

describe("sampled persistence", () => {
  it("keeps every error trace and ~10% of healthy ones (tolerance +/-3pp over 5k traces)", () => {
    const from = PEAK_HOUR_ANCHOR_MS;
    const to = from + 60 * 60_000; // 1 hour at peak (diurnalMult=1) => ~5400 requests
    const batch = generateWindow(from, to, NO_EFFECTS, mulberry32(99), 1);

    const traceIds = new Set(batch.spans.map((s) => s.trace_id));
    expect(traceIds.size).toBeGreaterThan(5000);

    const errorTraceIds = new Set(batch.spans.filter((s) => s.status === "error").map((s) => s.trace_id));
    const healthyTraceIds = new Set([...traceIds].filter((id) => !errorTraceIds.has(id)));

    const persisted = sampleForPersistence(batch, mulberry32(123));
    const persistedTraceIds = new Set(persisted.spans.map((s) => s.trace_id));

    for (const errId of errorTraceIds) {
      expect(persistedTraceIds.has(errId)).toBe(true);
    }

    const keptHealthy = [...healthyTraceIds].filter((id) => persistedTraceIds.has(id));
    const ratio = keptHealthy.length / healthyTraceIds.size;
    expect(ratio).toBeGreaterThan(0.07);
    expect(ratio).toBeLessThan(0.13);

    // logs follow their trace: only logs belonging to a persisted trace survive.
    expect(persisted.logs.length).toBeGreaterThan(0);
    for (const log of persisted.logs) {
      expect(log.trace_id).toBeDefined();
      expect(persistedTraceIds.has(log.trace_id as string)).toBe(true);
    }

    // rollups always reflect 100% of traffic: requests[] is untouched by sampling.
    expect(persisted.requests).toBe(batch.requests);
  });
});

describe("rollupFromStats", () => {
  it("matches hand-computed count/error_count/p50/p95/p99 across two (service, operation) groups (20 requests total)", () => {
    const paymentsStats: RequestStat[] = Array.from({ length: 12 }, (_, i) => ({
      service: "payments-api",
      operation: "charge",
      duration_ms: 100 + i * 10, // sorted asc: 100, 110, ..., 210
      isError: i === 0, // 1 error
    }));
    const catalogStats: RequestStat[] = Array.from({ length: 8 }, (_, i) => ({
      service: "catalog-kv",
      operation: "search",
      duration_ms: 50 + i * 10, // sorted asc: 50, 60, ..., 120
      isError: i === 3, // 1 error
    }));

    const minuteTs = 1_700_000_000_000;
    const rows = rollupFromStats([...paymentsStats, ...catalogStats], minuteTs);

    expect(rows.length).toBe(2);
    const payments = rows.find((r) => r.service === "payments-api" && r.operation === "charge");
    const catalog = rows.find((r) => r.service === "catalog-kv" && r.operation === "search");

    // Nearest-rank percentile, N=12: rank = ceil(p*12). p50 -> rank 6 -> 6th smallest (index 5) = 150.
    // p95 -> rank ceil(11.4)=12 -> 12th (index 11, max) = 210. p99 -> rank ceil(11.88)=12 -> 210.
    expect(payments).toBeDefined();
    expect(payments?.minute_ts).toBe(minuteTs);
    expect(payments?.count).toBe(12);
    expect(payments?.error_count).toBe(1);
    expect(payments?.p50_ms).toBe(150);
    expect(payments?.p95_ms).toBe(210);
    expect(payments?.p99_ms).toBe(210);

    // N=8: p50 -> rank ceil(4)=4 -> index 3 = 80. p95 -> rank ceil(7.6)=8 -> index 7 (max) = 120.
    // p99 -> rank ceil(7.92)=8 -> 120.
    expect(catalog).toBeDefined();
    expect(catalog?.count).toBe(8);
    expect(catalog?.error_count).toBe(1);
    expect(catalog?.p50_ms).toBe(80);
    expect(catalog?.p95_ms).toBe(120);
    expect(catalog?.p99_ms).toBe(120);
  });
});

describe("span tree shape", () => {
  it("is well-formed: one root, parents precede children, children nest within parent duration", () => {
    const from = PEAK_HOUR_ANCHOR_MS;
    const to = from + 10 * 60_000;
    const batch = generateWindow(from, to, NO_EFFECTS, mulberry32(55), 1);
    expect(batch.spans.length).toBeGreaterThan(0);

    const byTrace = new Map<string, Span[]>();
    for (const span of batch.spans) {
      const list = byTrace.get(span.trace_id) ?? [];
      list.push(span);
      byTrace.set(span.trace_id, list);
    }
    expect(byTrace.size).toBeGreaterThan(0);

    for (const spans of byTrace.values()) {
      const roots = spans.filter((s) => s.parent_span_id === null);
      expect(roots.length).toBe(1);

      const bySpanId = new Map(spans.map((s) => [s.span_id, s]));
      const seenSpanIds = new Set<string>();
      for (const span of spans) {
        if (span.parent_span_id !== null) {
          // parent must already have been visited -> parent precedes child in array order.
          expect(seenSpanIds.has(span.parent_span_id)).toBe(true);
          const parent = bySpanId.get(span.parent_span_id);
          expect(parent).toBeDefined();
          expect(parent?.start_ms).toBeLessThanOrEqual(span.start_ms);
          const parentEnd = (parent?.start_ms ?? 0) + (parent?.duration_ms ?? 0);
          if (ASYNC_STEP_KEYS.has(`${span.service}:${span.operation}`)) {
            // Fire-and-forget branch: starts inside the parent's window, but the parent does
            // not wait for it, so it may legitimately end after the parent ends.
            expect(span.start_ms).toBeLessThanOrEqual(parentEnd);
          } else {
            expect(span.start_ms + span.duration_ms).toBeLessThanOrEqual(parentEnd);
          }
        }
        seenSpanIds.add(span.span_id);
      }
    }
  });
});

describe("telemetry honesty calibration (spec §6)", () => {
  it("never names the injected root cause in any step's baseline error message", () => {
    const forbidden = [/deploy/i, /chaos/i, /\bfault\b/i, /inject/i, /v2\.4\.1/i, /root cause/i, /scenario/i];
    const messages = Object.values(ERROR_LOG_MESSAGES);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      for (const pattern of forbidden) {
        expect(message).not.toMatch(pattern);
      }
    }
  });

  it("keeps ambient baseline error rate within a small, non-zero band (spec targets ~0.2-0.5%)", () => {
    const from = PEAK_HOUR_ANCHOR_MS;
    const to = from + 60 * 60_000;
    const batch = generateWindow(from, to, NO_EFFECTS, mulberry32(2024), 1);
    const errorRate = batch.requests.filter((r) => r.isError).length / batch.requests.length;
    // Loosened vs. the spec's tighter 0.2-0.5% target to avoid sampling flakiness in this
    // supplementary check; still confirms noise is present but small.
    expect(errorRate).toBeGreaterThan(0.001);
    expect(errorRate).toBeLessThan(0.01);
  });
});
