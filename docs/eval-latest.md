# Watchtower eval — 2026-07-17T19:08:23.239Z

Target: https://watchtower.dylanburns.workers.dev  •  Result: **4/4 scenarios root-caused correctly** (gate: ≥ 3/4)

| Scenario | Verdict | Fault→incident | Tool calls | Tokens in / out | Investigation wall | Notes |
|---|---|---|---|---|---|---|
| bad-deploy | ✅ PASS | 176s | 6 | 30 / 5265 | 51s | root cause correct |
| dependency-outage | ✅ PASS | 115s | 6 | 30 / 4492 | 47s | root cause correct |
| latency-creep | ✅ PASS | 298s | 7 | 32 / 5398 | 50s | root cause correct |
| traffic-spike | ✅ PASS | 115s | 4 | 10 / 5301 | 53s | root cause correct |

Grading: required-mention keyword groups over `report.summary + report.root_cause` (ANY within a group, ALL groups);
"must-not-blame" terms are checked against `root_cause` only, so a report may mention a red herring while ruling it out.
