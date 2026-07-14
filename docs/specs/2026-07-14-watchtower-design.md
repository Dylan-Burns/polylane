# Watchtower — Design Specification

**Date:** 2026-07-14
**Status:** Draft for review
**Context:** Take-home exercise for Polylane (see `INSTRUCTIONS.md`). Build and deploy a working AI agent on Cloudflare Workers that does something genuinely useful for understanding, monitoring, or investigating software infrastructure.

---

## 1. Summary

Watchtower is a **self-demoing production watchdog**. A single Cloudflare Worker deployment contains a complete miniature world:

- A simulated multi-service production system ("Acme Shop") emitting realistic, causally-correlated telemetry (traces, logs, metrics, deploy events).
- A **chaos panel** where a reviewer injects faults with one click.
- A **watchdog agent** that maintains a statistical memory of "normal," detects drift on its own, opens an investigation, works the problem with real tools (metrics → logs → traces → deploys), and publishes a structured incident report — with the investigation streaming live in the UI.
- A **chat mode** exposing the same agent core for ad-hoc questions.

The reviewer's instinct to "try to break it" *is* the demo: click "ship a bad deploy," watch the agent notice within a minute, investigate, and explain the causal chain.

## 2. Goals

1. Satisfy every hard requirement: runs on Cloudflare Workers; a real agent loop with tools across multiple steps; usable at a public URL with no login.
2. Score maximally on the stated rubric: works when poked; strong agent design (tool boundaries, loop control, context management, failure handling); visible judgment; clear code; platform features used only where they earn their place.
3. Address the explicit hint that "producing realistic telemetry to investigate is part of the exercise, and we will notice if it is done well."
4. Keep idle cost ≈ $0: detection is statistical; the LLM runs only when something is worth investigating or a user chats.

## 3. Non-goals (deliberate, documented in README)

- Real cloud/telemetry connectors (Sentry, OTel, AWS). The tool layer is designed as the seam where these would plug in; building one is "what we'd do next."
- Authentication, rate limiting as a feature, billing (excluded by the instructions). Cost guardrails exist only to protect the API key.
- Alert delivery (Slack/email/PagerDuty).
- Multi-tenancy; one shared world per deployment.
- Cloudflare Workflows. Considered for the investigation loop; rejected in favor of a Durable Object because the loop is short-lived (1–3 min), the DO gives us streaming state persistence for free, and hand-rolled control flow is easier to defend line-by-line in the walkthrough.
- Pixel-perfect UI.

## 4. Constraints

- Cloudflare Workers, paid plan ($5/mo) available; design must degrade gracefully to free-tier limits where trivial.
- LLM: Anthropic API (`claude-sonnet-5`), key held as a Worker secret. Model ID configurable via env var.
- Roughly one day of focused work; phases ordered so the project is submittable early and each later phase only raises quality.
- Follow-up interview is a live code walkthrough: every dependency and abstraction must be defensible. Prefer hand-rolled-but-simple over framework magic.

## 5. Architecture

One Worker, one `wrangler deploy`, TypeScript everywhere.

```
┌─────────────────────────── Cloudflare Worker ────────────────────────────┐
│  Static assets (React UI, built by Vite)                                 │
│  API router (Hono)                                                       │
│                                                                          │
│  SimulatorDO ──(alarm ~20s)──► telemetry batches ──► D1 (telemetry)      │
│      ▲ fault state                                     ▲                 │
│      │                                                 │ SQL             │
│  POST /api/chaos/*                                Query layer            │
│                                                        ▲                 │
│  Cron (1 min) ──► Detector ──anomaly──► InvestigatorDO (agent loop)      │
│                   (statistical,           │  Anthropic Messages API      │
│                    zero LLM cost)         └─► steps + report → D1        │
│                                                                          │
│  POST /api/chat (SSE) ────────────────► same agent core, chat persona    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Runs as | Responsibility |
|---|---|---|
| Simulator | Durable Object (`SimulatorDO`), sub-minute alarm | Generates each window's telemetry from the service topology + current fault state; owns fault state; backfills history on reset |
| Telemetry store | D1 | Spans, logs, 1-minute rollups, deploy events, incidents, investigation steps; retention tiers |
| Query layer | Plain TS module over D1 | Typed query functions; the **only** way anything (tools, UI, detector) reads telemetry |
| Detector | Cron handler (1 min) | Baseline comparison, anomaly detection, dedupe, incident creation, auto-resolve |
| Investigator | Durable Object (`InvestigatorDO`) | The agent loop; persists every step; enforces budgets; produces the structured report |
| Chat | Worker request handler (SSE) | Same agent core + tools, conversational persona, client-held history |
| UI | Static assets (React + Vite + Tailwind) | Topology/health view, chaos panel, incident feed + live investigation timeline, chat |

### Why these platform features (and no others)

- **Durable Objects**: the simulator needs a single writer with owned state and a sub-minute timer (cron can't go below 1 min); the investigator needs serialized execution, persisted progress, and alarm-based resumption if evicted mid-investigation. Both are textbook DO fits.
- **Cron trigger**: the detector is a periodic, stateless sweep — exactly what cron is for.
- **D1**: the agent's tools are fundamentally SQL questions (aggregate this window, find exemplars, search logs). A relational store is the honest fit. KV/R2/Queues/Workflows add nothing here and are deliberately absent.
- **SSE streaming**: chat tokens stream; investigation timelines poll (2s) because step-granular updates don't benefit from a held connection. Streaming where it matters, polling where it doesn't.

## 6. The demo universe

### Topology (static, data-driven, one file)

```
gateway ──► checkout ──► payments ──► payments-db
   │            │
   │            └──► notifications ──► email-provider (external)
   └──► catalog
```

Six services. `email-provider` is modeled as an external dependency (no internal spans, only call results). Each service has 2–3 endpoints with distinct latency/error profiles (e.g., `payments.charge`, `payments-db.query`, `gateway GET /api/browse`).

### Generation model

- **Traffic**: base rate ~4 req/s at peak with a diurnal curve (0.4–1.0× multiplier by hour) plus small noise. Each simulator tick (~20s) generates that window's requests.
- **Traces**: each request produces a trace with correct parent/child spans along the dependency graph (trace_id, span_id, parent_span_id, service, operation, start, duration, status).
- **Latency**: per-(service, operation) log-normal distributions; child durations nest inside parents.
- **Errors**: per-operation base error rates (~0.1–0.5%); errors propagate up the call chain realistically (a payments-db failure surfaces as a payments 500 and a checkout timeout).
- **Logs**: request logs plus error logs with realistic, cause-specific messages ("connection pool exhausted: 25/25 in use, acquire timeout 5000ms"), linked to trace/span IDs.
- **Deploys**: occasional benign deploy events for background realism; fault scenarios emit their own.
- **Rollups**: the simulator maintains 1-minute rollups (service, operation, minute, count, error_count, p50, p95, p99) at write time — the same pre-aggregation pattern real observability stores use.

### Backfill & retention

- On deploy/reset: backfill **48h of rollups** (~50k rows) plus sampled exemplar traces/logs (every ~10 min) so the watchdog has a learned "normal" from minute one.
- Retention (enforced by the cron sweep): raw spans/logs **6h**; rollups **72h**; incidents/investigations kept indefinitely.
- Volume estimate at steady state: ~300–500 spans + ~100 logs per tick → ~1.5–2M raw rows/day written, ~450k live after retention; well inside D1 paid limits, and the write batches are chunked per tick.

### The honesty boundary

The world is simulated so reviewers get deterministic, causally-rich incidents — but **the agent never knows**. It consumes telemetry exclusively through the query-layer tools, which present the same shape a real backend (Sentry, OTel store) would. Swap the D1-backed query layer for a real connector and the agent is unchanged. Stated plainly in the README.

### Fault scenarios (each a chaos-panel button)

| # | Scenario | Mechanism | What it tests in the agent |
|---|---|---|---|
| 1 | **Bad deploy** | Deploy event `payments@v2.4.1`, then payments latency ×6 + pool-exhaustion errors → checkout timeouts → gateway 5xx | Change correlation: tie the regression to the deploy |
| 2 | **Dependency outage** | `email-provider` goes to 100% errors; notifications degrade; checkout unaffected | Blast-radius scoping: "low customer impact" is the right answer |
| 3 | **Latency creep** | `payments-db` p95 degrades gradually over ~20 min | Sensitivity vs noise; drift without a sharp edge |
| 4 | **Traffic spike** | 5× load on gateway; elevated latency everywhere; no defect | Root cause = load, not a bug |

Plus **Restore world** (clear all fault state; metrics recover; incidents auto-resolve) and **Reset world** (wipe + re-backfill; admin-ish, cooldown-protected). Scenarios may be stacked; faults compose and the agent handles compound incidents as best it can (honest rough edge, noted in README).

## 7. Data model (D1)

```sql
spans(trace_id, span_id, parent_span_id, service, operation, start_ms, duration_ms, status, error_type)
logs(ts_ms, service, level, message, trace_id?, span_id?)
rollups(service, operation, minute_ts, count, error_count, p50_ms, p95_ms, p99_ms)
deploys(id, service, version, ts_ms, note)
incidents(id, fingerprint, status: open|investigating|resolved|failed, severity,
          opened_at, resolved_at?, trigger_json, report_json?)
investigation_steps(incident_id, step_no, kind: thought|tool_call|tool_result|report|error,
                    content_json, ts_ms, tokens_in, tokens_out)
baselines(service, operation, metric, hour_bucket?, median, mad, computed_at)
meta(key, value)  -- world state: fault flags, sim cursor, counters
```

Indexes on `spans(service, start_ms)`, `spans(trace_id)`, `logs(service, ts_ms)`, `rollups(service, operation, minute_ts)`.

## 8. Detection: statistics decide *when* to think

- **Baselines**: per (service, operation, metric ∈ {req_rate, error_rate, p95}) — median + MAD over the trailing 48h of rollups, with an hour-of-day adjustment factor for req_rate (traffic is diurnal; latency and error rate are not). Recomputed every 15 min by the cron sweep.
- **Rules** (evaluated each minute over the last completed minutes):
  - `error_rate > max(5%, baseline + 6×MAD)` sustained 2 consecutive minutes → anomaly.
  - `p95 > 2.5 × baseline` sustained 3 consecutive minutes → anomaly.
  - `req_rate > 4 × hour-adjusted baseline` sustained 2 minutes → anomaly.
- **Fingerprint & dedupe**: anomaly fingerprint = `(service, metric_class)`. An open incident whose fingerprint set covers the anomaly suppresses re-firing. New fingerprints during an active investigation are appended to the incident's trigger context rather than opening a parallel incident (one world, one storyline at a time — compound faults become one richer investigation).
- **Auto-resolve**: all fingerprints of an open incident healthy for 5 consecutive minutes → status `resolved`, resolution note appended (no LLM).
- **Detection latency target**: fault injected → incident opened in **≤ 90s** for scenarios 1, 2, 4 (scenario 3 by design takes as long as the creep takes to cross thresholds).

The detector is pure TypeScript over rollups — deterministic, unit-testable, zero LLM cost at idle.

## 9. The investigator agent

### Loop mechanics

Hand-rolled loop over the Anthropic Messages API (official `@anthropic-ai/sdk`, which is fetch-based and Workers-compatible). No agent framework — every line defensible.

- Trigger: detector creates the incident and calls `InvestigatorDO` with a crisp anomaly statement ("checkout error_rate 22% vs baseline 0.4% since 14:32Z; concurrent: payments p95 8× baseline").
- System prompt contains: role, the service topology, the investigation protocol (verify → scope blast radius → drill down → check changes → conclude), tool usage guidance, current time, and the report rubric.
- Each iteration: model responds with tool calls → DO executes them via the query layer → results (size-capped) appended → repeat.
- **Termination**: the model must call `submit_report` (a tool with a strict JSON schema) to finish. Also terminates on: step cap (15), cumulative token budget, wall-clock cap (4 min), or repeated identical tool calls (loop guard).
- **Persistence**: every step (tool call, result summary, token counts) is written to `investigation_steps` *before* the next model call. The UI timeline reads this; an evicted DO resumes from the last persisted step via alarm.
- **Failure handling**: tool errors are returned to the model as error results (it adapts); malformed tool input gets a validation error back; Anthropic 429/5xx retried with backoff (3 attempts); if the loop dies anyway, the incident is marked `failed` with its partial timeline visible. Honest failure is a feature.

### Tools (the entire agent-world interface)

| Tool | Input (abridged) | Returns |
|---|---|---|
| `query_metrics` | service?, operation?, metrics[], window, step | Timeseries **with baseline overlay and delta** per point |
| `search_logs` | service?, level?, contains?, window, limit ≤ 50 | Matching log lines with trace links |
| `find_traces` | service?, window, criteria: errors\|slowest, limit ≤ 10 | Trace summaries (duration, status, entry span) |
| `get_trace` | trace_id | Full span tree with timings, statuses, linked error logs |
| `list_deploys` | window | Deploy/change events |
| `submit_report` | structured report (see below) | Ends the investigation |

Tool results are hard-capped (~4KB JSON each) so context stays bounded: 15 steps × 4KB ≈ 60KB of tool results worst case — no summarization machinery needed (noted as future work for longer investigations).

### The report (structured, rendered in UI)

`summary` (one paragraph), `timeline[]` (ts + event), `root_cause` (hypothesis + mechanism), `evidence[]` (metric deltas, trace IDs, log excerpts — each clickable in the UI), `blast_radius` (affected services/endpoints + customer impact judgment), `confidence` (low/med/high + why), `suggested_action`.

### Chat mode (same core, second entry point)

The identical loop and tools (minus `submit_report`; final text is the answer), a conversational persona, and SSE token streaming to the browser. History is client-held and replayed per request (capped ~20 turns) — no server session state, no auth, defensible simplicity. Chat can reference incidents ("what happened at 14:32?" → it queries the same world).

### Cost guardrails (protecting the key, not "rate limiting")

Max 2 concurrent investigations; max 10 investigations/hour; per-investigation budget ≈ 200k input + 16k output tokens (≈ $0.60–0.90 worst case on Sonnet); chat messages ≤ 2k chars, ≤ 8 tool steps per turn; chaos scenario trigger cooldown 30s (global). Counters live in `meta`/DO state.

## 10. API surface

```
GET  /                       UI (static assets)
GET  /api/state              topology + per-service health + sparkline series
GET  /api/incidents          incident list (recent first)
GET  /api/incidents/:id      incident + steps (UI polls this at 2s during investigation)
POST /api/chaos/:scenario    inject fault (bad-deploy | dependency-outage | latency-creep | traffic-spike)
POST /api/chaos/restore      clear all faults
POST /api/admin/reset        wipe + re-backfill world (cooldown-protected)
POST /api/chat               SSE: token stream + tool-activity events
```

No auth anywhere (hard requirement: no login screens).

## 11. UI

React + Vite + Tailwind, built into the Worker's static assets. No chart library, no graph library: sparklines and the topology view are small hand-rolled SVG components (fixed layout, six nodes — a graph library is unjustifiable at this size). Four areas in one page:

1. **System view**: topology with live health coloring (green/amber/red from detector state) and per-service sparklines (rate, errors, p95).
2. **Chaos panel**: the four scenario buttons + restore + reset, each with a one-line description of what it breaks.
3. **Incidents**: feed of incidents; opening one shows the live investigation timeline (each tool call and result as it happens) and the final report with clickable evidence.
4. **Chat**: streaming conversation with the same agent.

Design intent: clean, dark, observability-tool aesthetic; the wow moment is watching the timeline advance on its own.

## 12. Repository layout

```
src/
  index.ts            Worker entry: router, cron handler, DO exports
  sim/                topology.ts, generator.ts, scenarios.ts, simulator-do.ts, backfill.ts
  telemetry/          schema.sql, queries.ts (query layer), retention.ts
  detect/             baselines.ts, detector.ts
  agent/              loop.ts, tools.ts, prompts.ts, investigator-do.ts, report-schema.ts
  api/                routes.ts, chat.ts, chaos.ts
ui/                   Vite React app → dist, served as assets
test/                 unit/, integration/
scripts/              eval.ts (agent quality benchmark)
docs/specs/           this document
wrangler.jsonc, package.json, vitest.config.ts
```

## 13. Testing & benchmarks

| Layer | Approach | Pass bar |
|---|---|---|
| Simulator | Unit: distribution sanity (p50/p95 within expected bands over N ticks), causal propagation (db failure → checkout error), diurnal curve applied | Deterministic with seeded RNG |
| Query layer & tools | Unit against fixture D1 data (miniflare/vitest-pool-workers) | Exact expected rows/aggregates |
| Detector | Unit: synthetic rollups with injected drift → fires within N minutes; steady-state fixtures → zero false positives; dedupe and auto-resolve transitions | 100% of scripted cases |
| Agent loop | Unit with a **mock LLM** (scripted tool-call sequences): happy path, tool error mid-loop, malformed tool input, step-cap hit, submit_report validation failure | Loop never crashes; terminal states correct |
| Integration | vitest-pool-workers: inject fault → cron tick → incident opened → mock-LLM investigation completes → report persisted | End-to-end in CI, no network |
| **Agent eval** | `pnpm eval` against a deployed or local instance with the **real model**: reset → inject each scenario → wait for report → grade root cause (expected-cause keyword match + LLM-judge fallback) → emit table: scenario, verdict, steps, tokens, wall time | ≥ 3/4 scenarios correctly root-caused; publish the table in the README |

The eval harness is a first-class deliverable: an agent take-home that ships its own eval is the strongest signal we can send an AI-infra company.

## 14. Deployment & ops

- `wrangler deploy` publishes everything to `https://watchtower.<subdomain>.workers.dev`.
- Secrets: `ANTHROPIC_API_KEY` via `wrangler secret put`; local dev uses `.dev.vars` (gitignored). `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` stay in `.env` for the CLI only — never bundled.
- Config via wrangler vars: `MODEL_ID` (default `claude-sonnet-5`), budget caps, sim parameters.
- D1 migrations via `wrangler d1 migrations`.
- CI (GitHub Actions): typecheck + unit/integration tests on PR; deploy on main (secrets as repo secrets). Nice-to-have, phase 7.
- On first deploy: `POST /api/admin/reset` seeds the world (documented in README).

## 15. Risks & mitigations

| Risk | Mitigation |
|---|---|
| D1 write throughput/size creep | Chunked batch writes per tick; retention sweep; volumes estimated at ~2M rows/day, well under paid limits |
| DO eviction mid-investigation | Step-by-step persistence + alarm resumption; worst case incident marked `failed` with partial timeline |
| Model goes sideways (loops, refuses, hallucinates tools) | Step cap, repeated-call guard, schema-validated tool inputs, `submit_report` forced structure, failed-state honesty |
| Reviewer cost abuse (it's an open URL) | Concurrency + hourly caps, token budgets, chaos cooldown; worst-case spend bounded to a few dollars/hour |
| Sonnet latency makes the demo drag | Investigations run 1–3 min by design; the live-streaming timeline turns the wait into the show |
| Simulated world dismissed as toy | The README's honesty boundary section + tool-layer seam argument; realistic causal chains do the convincing |
| Free-tier reviewer curiosity ("does this need paid?") | Paid plan only relaxes limits; note in README which knobs matter on free tier |

## 16. Milestone roadmap (detail lives in the implementation plan)

| Phase | Delivers | Exit criteria |
|---|---|---|
| 0 | Scaffold: wrangler + TS + Hono + Vite UI shell + CI skeleton; deployed hello-world | URL live; `pnpm test` and `wrangler deploy` green |
| 1 | D1 schema + simulator (topology, generator, backfill, retention) | Statistical unit tests pass; world visibly ticking in D1 |
| 2 | Query layer + the 5 read tools | Tool unit tests green on fixtures |
| 3 | Baselines + detector + incidents + auto-resolve | Fault → incident ≤ 90s; zero false positives in steady-state soak |
| 4 | Agent loop: mock-LLM tested, then live Anthropic; investigation persistence | Eval: ≥ 3/4 scenarios correct root cause |
| 5 | Chat mode + SSE streaming | Shared core proven; streaming works at the URL |
| 6 | UI: topology, chaos panel, incident timeline, chat | Full demo loop click-through on the deployed URL |
| 7 | Hardening + README (decisions/tradeoffs/next) + eval table + final deploy | Break-it checklist passes; docs complete; fresh eval run published |

Each phase ends with: tests green → code review pass → manual exit-criteria check, before the next begins. The project is submittable after phase 4 (agent works via HTTP + README); phases 5–7 raise the demo quality.

## 17. Open questions

None blocking. Naming ("Watchtower"), UI stack, and scenario set were confirmed with the project owner on 2026-07-14.
