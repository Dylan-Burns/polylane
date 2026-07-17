# Watchtower eval — 2026-07-17 (post CF-native rename, v2 world)

Target: https://watchtower.dylanburns.workers.dev  •  Result: **4/4 scenarios root-caused correctly** (gate: ≥ 3/4)

First eval against the Cloudflare-native topology (edge-gateway/checkout-edge/payments-api Workers,
ledger-db D1, catalog-kv, notify, email-api) after the world reset that rebuilt telemetry and
baselines under the new names.

| Scenario | Verdict | Fault→incident | Tool calls | Tokens in / out | Investigation wall | Confidence | Notes |
|---|---|---|---|---|---|---|---|
| bad-deploy | ✅ PASS | 126s | 6 | 30 / 5660 | 50s | high | root cause correct |
| dependency-outage | ✅ PASS | 55s | 6 | 30 / 5046 | 47s | high | root cause correct |
| latency-creep | ✅ PASS | 236s | 7 | 32 / 6618 | 56s | low | root cause correct |
| traffic-spike | ✅ PASS | 115s | 6 | 14 / 7552 | 62s | medium | root cause correct |

Confidence levels are evidence-shaped per the calibrated rubric: trace-confirmed + corroborated
mechanisms rate high; the slow-drift scenario (no single confirming artifact by construction)
honestly stays low/medium.

Run note: the harness process died mid-run on a local DNS failure (`getaddrinfo ENOTFOUND`,
operator-machine network blip — the deployment itself never erred). bad-deploy and
dependency-outage verdicts were recorded before the crash; latency-creep's investigation
completed server-side and was graded from its stored report, and traffic-spike was re-driven
end-to-end, both via the identical `gradeReport` rubric (`scripts/grade.ts`) against the same
deployment.

Grading: required-mention keyword groups over `report.summary + report.root_cause` (ANY within a group, ALL groups);
"must-not-blame" terms are checked against `root_cause` only, so a report may mention a red herring while ruling it out.
