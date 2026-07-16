# Watchtower

**An AI incident investigator that runs 24/7 on Cloudflare Workers.**
Live: **https://watchtower.dylanburns.workers.dev**

## What this is

Watchtower watches a simulated microservice world ("Acme Shop"), notices when
something breaks using statistical detection, and — when a signal is serious or
ambiguous — hands the incident to a Claude tool-use agent that investigates the
telemetry, forms a hypothesis, and writes a root-cause report. A chaos panel lets
you inject faults on demand and watch the whole pipeline run end to end.

It is a self-demoing production watchdog: no setup, no real outage required. Click
a fault, watch detection escalate to an agent investigation, read the verdict.

## Try it

**https://watchtower.dylanburns.workers.dev**

**5-minute demo script:**

1. Open the URL. The **System** panel shows six services (green) and the last
   incident already sitting in the feed — a seeded, resolved bad-deploy from a few
   hours ago, so a first-time visitor immediately sees what a finished
   investigation looks like.
2. In the **Chaos** panel, click **Bad deploy** ("Start here"). A `payments`
   deploy exhausts its database connection pool.
3. Within ~2 minutes the detector opens a **critical** incident (payments latency +
   errors, cascading into checkout and gateway). The panel shows a "watchdog
   scanning…" state, then the incident appears.
4. Open the incident. The timeline advances live as the agent calls tools
   (`query_metrics`, `find_traces`, `get_trace`, `list_deploys`, `get_incidents`).
   When it finishes, the report renders: summary, root cause, blast radius,
   confidence, suggested action, and clickable evidence chips (trace trees / log
   lines).
5. Click **Restore**. Health greens out and the incident auto-resolves within a
   few minutes.

The **Chat** panel answers questions about the observed world ("what happened
recently?") using the same read tools, streaming with visible tool activity.

## How it works

```
                    ┌─────────────── Cloudflare Worker ───────────────┐
  chaos panel ─────▶│  Hono API (/api/*)                              │
                    │    ├─ SimulatorDO ("world") ── generates ──▶ D1 │
   1-min cron ─────▶│    ├─ detect/sweep ── reads D1, opens incidents │
                    │    │        └─ escalates ──▶ InvestigatorDO      │
                    │    │                          └─ Claude loop ──▶ │ D1 (report)
                    │    └─ api/chat ── streaming SSE chat agent       │
   React SPA  ◀─────│  Workers assets (ui/dist), run_worker_first     │
                    └─────────────────────────────────────────────────┘
```

- **`SimulatorDO`** (a singleton Durable Object) owns the world: a fixed
  six-service topology, a deterministic seeded generator, and four fault
  scenarios. It ticks every 20s, generating spans + logs + rollups into D1, and
  backfills 24h of history on reset. Fault state and cooldowns live in DO storage.
- **D1** is the single source of truth for telemetry (`spans`, `logs`, `rollups`,
  `deploys`) and incident lifecycle (`incidents`, `incident_fingerprints`,
  `investigation_steps`, `baselines`). The agent's tools are, fundamentally, SQL
  questions — so KV/R2/Queues add nothing and are deliberately absent.
- **The detector** (`detect/sweep.ts`, driven by a 1-minute cron) computes
  median+MAD baselines over trailing 24h rollups, then applies hard-trip and
  sustained rules with evidence gates (see *The agent* → detection). A trip opens
  or updates an incident and escalates to the investigator.
- **`InvestigatorDO`** runs the Claude tool-use loop, persisting every step to D1
  and the raw conversation to DO storage so an investigation resumes intact after
  an eviction.
- The **UI** is a Vite React SPA served from `ui/dist` via Workers assets;
  `run_worker_first: ["/api/*"]` keeps the JSON API in front of the SPA fallback.

## The agent

**The loop** (`src/agent/loop.ts`) is domain-agnostic — it knows only an `LLM`
seam, a list of tools, an `executeTool` callback, and a budget. Each iteration:
inject any undelivered detector update as a user message → call the model → execute
tool calls → append shape-capped results → repeat. The assistant's `response.content`
is appended **verbatim** (signed thinking blocks echoed unchanged). Termination is
normally the model calling `submit_report`; every other path (an `end_turn` without
a report, a tripped cap, an ignored loop-guard nudge) funnels through a single
forced-`tool_choice` salvage call, and if that too comes back empty the outcome is
`failed`. The loop never throws.

**Tools** (7, all `strict: true`): `query_metrics` (timeseries with baseline
overlay — the "scope which services are abnormal" first stop), `search_logs`,
`find_traces`, `get_trace` (full span tree, shape-capped to ≤40 spans while always
keeping the error path root-to-leaf), `list_deploys`, `get_incidents` (prior-incident
context — a recurrence is strong evidence), and `submit_report`. Results are
row/shape-capped in the query layer with `truncated` markers, never byte-sliced.

**Prompt caching** is real and verified. A `cache_control` breakpoint sits on the
last system block plus the most recent message each iteration; the system prompt is
byte-stable per investigation (the open-time timestamp is stamped once). Measured on
a live run:

| step | uncached input | cache read | cache write | output |
|---|---|---|---|---|
| 1 | 2 | 0 | 6,741 | 259 |
| 2 | 2 | 6,741 | 11,033 | 358 |
| 3 | 2 | 17,774 | 453 | 407 |
| 4 | 2 | 18,227 | 2,788 | 352 |
| 5 | 2 | 21,015 | 1,647 | 1,993 |

Every step past the first reads the whole prior conversation from cache (cache
reads bill at ~0.1× input); only ~2 tokens per step are uncached. A full
investigation (~9 tool calls + report) costs on the order of **$0.10–$0.40**.

**Budgets & caps.** Investigator: 1 active investigation at a time; ≤10
investigations/hour; 15 steps; 4-minute wall clock; ≈200k in / 16k out tokens.
These are tracked cumulatively across resumes so a crash-and-resume never re-grants a
fresh budget. Chat is capped tighter: 8 tool steps, 60 turns/hour globally, 2
concurrent SSE streams, 32KB body, 2k-char last message.

**Detection** (`detect/rules.ts`). Baselines are median + MAD per
(service, operation, metric). Two rule families, each pairing a ratio threshold with
an **evidence gate**: hard-trip (one extreme minute — e.g. `error_rate ≥ max(25%,
10×baseline)` **and** ≥3 errors) and sustained (two consecutive minutes). Latency
rules require a p50 distribution-shift confirmation, which kills the dominant
false-positive mode: a single downstream-timeout span lifts a thin minute's p95 by
10–30× but leaves the median untouched, whereas a real regression lifts both. The
gates were tuned against a multi-day false-positive bound (measured residual ~0.17
FP/day, absorbed by the incident layer's dedupe + auto-resolve). Detection is
**anchored on the newest minute actually present in `rollups`**, never wall-clock
arithmetic — the simulator writes a closed minute's rollups up to ~20s after the
boundary, later than the cron fires, so wall-clock anchoring evaluated an empty
minute every tick (a bug found and fixed during go-live).

**Persistence & resume** (`InvestigatorDO`). After every step: the raw `messages`
array → DO storage, a human-readable row → `investigation_steps`. The alarm handler
resumes from stored state inside a try/catch; any resume failure marks the incident
`failed` rather than looping. On `submit_report`, cited evidence (span trees, log
lines) is fetched and embedded into `report_json` at submit time, so reports stay
fully viewable after the raw telemetry ages out.

## Decisions & tradeoffs

- **Simulation honesty boundary.** Error logs are symptom-only — message templates
  never name the injected cause, so the agent has to reason from evidence rather than
  read the answer off a log line. The generator propagates errors causally (a
  payments-db failure surfaces as `downstream` errors up through payments → checkout
  → gateway), which is what makes root-causing non-trivial.
- **Sampled persistence + write budget.** Every error trace is kept; healthy traces
  are sampled at ~10% (whole-trace granularity). Measured: a full 24h backfill writes
  ~37k spans + ~12k logs + ~19k rollups ≈ **69k raw inserts/day**; billable (spans
  ×3, logs ×2, rollups ×2) ≈ **175k rows/day** before retention — comfortably inside
  D1's ≈0.5M/day budget and far under the 50M/mo included allowance.
- **Detection-latency math.** Sustained rules need two completed, rolled-up minutes
  of breach; with the simulator's ~20s write lag and the cron cadence, a fault
  surfaces as an incident in ~1.5–2.5 min. Measured cold-start on the deployed world:
  **107s** from inject to incident open (bad-deploy).
- **One-storyline dedupe.** An incident is keyed by service:metricClass fingerprints;
  a still-breaching fault folds into the same incident (no re-open, no second
  investigation) while `open|investigating|reported`. `failed` re-arms after 10 min;
  `resolved` never suppresses. Auto-resolve requires all fingerprints healthy for 5
  consecutive minutes.
- **Compound faults are disabled on purpose.** One scenario active at a time; other
  chaos buttons disable while a fault runs. This turns the weakest demo path into a
  documented scope decision.
- **Durable Objects over Cloudflare Workflows.** The investigation loop is
  short-lived (1–3 min) and the DO gives streaming state persistence for free;
  hand-rolled control flow is easier to defend line-by-line than a Workflows DAG.
- **Free tier is unsupported.** D1's free tier caps at 100k writes/day and errors on
  *all* queries once exhausted — the simulator would blow through it in under an hour.
  Watchtower requires Workers Paid.

## What's deliberately missing

- **Real telemetry connectors** (Sentry, OTel, cloud providers). The tool layer is
  the seam where these would plug in — swap the D1-backed `read.ts` for a real query
  adapter and the agent is unchanged. That's the obvious "what's next."
- **Compound / overlapping faults** and multi-incident correlation.
- **Alert delivery** (Slack/email/PagerDuty), **auth**, **multi-tenancy**,
  **billing** — out of scope by the brief. Cost guardrails exist only to protect the
  API key, not as a product feature.
- **Pixel-perfect UI.**

## Eval results

`pnpm eval` drives the deployed system through all four fault scenarios (restore →
inject → poll to `reported` → grade → restore → wait resolved) and grades each report
with required-mention keyword groups over `root_cause + summary`. Latest run against
production:

<!-- EVAL_TABLE -->
_(table pasted from `docs/eval-latest.md` after the current eval run completes)_

Gate: ≥ 3/4 scenarios root-caused correctly.

## Running it yourself

```bash
pnpm install
npx wrangler d1 create watchtower          # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply watchtower --remote
npx wrangler secret put ANTHROPIC_API_KEY  # or put it in .dev.vars for local dev
pnpm deploy                                # builds ui/dist, then wrangler deploy
curl -X POST https://<your-worker>/api/admin/reset   # seed + backfill the world
```

- `pnpm dev` — wrangler dev + the Vite UI dev server together.
- `pnpm test` — full suite (vitest + `@cloudflare/vitest-pool-workers`, migrations
  auto-applied per isolate; all local, no network).
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm eval [--base https://…]` — run the four-scenario eval.

Secrets live in `.dev.vars` / `wrangler secret`; `.env` and `.dev.vars` are
gitignored. The design spec and implementation plan live in `docs/` (they document
the process). See `docs/breakit-chat.md` and `docs/breakit-checklist.md` for the
adversarial and hardening passes.
