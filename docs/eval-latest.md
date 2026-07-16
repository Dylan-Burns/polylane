# Watchtower eval — 2026-07-16T16:18:13.439Z

Target: https://watchtower.dylanburns.workers.dev  •  Result: **4/4 scenarios root-caused correctly** (gate: ≥ 3/4)

| Scenario | Verdict | Fault→incident | Tool calls | Tokens in / out | Investigation wall | Notes |
|---|---|---|---|---|---|---|
| bad-deploy | ✅ PASS | 165s | 7 | 16 / 6370 | 58s | root cause correct |
| dependency-outage | ✅ PASS | 117s | 5 | 12 / 3754 | 45s | root cause correct |
| latency-creep | ✅ PASS | 235s | 7 | 32 / 5588 | 64s | root cause correct |
| traffic-spike | ✅ PASS | 119s | 6 | 30 / 5613 | 78s | root cause correct |

Grading: required-mention keyword groups over `report.summary + report.root_cause` (ANY within a group, ALL groups);
"must-not-blame" terms are checked against `root_cause` only, so a report may mention a red herring while ruling it out.
