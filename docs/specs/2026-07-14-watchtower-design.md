# Watchtower — Design Specification

**Date:** 2026-07-14 (v2 — revised after adversarial design review, same day)
**Status:** Ready for review
**Context:** Take-home exercise for Polylane (see `INSTRUCTIONS.md`). Build and deploy a working AI agent on Cloudflare Workers that does something genuinely useful for understanding, monitoring, or investigating software infrastructure.

**v2 changelog (from adversarial review — 5 lenses, 47 confirmed findings):** honest detection-latency math with a hard-trip fast path; D1 write budget recomputed with index/delete amplification and volume cut ~10×; explicit Sonnet 5 thinking/effort policy and prompt caching; resume-fidelity persistence design; chat hardened as the primary abuse surface; stuck-investigation watchdog and status lifecycle; fault stacking disabled by design; reset sequencing; seeded first-visit incident; phases reordered so the demo ships before chat.

---

## 1. Summary

Watchtower is a **self-demoing production watchdog**. A single Cloudflare Worker deployment contains a complete miniature world:

- A simulated multi-service production system ("Acme Shop") emitting realistic, causally-correlated telemetry (traces, logs, metrics, deploy events).
- A **chaos panel** where a reviewer injects faults with one click.
- A **watchdog agent** that maintains a statistical memory of "normal," detects drift on its own (typically within ~1–2.5 minutes), opens an investigation, works the problem with real tools (metrics → logs → traces → deploys), and publishes a structured incident report — with the investigation streaming live in the UI.
- A **chat mode** exposing the same agent core for ad-hoc questions.

The reviewer's instinct to "try to break it" *is* the demo: click "ship a bad deploy," watch the detector trip, then watch the agent investigate and explain the causal chain.

## 2. Goals

1. Satisfy every hard requirement: runs on Cloudflare Workers; a real agent loop with tools across multiple steps; usable at a public URL with no login.
2. Score maximally on the stated rubric: works when poked; strong agent design (tool boundaries, loop control, context management, failure handling); visible judgment; clear code; platform features used only where they earn their place.
3. Address the explicit hint that "producing realistic telemetry to investigate is part of the exercise, and we will notice if it is done well."
4. Keep idle **LLM** cost ≈ $0: detection is statistical; the model runs only when something is worth investigating or a user chats. (D1 background writes are budgeted explicitly in §6 and stay inside the plan's included quota.)

## 3. Non-goals (deliberate, documented in README)

- Real cloud/telemetry connectors (Sentry, OTel, AWS). The tool layer is designed as the seam where these would plug in; building one is "what we'd do next."
- Authentication, rate limiting as a feature, billing (excluded by the instructions). Cost guardrails exist only to protect the API key.
- Alert delivery (Slack/email/PagerDuty).
- Multi-tenancy; one shared world per deployment.
- Cloudflare Workflows. Considered for the investigation loop; rejected in favor of a Durable Object because the loop is short-lived (1–3 min), the DO gives us streaming state persistence for free, and hand-rolled control flow is easier to defend line-by-line in the walkthrough.
- **Compound-fault handling.** One chaos scenario may be active at a time; other buttons disable while a fault runs (tooltip: "one incident at a time — compound faults are in next steps"). This converts the weakest demo path into a documented scope decision.
- Free-tier operation. The telemetry volume requires Workers Paid: D1's free tier allows 100k rows written/day and **returns errors on all queries** once the cap is hit — the simulator would exhaust it in under an hour. A `SIM_RATE` knob exists, but free-tier support is explicitly out of scope.
- Pixel-perfect UI.

## 4. Constraints

- Cloudflare Workers, **paid plan** ($5/mo) — required, see §3.
- LLM: Anthropic API, `claude-sonnet-5` ($3/$15 per MTok; intro $2/$10 through 2026-08-31), key held as a Worker secret, model ID configurable via env var.
- Roughly one day of focused work; phases ordered so the project is submittable early and each later phase only raises quality.
- Follow-up interview is a live code walkthrough: every dependency and abstraction must be defensible. Prefer hand-rolled-but-simple over framework magic.

## 5. Architecture

One Worker, one `wrangler deploy`, TypeScript everywhere.

```
┌─────────────────────────── Cloudflare Worker ────────────────────────────┐
│  Static assets (React UI, built by Vite)                                 │
│  API router (Hono) — run_worker_first: ["/api/*"] so browser-navigated   │
│  API GETs hit the Worker, not the SPA shell                              │
│                                                                          │
│  SimulatorDO ──(alarm ~20s)──► telemetry batches ──► D1 (telemetry)      │
│      ▲ owns: fault state, cooldowns, world status,                       │
│      │       backfill progress (single writer, serialized)               │
│  POST /api/chaos/* ──► SimulatorDO                                       │
│                                                                          │
│  Cron (1 min) ──► detect → baselines → retention (isolated subtasks)     │
│                     └─anomaly─► InvestigatorDO (agent loop)              │
│                                  │  Anthropic Messages API               │
│                                  │  (prompt-cached, adaptive thinking)   │
│                                  └─► steps → D1; convo state → DO storage│
│                                                                          │
│  POST /api/chat (SSE) ────────────────► same agent core, chat persona    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Runs as | Responsibility |
|---|---|---|
| Simulator | Durable Object (`SimulatorDO`), sub-minute alarm | Generates each window's telemetry from topology + fault state; **sole owner** of fault state, chaos cooldowns, world status (`running`/`seeding`/`resetting`), and backfill; all chaos/restore/reset mutations route through it and serialize |
| Telemetry store | D1 | Spans, logs, rollups, deploys, incidents, fingerprints, investigation steps; retention tiers |
| Query layer | Plain TS module over D1 | Typed query functions; the **only** way anything (tools, UI, detector) reads telemetry |
| Detector | Cron handler (1 min) | Three isolated subtasks in order: detection → baseline recompute (every 15 min) → retention sweep (chunked deletes with watermark). Also: stuck-investigation watchdog, auto-resolve |
| Investigator | Durable Object (`InvestigatorDO`) | The agent loop; persists steps to D1 (UI projection) and raw conversation to DO storage (resume fidelity); enforces budgets |
| Chat | Worker request handler (SSE) | Same agent core + tools, hardened input handling, conversational persona |
| UI | Static assets (React + Vite + Tailwind) | Topology/health view, chaos panel, incident feed + live investigation timeline, chat |

### Why these platform features (and no others)

- **Durable Objects**: the simulator needs a single serialized writer for fault state and a sub-minute timer (cron can't go below 1 min); the investigator needs serialized execution, persisted progress, and alarm-based recovery. Both are textbook DO fits.
- **Cron trigger**: the detector is a periodic, stateless sweep — exactly what cron is for.
- **D1**: the agent's tools are fundamentally SQL questions. KV/R2/Queues/Workflows add nothing here and are deliberately absent.
- **SSE streaming**: chat tokens stream; investigation timelines poll (2s) because step-granular updates don't benefit from a held connection.

## 6. The demo universe

### Topology (static, data-driven, one file)

```
gateway ──► checkout ──► payments ──► payments-db
   │            │
   │            └──► notifications ──► email-provider (external)
   └──► catalog
```

Six services; `email-provider` is an external dependency (no internal spans, only call results). Each service has 2–3 operations with distinct latency/error profiles.

### Generation model

- **Traffic**: ~1.5 req/s at peak with a mild diurnal curve (0.5–1.0× by hour) plus noise → ~95k requests/day. All generated requests feed **rollups** (metrics reflect full traffic); only a subset of raw traces persists (below).
- **Traces**: correct parent/child spans along the dependency graph; log-normal latencies per (service, operation); child durations nest inside parents; errors propagate up the chain realistically.
- **Telemetry honesty calibration** (the graders build observability tools — planted confessions would show): error logs are *symptom*-realistic ("connection pool exhausted: 25/25 in use, acquire timeout 5000ms") but never name the root cause; scenario 1's answer requires **correlating the deploy event with the regression onset** across tools, not reading a log. Ambient error noise (~0.2–0.5% baseline) and an occasional benign deploy (a red herring near incident windows) are always present. Scenarios 3 and 4 are log-silent by design.
- **Deploys**: occasional benign deploy events; fault scenarios emit their own.
- **Rollups**: 1-minute rollups per (service, operation) computed in-memory from full traffic and written once per minute-close by the simulator — the pre-aggregation pattern real observability stores use.

### Raw persistence (sampled, budget-driven)

- Persist **all error traces** plus a **10% sample** of healthy traces (with their logs). Rollups always reflect 100% of traffic. `find_traces`/`get_trace` operate on persisted traces; sampling is disclosed in the README (it's what real systems do).
- **D1 write budget** (billable rows = inserts × (1 + indexes) + deletes): spans ~43k/day ×3 (two indexes) + logs ~40k/day ×2 (one index) + rollups ~22k/day ×2 + retention deletes ~250k/day ≈ **~0.5M billable rows/day ≈ 15M/month — ~30% of Workers Paid's included 50M**. Stated here so the number is defensible in the walkthrough.

### Backfill & retention

- On deploy/reset: backfill **24h of rollups + sampled exemplars** (~25k rows), **chunked across SimulatorDO alarm ticks** (~4h of history per tick; D1 caps at 100 bound params/statement and 1,000 statements/invocation, so single-shot backfill is not viable). Reset returns immediately; `/api/state` exposes `seeding` progress; the world is live in ~2–3 min.
- Backfill ends with a **synchronous baseline recompute** — the detector is never armed without baselines.
- The backfill also **seeds one resolved incident** with a full investigation timeline and report, so a reviewer's first 10 seconds show the end product without waiting for a live cycle.
- Retention (chunked deletes in the cron sweep, watermark in `meta`, bounded rows per run): raw spans/logs **6h**; rollups **72h**; incidents/investigations kept indefinitely.

### The honesty boundary

The world is simulated so reviewers get deterministic, causally-rich incidents — but **the agent never knows**. It consumes telemetry exclusively through the query-layer tools, which present the same shape a real backend would. Swap the D1-backed query layer for a real connector and the agent is unchanged. Stated plainly in the README.

### Fault scenarios (each a chaos-panel button; one active at a time)

| # | Scenario | Mechanism | What it tests in the agent |
|---|---|---|---|
| 1 | **Bad deploy** | Deploy event `payments@v2.4.1`, then payments latency ×6 + pool-exhaustion errors → checkout timeouts → gateway 5xx | Change correlation across tools (logs name symptoms only) |
| 2 | **Dependency outage** | `email-provider` → 100% errors; notifications degrade; checkout unaffected | Blast-radius scoping: "low customer impact" is the right answer |
| 3 | **Latency creep** (labeled "slow burn: ~5 min") | `payments-db` p95 degrades over ~4 min | Drift without a sharp edge |
| 4 | **Traffic spike** | 5× load on gateway; elevated latency everywhere; no defect | Root cause = load, not a bug |

Plus **Restore world** (clears fault state; always allowed; metrics recover; incidents auto-resolve) and **Reset world** (wipe + re-backfill; cooldown-protected). While a scenario is active, other scenario buttons return `409 scenario_active` and render disabled.

### Reset sequencing (the most predictable "break it" move)

Reset executes **inside SimulatorDO** so it serializes with ticks and chaos calls: set status `resetting` → cancel pending alarm → mark any active investigation `failed` ("world reset", partial timeline preserved) → wipe **telemetry tables only** (incidents and investigation steps are kept) → chunked backfill → synchronous baseline recompute → status `running`, alarm re-armed. The detector no-ops unless the world status (fetched from SimulatorDO at sweep start) is `running`. DO input gates do **not** protect across D1/fetch awaits, so the wipe+backfill sequence runs under `blockConcurrencyWhile` for the state transitions and tags chunk writes with a world-generation counter; stale-generation writes are discarded.

## 7. Data model (D1)

```sql
spans(trace_id, span_id, parent_span_id, service, operation, start_ms, duration_ms, status, error_type)
logs(ts_ms, service, level, message, trace_id?, span_id?)
rollups(service, operation, minute_ts, count, error_count, p50_ms, p95_ms, p99_ms)
deploys(id, service, version, ts_ms, note)
incidents(id, status, severity, opened_at, reported_at?, resolved_at?, trigger_json, report_json?, follow_up_of?)
incident_fingerprints(incident_id, fingerprint, first_seen_ms, delivered_to_agent)
investigation_steps(incident_id, step_no, kind: tool_call|tool_result|note|report|error,
                    content_json, ts_ms, tokens_in, tokens_out)
baselines(service, operation, metric, median, mad, computed_at)
meta(key, value)   -- retention watermarks, guardrail counters, world generation
```

Indexes: `spans(service, start_ms)`, `spans(trace_id)`, `logs(service, ts_ms)`, `rollups(service, operation, minute_ts)`. No third span index — write amplification is budgeted in §6.

- `incidents.severity` is assigned by the **detector at open time** from breach magnitude (`warning` = sustained-rule trip, `critical` = hard-trip or multi-service fingerprints); the agent's report may comment but doesn't change it; the UI displays it.
- Fingerprints are a **set** per incident via `incident_fingerprints` (scenario 1's cascade produces several at open time).
- Fault state lives in **SimulatorDO storage only** — `meta` never holds fault flags (single source of truth).
- Raw conversation state for resume lives in **InvestigatorDO storage**, not D1 (see §9); `investigation_steps` is the human-readable UI projection.

## 8. Detection: statistics decide *when* to think

- **Baselines**: per (service, operation, metric ∈ {req_rate, error_rate, p95}) — median + MAD over the trailing 24h of rollups. No hour-of-day adjustment (the diurnal curve is mild; multiplicative thresholds absorb it — a deliberate simplification, noted in the README). Recomputed every 15 min, and synchronously at the end of backfill.
- **Rules**, evaluated each minute (missing baseline row ⇒ error_rate falls back to its absolute floors; p95/req_rate rules are skipped until baselines exist). Every rule pairs a ratio threshold with an **evidence gate** — absolute error counts for error rules, a p50 distribution-shift confirmation for latency rules — because at this world's per-operation volumes (~10–15 req/min on the checkout path) small-sample noise otherwise produces hundreds of spurious p95 trips/day, while naive request-count gates (≥20 req/min) structurally disable detection on exactly the operations the fault scenarios hit. (v2.1 revision, validated empirically both ways.)
  - **Hard trip (1 completed minute)** — for sharp faults: `error_rate ≥ max(25%, 10× baseline)` with **≥ 3 errors**; `p95 ≥ 4× baseline` with **p50 ≥ 2.0× its baseline** (distribution shift, not a lone outlier) and ≥ 5 requests; `req_rate ≥ 4× baseline` with ≥ 20 requests (a real spike is high count by definition; the 5× traffic-spike scenario must trip it).
  - **Sustained (2 consecutive minutes)** — for marginal drift: `error_rate > max(5%, baseline + 6×MAD)` with **≥ 3 errors in each minute**; `p95 > 2.5× baseline` with **p50 ≥ 2.0× its baseline** and ≥ 5 requests, both minutes; `req_rate > 3× baseline` with ≥ 10 requests.
  - Baselines therefore cover **four** metrics: req_rate, error_rate, p95, **p50** (migration 0002 rebuilds the baselines table's metric CHECK).
- **Honest latency envelope**: a completed anomalous minute + 1-min cron ⇒ hard-trip detection lands **~60–150s** after injection; sustained-rule detection ~2–3 min. Target (and phase gate): **incident opened ≤ 2.5 min** for scenarios 1, 2, 4; scenario 3 fires when the creep crosses thresholds (~4–6 min, disclosed on its button). After a chaos click the UI shows a "watchdog scanning…" state so the wait reads as the system working, not broken.
- **Incident lifecycle**: `open → investigating → reported → resolved | failed`.
  - Dedupe: an incident in `open`/`investigating`/`reported` whose fingerprint set covers an anomaly suppresses re-firing. `resolved` never suppresses; `failed` stops suppressing after a 10-min re-arm delay (prevents both per-minute failure spam and permanently bricked detection).
  - New fingerprints from the same cascade: appended to `incident_fingerprints` **and delivered** — the InvestigatorDO checks for undelivered fingerprints before each model call and injects them as a `detector update:` user message. Arriving after `reported`: recorded on the incident as post-report anomalies (visible in UI), and a follow-up incident (linked via `follow_up_of`) opens only if they persist past the re-arm delay.
  - **Auto-resolve**: applies to `open` and `reported` only — all fingerprints healthy 5 consecutive minutes ⇒ `resolved`. An `investigating` incident always runs to its report (the report notes if metrics already recovered mid-investigation).
  - **Stuck-investigation watchdog**: the sweep force-fails any `investigating` incident with no step written for > wall-clock cap + 2 min grace — recovery must not depend on the thing that died.

The detector is pure TypeScript over rollups — deterministic, unit-testable, zero LLM cost at idle.

## 9. The investigator agent

### Anthropic API policy (explicit, because Sonnet 5 defaults changed)

- **Thinking**: Sonnet 5 runs adaptive thinking by default and thinking tokens bill as output against `max_tokens`. Investigator: `thinking: {type: "adaptive"}`, `output_config: {effort: "medium"}` — bounded thinking per step, `max_tokens` sized with headroom. Chat: `thinking: {type: "adaptive", display: "summarized"}` surfaced as a "thinking…" SSE activity event so streaming stays lively.
- **Never set non-default `temperature`/`top_p`** — Sonnet 5 rejects them with a 400.
- **The loop appends `response.content` verbatim** as the assistant turn (thinking blocks carry signatures and must be echoed unchanged in tool-use turns — reconstructing them 400s).
- **Prompt caching**: system prompt + tools are byte-stable per investigation (current time is stamped **once** at open, not per call) with a `cache_control` breakpoint on the last system block and on the most recent message each iteration. Cuts the worst-case investigation from ~$0.84 to ~$0.40 (input ~4× cheaper; output unaffected), and materially cuts per-step latency. Verified in dev via `usage.cache_read_input_tokens`.
- **SDK does the retrying**: `new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 60_000 })` — no hand-rolled backoff; per-call timeout never exceeds the remaining wall-clock budget, so a hung request degrades into the salvage path instead of stalling the loop.

### Loop mechanics

- Trigger: the detector creates the incident and calls `InvestigatorDO` with a crisp anomaly statement ("checkout error_rate 22% vs baseline 0.4% since 14:32Z; related: payments p95 8× baseline").
- System prompt: role, topology, investigation protocol (verify → scope blast radius → drill down → check changes → conclude), tool guidance, investigation-open timestamp, report rubric.
- Each iteration: check for undelivered detector updates (inject as user message) → model call → execute tool calls via the query layer → append capped results → repeat.
- **Termination**: normally by the model calling `submit_report`. On `end_turn` without a report, or on hitting the step cap (15) / token budget / wall clock (4 min) with budget for one more call: a final request with `tool_choice: {type: "tool", name: "submit_report"}` and a salvage instruction to conclude now and set confidence by the system prompt's calibration guide (low only if the causal chain is still unconfirmed — not a blanket clamp, which mis-rated confirmed-then-capped investigations) — nearly every investigation yields a report; `failed` is reserved for hard failures (API dead, world reset). A dedicated **Confidence calibration** section in the system prompt anchors low/medium/high to how directly the evidence supports the mechanism, and states explicitly that inability to inspect code/config diffs does not cap confidence when the operational evidence (trace-confirmed chain + corroborating deploy/log/recurrence signal) is conclusive.
- **Loop guard**: an identical tool call (normalized to absolute time windows) repeated 3× consecutively gets a synthetic error result nudging toward `submit_report`; termination only if the nudge is ignored. Time-advancing re-checks of the same query are legitimate investigation, not a stuck loop.
- **Persistence, two representations**: (1) the exact request/response content — including signed thinking blocks and verbatim capped `tool_result` payloads — in **InvestigatorDO storage** after each step (resume fidelity); (2) human-readable step rows in `investigation_steps` (UI timeline projection). The DO re-arms its alarm **before** each await (a pending alarm must exist across every await or eviction orphans the loop); the alarm handler wraps resume in try/catch and marks the incident `failed` rather than rethrowing (DO alarms retry ~6× then go silent — a crash-looping resume must not burn them).
- **Tool failure handling**: tool errors return to the model as error results; `strict: true` on all tool schemas makes malformed inputs an API-level impossibility rather than a runtime branch.

### Tools (the entire agent-world interface)

| Tool | Input (abridged) | Returns |
|---|---|---|
| `query_metrics` | service?, operation?, metrics[], window, step | Timeseries **with baseline overlay and delta** per point |
| `search_logs` | service?, level?, contains?, window, limit ≤ 50 | Matching log lines with trace links |
| `find_traces` | service?, window, criteria: errors\|slowest, limit ≤ 10 | Trace summaries (duration, status, entry span) |
| `get_trace` | trace_id | Span tree with timings, statuses, linked error logs |
| `list_deploys` | window | Deploy/change events |
| `get_incidents` | window?, id? | Past incidents with reports (powers "what happened at 14:32?" in chat; gives the investigator prior-incident context) |
| `submit_report` | structured report (below) | Ends the investigation (investigator only) |

**Result caps are shape-aware, never byte-sliced**: enforced as row/span limits in the query layer; `get_trace` collapses repeated healthy sibling spans but always preserves the error path root-to-leaf; every capped result carries `truncated: true` plus what was omitted ("showing 12 of 87 spans") so the model drills down instead of trusting a partial view. ~4KB/result keeps 15 steps ≈ 60KB of tool results — no summarization machinery needed.

### The report (structured via `strict` schema, rendered in UI)

`summary`, `timeline[]`, `root_cause` (hypothesis + mechanism), `evidence[]` (metric deltas, trace IDs, log excerpts), `blast_radius` (affected services + customer-impact judgment), `confidence` (low/med/high + why), `suggested_action`. **Evidence payloads (span-tree excerpt, log lines) are embedded into `report_json` at submit time** — reports stay fully viewable after raw telemetry expires (6h); live drill-down beyond that uses the read API while data exists.

### Chat mode (same core, second entry point — and the primary abuse surface)

Same loop and tools (minus `submit_report`; final text is the answer), conversational persona, SSE streaming. Hardening, since this is an unauthenticated URL whose worst case is otherwise bounded only by org-level Anthropic rate limits (~$720/hr, two orders of magnitude above the "few dollars" story):

- System prompt assembled **server-side only**; persona scoped to the observed world; declines unrelated tasks.
- Client-held history is **untrusted input**: text-only user/assistant turns, strict alternation enforced, tool_use/tool_result blocks rejected — tool activity only ever originates server-side within a turn. Total request body capped at 32KB, message ≤ 2k chars, history ≤ 20 turns (server-side truncation).
- Budget caps produce a visible "budget reached" message, never a hang.

### Cost guardrails (protecting the key, not "rate limiting")

**1** active investigation (matches the one-storyline dedupe; enforced as an invariant backstop); ≤ 10 investigations/hour; per-investigation budget ≈ 200k in / 16k out (≈ $0.40 with caching); chat: ≤ 8 tool steps/turn, global ≤ 60 chat turns/hour, ≤ 2 concurrent SSE streams; chaos trigger cooldown 30s (serialized in SimulatorDO). Counters in `meta`/DO state. Worst-case total spend: a few dollars/hour, now including chat.

## 10. API surface

```
GET  /                       UI (static assets; assets config: not_found_handling=SPA + run_worker_first=["/api/*"])
GET  /api/state              topology + per-service health + sparklines + world status (running|seeding|resetting)
                             + ops health (last sweep success, retention watermark age)
GET  /api/incidents          incident list (recent first)
GET  /api/incidents/:id      incident + steps (UI polls at 2s during investigation)
GET  /api/traces/:id         span tree (live drill-down for evidence links, within raw retention)
GET  /api/logs               filtered logs (service, level, window) — same query layer as the agent tools
POST /api/chaos/:scenario    inject fault; 409 scenario_active if one is running
POST /api/chaos/restore      clear all faults (always allowed)
POST /api/admin/reset        wipe telemetry + re-backfill (cooldown-protected; incidents preserved)
POST /api/chat               SSE: token stream + tool-activity + thinking-activity events
```

**Per-service health mapping** (computed in the query layer behind `/api/state`): **red** = service appears in an `open`/`investigating`/`reported` incident's fingerprints; **amber** = last completed minute breaches a sustained-rule threshold but isn't yet sustained (pre-incident), or incident recovering; **green** otherwise.

## 11. UI

React + Vite + Tailwind, served as Worker static assets. No chart or graph libraries — sparklines and the six-node topology are small hand-rolled SVG components. Four areas:

1. **System view**: topology with live health coloring and per-service sparklines (rate, errors, p95); "watchdog scanning…" indicator after a chaos click; world status banner during seeding/reset.
2. **Chaos panel**: four scenario buttons (+ restore + reset) with one-line descriptions and expected timescales; a "**Start here** → ship a bad deploy and watch" cue; buttons disabled while a scenario is active.
3. **Incidents**: feed (the seeded resolved incident is visible on first visit); opening one shows the live timeline (each tool call and result as it lands) and the final report with clickable evidence.
4. **Chat**: streaming conversation with the same agent, including visible thinking/tool activity.

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

## 13. Testing & benchmarks (right-sized: the instructions reject coverage for its own sake)

**Keep — each earns its place on the rubric:**

| Layer | Approach | Pass bar |
|---|---|---|
| Detector | Unit: synthetic rollups — hard-trip fires on minute 1, sustained on minute 2; steady-state fixtures → zero false positives; lifecycle transitions (dedupe, re-arm, auto-resolve, stuck-watchdog) | 100% of scripted cases |
| Agent loop | Unit with a **mock LLM**: happy path, tool error mid-loop, end_turn-without-report salvage, step-cap salvage, duplicate-call nudge, resume-from-persisted-state | Loop never crashes; terminal states correct |
| Query layer/tools | Focused fixtures for the queries the agent actually runs (not exhaustive) | Expected rows/aggregates |
| Simulator | Light sanity: seeded RNG determinism; error propagation reaches the right ancestors; rollups match generated batches | A handful of assertions, not distribution suites |
| **Agent eval** | `pnpm eval` against a deployed instance with the **real model**: reset → wait for `running` → inject each scenario → wait for report → grade root cause (expected-cause rubric + keyword match) → table: scenario, verdict, steps, tokens, wall time | ≥ 3/4 scenarios correctly root-caused; table published in README |

**Demoted to next-steps**: simulator statistical-band suites, exhaustive query fixtures, full CI integration matrix. CI itself: typecheck + unit tests on PR from phase 0; deploy-on-main is phase-7 polish.

The eval harness is a first-class deliverable: an agent take-home that ships its own eval is the strongest signal we can send an AI-infra company.

## 14. Deployment & ops

- `wrangler deploy` → `https://watchtower.<subdomain>.workers.dev`.
- Secrets: `ANTHROPIC_API_KEY` via `wrangler secret put`; local dev uses `.dev.vars` (gitignored). CLI credentials stay in `.env` (gitignored), never bundled.
- Config via wrangler vars: `MODEL_ID`, budget caps, `SIM_RATE`.
- D1 migrations via `wrangler d1 migrations`.
- First deploy: `POST /api/admin/reset` seeds the world (README documents this; seeding completes in ~2–3 min and `/api/state` shows progress).

## 15. Risks & mitigations

| Risk | Mitigation |
|---|---|
| D1 cost creep | Explicit write budget (§6, ~15M billable rows/month vs 50M included); sampled persistence; chunked retention with watermark; ops health on `/api/state` makes a wedged sweep visible |
| DO eviction mid-investigation | Raw-content persistence + alarm re-armed before every await + try/catch alarm handler; stuck-watchdog force-fails as last resort |
| Model goes sideways | Step cap, duplicate-call nudge, strict schemas, forced `submit_report` salvage, honest `failed` state |
| Reviewer abuse of the open URL | Chat input hardening + global caps (§9); chaos cooldowns serialized in the DO; worst case bounded to a few dollars/hour |
| Reset/restore races | All world mutations serialize through SimulatorDO; generation counter discards stale writes; detector no-ops unless world is `running`; investigations failed cleanly on reset |
| Detection feels slow after a chaos click | Hard-trip rules (~60–150s typical); "watchdog scanning…" UI state; button labels set expectations |
| Sonnet latency makes the demo drag | Prompt caching cuts per-step latency; the streaming timeline turns the wait into the show |
| Simulated world dismissed as toy | Honesty-boundary README section; symptom-only logs + red herrings force real cross-signal inference |
| Empty first impression | Seeded resolved incident + "Start here" cue |

## 16. Milestone roadmap (detail lives in the implementation plan)

| Phase | Delivers | Exit criteria |
|---|---|---|
| 0 | Scaffold: wrangler + TS + Hono + Vite shell + CI (typecheck/test) + **README skeleton**; deployed hello-world | URL live; `pnpm test` green; README stubs in place |
| 1 | D1 schema + simulator: topology, generator, **scenarios (fault mechanics)**, chunked backfill, retention | Sim sanity tests pass; world ticking in D1; billable-write budget verified against real counts |
| 2 | Query layer + all seven tools | Tool tests green on fixtures |
| 3 | Baselines + detector + incident lifecycle + **/api/chaos routes** | Fault → incident ≤ 2.5 min (scenarios 1, 2, 4); zero false positives over a 2h steady soak; stuck/dedupe/re-arm transitions tested |
| 4 | Agent loop (mock-LLM tests → live Anthropic) + **minimal demo surface**: chaos buttons + incident timeline/report page + **minimal README** | Eval ≥ 3/4 correct; project is genuinely submittable (URL + README) |
| 5 | Full UI: topology/health, sparklines, seeded incident, polish | Demo loop click-through on the deployed URL |
| 6 | Chat mode + SSE + input hardening | Adversarial chat script handled (injection, oversized, off-topic) |
| 7 | Hardening pass + README final (decisions/tradeoffs/next + eval table) + deploy-on-main CI | Break-it checklist passes (incl. reset mid-investigation); fresh eval published |

Each phase ends with: tests green → code review → manual exit-criteria check. The README skeleton is updated at **every** phase boundary — the graded "judgment" artifact is written continuously, not last. After phase 4 the submission is real; 5–7 raise its ceiling.

## 17. Open questions

None blocking. Naming ("Watchtower"), UI stack, scenario set, and the paid-plan requirement were confirmed with the project owner on 2026-07-14.
