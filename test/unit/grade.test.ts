import { describe, expect, it } from "vitest";
import { gradeReport, type GradableReport } from "../../scripts/grade";

/**
 * Regression fixtures for the eval rubric (`scripts/grade.ts`). The two PASS fixtures are REAL
 * reports the deployed agent produced on 2026-07-15 (incidents inc-f596d500…, inc-8aaa20b4…) that
 * the pre-exoneration grader mis-scored as FAIL: each names a `mustNotBlame` term only to rule it
 * out (dependency-outage exonerates checkout; traffic-spike notes the red-herring deploy as
 * correlated timing, not cause). The FAIL fixtures guard the other direction: reports that
 * actually *attribute* the cause to the forbidden term must keep failing even though they may sit
 * near correlation-sounding words.
 */

/** Real production report — dependency-outage, graded FAIL ("blames: checkout") before exoneration. */
const DEPENDENCY_OUTAGE_REAL: GradableReport = {
  summary:
    "notifications.send_email started failing 100% of requests with p95 pinned at the 3000ms timeout " +
    "starting ~01:42Z, caused by the external email-provider dependency returning HTTP 503s. " +
    "Checkout/gateway remain healthy since the email send is a fire-and-forget branch off place_order.",
  root_cause: {
    hypothesis:
      "The external email-provider dependency suffered an outage (returning HTTP 503), not any change " +
      "in notifications/checkout/gateway code or config.",
    mechanism:
      "notifications.send_email calls out to email-provider synchronously; when the provider began " +
      "returning 503s, each call ran to the configured timeout (3000ms) before erroring with " +
      "error_type=downstream, driving send_email's error_rate to 100% and p95 to the timeout ceiling. " +
      "Because checkout.place_order treats the notification send as a non-blocking/best-effort branch, " +
      "place_order and the gateway root span remained status=ok even while the nested send_email span " +
      "failed — so the failure is fully contained to notifications and does not cascade upstream, " +
      "unlike the earlier payments pool-exhaustion incident in this same window.",
  },
};

/** Real production report — traffic-spike, graded FAIL ("blames: deploy") before the
 * correlation-marker extension: the deploy is mentioned as coincident timing, never as cause. */
const TRAFFIC_SPIKE_REAL: GradableReport = {
  summary:
    "A broad, sustained ~3-5x surge in inbound request volume hit the gateway/catalog front door " +
    "starting ~02:14-02:16Z and propagated proportionally down the full call chain (checkout, payments, " +
    "payments-db, notifications), each hitting hard-trip traffic thresholds by 02:17Z. The system mostly " +
    "absorbed the extra load — error rates and p50/p95 latency stayed close to baseline for most " +
    "operations — but a handful of resource-constrained paths (catalog's search index shards, checkout's " +
    "session/cart lookup) began intermittently failing under the higher concurrency.",
  root_cause: {
    hypothesis:
      "A sustained increase in inbound request volume (consistent with the aptly-named 'traffic-spike' " +
      "catalog deploy at 02:16:33Z) drove ~3-5x normal load through the entire " +
      "gateway->catalog/checkout->payments->payments-db->notifications path, and that added concurrency " +
      "pushed a couple of already-marginal internal dependencies (catalog's search index shards, " +
      "checkout's session-state store) past their capacity, producing scattered timeouts/errors on top " +
      "of an otherwise-healthy, just-busier system.",
    mechanism:
      "More requests arriving at gateway means proportionally more calls fan out to every downstream " +
      "service in the normal browse/checkout/payment/notify flow — this explains why catalog, gateway, " +
      "checkout, payments, payments-db, and notifications all crossed their req_rate baselines together " +
      "within a 1-2 minute window rather than one service degrading and cascading into others.",
  },
};

describe("gradeReport", () => {
  it("passes the real dependency-outage report (checkout named only to exonerate it)", () => {
    const graded = gradeReport("dependency-outage", DEPENDENCY_OUTAGE_REAL);
    expect(graded).toEqual({ pass: true, detail: "root cause correct" });
  });

  it("passes the real traffic-spike report (red-herring deploy cited as correlated timing, not cause)", () => {
    const graded = gradeReport("traffic-spike", TRAFFIC_SPIKE_REAL);
    expect(graded).toEqual({ pass: true, detail: "root cause correct" });
  });

  it("still fails a traffic-spike report that attributes the surge TO the deploy", () => {
    const graded = gradeReport("traffic-spike", {
      summary: "Load surge across all services after the catalog release.",
      root_cause: {
        hypothesis: "The catalog deploy at 02:16Z caused the surge in request volume.",
        mechanism: "The new catalog version fans out extra internal calls per request, multiplying load on every service.",
      },
    });
    expect(graded.pass).toBe(false);
    expect(graded.detail).toContain("blames: deploy");
  });

  it("still fails a dependency-outage report that blames checkout as the cause", () => {
    const graded = gradeReport("dependency-outage", {
      summary: "Email notifications failing at 100%.",
      root_cause: {
        hypothesis: "A checkout regression is flooding notifications with malformed email jobs.",
        mechanism: "checkout.place_order emits bad payloads and notifications.send_email rejects every one of them.",
      },
    });
    expect(graded.pass).toBe(false);
    expect(graded.detail).toContain("blames: checkout");
  });

  it("fails when a required keyword group is missing entirely", () => {
    const graded = gradeReport("bad-deploy", {
      summary: "Something went wrong in payments.",
      root_cause: { hypothesis: "payments is slow.", mechanism: "unknown." },
    });
    expect(graded.pass).toBe(false);
    expect(graded.detail).toContain("missing:");
  });

  it("mustNotBlame only inspects root_cause — a blame-y summary alone does not fail", () => {
    const graded = gradeReport("latency-creep", {
      summary: "Latency rose after a deploy-heavy afternoon across the fleet.",
      root_cause: {
        hypothesis: "payments-db storage latency is degrading gradually.",
        mechanism: "p95 write latency on payments-db has climbed steadily without any correlated event.",
      },
    });
    expect(graded).toEqual({ pass: true, detail: "root cause correct" });
  });
});
