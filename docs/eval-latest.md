# Watchtower eval — 2026-07-16T07:01:50.074Z

Target: https://watchtower.dylanburns.workers.dev  •  Result: **4/4 scenarios root-caused correctly** (gate: ≥ 3/4)

| Scenario | Verdict | Fault→incident | Tool calls | Tokens in / out | Investigation wall | Notes |
|---|---|---|---|---|---|---|
| bad-deploy | ✅ PASS | 118s | 7 | 16 / 5491 | 47s | root cause correct |
| dependency-outage | ✅ PASS | 117s | 4 | 10 / 3576 | 37s | root cause correct |
| latency-creep | ✅ PASS | 296s | 8 | 34 / 5296 | 148s | root cause correct |
| traffic-spike | ✅ PASS | 115s | 5 | 12 / 4963 | 61s | root cause correct |

Grading: required-mention keyword groups over `report.summary + report.root_cause` (ANY within a group, ALL groups);
"must-not-blame" terms are checked against `root_cause` only, so a report may mention a red herring while ruling it out.
