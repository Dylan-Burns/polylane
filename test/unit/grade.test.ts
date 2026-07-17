import { describe, expect, it } from "vitest";
import { gradeReport, type GradableReport } from "../../scripts/grade";

/**
 * Regression fixtures for the eval rubric (`scripts/grade.ts`). The two PASS fixtures are REAL
 * reports the deployed agent produced on 2026-07-15 (incidents inc-f596d500…, inc-8aaa20b4…) that
 * the pre-exoneration grader mis-scored as FAIL: each names a `mustNotBlame` term only to rule it
 * out (dependency-outage exonerates checkout-edge; traffic-spike notes the red-herring deploy as
 * correlated timing, not cause). The FAIL fixtures guard the other direction: reports that
 * actually *attribute* the cause to the forbidden term must keep failing even though they may sit
 * near correlation-sounding words.
 */

/** Real production report — dependency-outage, graded FAIL ("blames: checkout") before exoneration. */
const DEPENDENCY_OUTAGE_REAL: GradableReport = {
  summary:
    "notify.send_email started failing 100% of requests with p95 pinned at the 3000ms timeout " +
    "starting ~01:42Z, caused by the external email-api dependency returning HTTP 503s. " +
    "Checkout-edge/edge-gateway remain healthy since the email send is a fire-and-forget branch off place_order.",
  root_cause: {
    hypothesis:
      "The external email-api dependency suffered an outage (returning HTTP 503), not any change " +
      "in notify/checkout-edge/edge-gateway code or config.",
    mechanism:
      "notify.send_email calls out to email-api synchronously; when the provider began " +
      "returning 503s, each call ran to the configured timeout (3000ms) before erroring with " +
      "error_type=downstream, driving send_email's error_rate to 100% and p95 to the timeout ceiling. " +
      "Because checkout-edge.place_order treats the notification send as a non-blocking/best-effort branch, " +
      "place_order and the edge-gateway root span remained status=ok even while the nested send_email span " +
      "failed — so the failure is fully contained to notify and does not cascade upstream, " +
      "unlike the earlier payments-api D1 queued-query saturation incident in this same window.",
  },
};

/** Real production report — traffic-spike, graded FAIL ("blames: deploy") before the
 * correlation-marker extension: the deploy is mentioned as coincident timing, never as cause. */
const TRAFFIC_SPIKE_REAL: GradableReport = {
  summary:
    "A broad, sustained ~3-5x surge in inbound request volume hit the edge-gateway/catalog-kv front door " +
    "starting ~02:14-02:16Z and propagated proportionally down the full call chain (checkout-edge, payments-api, " +
    "ledger-db, notify), each hitting hard-trip traffic thresholds by 02:17Z. The system mostly " +
    "absorbed the extra load — error rates and p50/p95 latency stayed close to baseline for most " +
    "operations — but a handful of resource-constrained paths (catalog-kv's list_products pagination, checkout-edge's " +
    "get_cart lookup) began intermittently failing under the higher concurrency.",
  root_cause: {
    hypothesis:
      "A sustained increase in inbound request volume (consistent with the aptly-named 'traffic-spike' " +
      "catalog-kv deploy at 02:16:33Z) drove ~3-5x normal load through the entire " +
      "edge-gateway->catalog-kv/checkout-edge->payments-api->ledger-db->notify path, and that added concurrency " +
      "pushed a couple of already-marginal internal dependencies (catalog-kv's list_products pagination, " +
      "checkout-edge's session-state store) past their capacity, producing scattered timeouts/errors on top " +
      "of an otherwise-healthy, just-busier system.",
    mechanism:
      "More requests arriving at edge-gateway means proportionally more calls fan out to every downstream " +
      "service in the normal browse/checkout/payment/notify flow — this explains why catalog-kv, edge-gateway, " +
      "checkout-edge, payments-api, ledger-db, and notify all crossed their req_rate baselines together " +
      "within a 1-2 minute window rather than one service degrading and cascading into others.",
  },
};

describe("gradeReport", () => {
  it("passes the real dependency-outage report (checkout-edge named only to exonerate it)", () => {
    const graded = gradeReport("dependency-outage", DEPENDENCY_OUTAGE_REAL);
    expect(graded).toEqual({ pass: true, detail: "root cause correct" });
  });

  it("passes the real traffic-spike report (red-herring deploy cited as correlated timing, not cause)", () => {
    const graded = gradeReport("traffic-spike", TRAFFIC_SPIKE_REAL);
    expect(graded).toEqual({ pass: true, detail: "root cause correct" });
  });

  it("still fails a traffic-spike report that attributes the surge TO the deploy", () => {
    const graded = gradeReport("traffic-spike", {
      summary: "Load surge across all services after the catalog-kv release.",
      root_cause: {
        hypothesis: "The catalog-kv deploy at 02:16Z caused the surge in request volume.",
        mechanism: "The new catalog-kv version fans out extra internal calls per request, multiplying load on every service.",
      },
    });
    expect(graded.pass).toBe(false);
    expect(graded.detail).toContain("blames: deploy");
  });

  it("still fails a dependency-outage report that blames checkout-edge as the cause", () => {
    const graded = gradeReport("dependency-outage", {
      summary: "Email sends failing at 100%.",
      root_cause: {
        hypothesis: "A checkout-edge regression is flooding notify with malformed email jobs.",
        mechanism: "checkout-edge.place_order emits bad payloads and notify.send_email rejects every one of them.",
      },
    });
    expect(graded.pass).toBe(false);
    expect(graded.detail).toContain("blames: checkout");
  });

  it("fails when a required keyword group is missing entirely", () => {
    const graded = gradeReport("bad-deploy", {
      summary: "Something went wrong in payments-api.",
      root_cause: { hypothesis: "payments-api is slow.", mechanism: "unknown." },
    });
    expect(graded.pass).toBe(false);
    expect(graded.detail).toContain("missing:");
  });

  it("mustNotBlame only inspects root_cause — a blame-y summary alone does not fail", () => {
    const graded = gradeReport("latency-creep", {
      summary: "Latency rose after a deploy-heavy afternoon across the fleet.",
      root_cause: {
        hypothesis: "ledger-db storage latency is degrading gradually.",
        mechanism: "p95 write latency on ledger-db has climbed steadily without any correlated event.",
      },
    });
    expect(graded).toEqual({ pass: true, detail: "root cause correct" });
  });
});
