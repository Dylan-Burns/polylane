# Cloudflare-native revamp — design

**Date:** 2026-07-17
**Status:** approved (decisions locked with the user; implementation notes grounded in a 7-reader codebase map — full maps in the session workspace)
**Scope:** four workstreams over sim + detection + agent + UI. The simulated *monitored* system becomes a believable Cloudflare-native architecture, and the System/Incident UI grows into typed, near-live, tabbed surfaces in the polylane.com idiom.

## Why

The current topology (`gateway/checkout/payments/...`) reads as generic boxes; the user wants the demo to teach the *actual mechanics* of a modern stack. polylane.com's own product surfaces (typed CF resources, tabbed issue detail, blast-radius graph) are the reference idiom. Additionally the Grid view balloons at full width, and the metric lines only gain a point ~once/minute with no liveness cue.

## Decisions (locked with the user)

1. **Re-model end-to-end, authentic CF stack** — not a UI relabel, not a marketing-matched stack. The simulated app is re-typed to the primitives Watchtower itself runs on (Workers + D1 + KV + Queues). Same 7-node shape and edge set, so detection mechanics and fault stories carry over.
2. **Near-real-time metrics via a backend live partial** — a current-minute partial point in the state feed, not merely animation.
3. **Tabbed incident detail** — Overview / Metrics / Logs / Traces / Timeline / Properties, per the polylane issue panel.
4. **Grid redesign** — typed node cards (CF product icon + sublabel), capped size, tighter layout.

## The node mapping (workstream 1 — foundation)

| Old name | New name | Type (icon + sublabel) | Notes |
|---|---|---|---|
| gateway | `edge-gateway` | Cloudflare Worker | entry; traffic-spike = edge surge |
| checkout | `checkout-edge` | Cloudflare Worker | |
| payments | `payments-api` | Cloudflare Worker | bad-deploy ships here |
| payments-db | `ledger-db` | Cloudflare D1 | pool-exhaustion → D1 queued-query saturation |
| catalog | `catalog-kv` | Worker + KV | red-herring deploy target |
| notifications | `notify` | Queue → consumer Worker | |
| email-provider | `email-api` | External API (dashed) | dependency-outage target |

Operations keep their semantics but adopt CF-native phrasing where the fault strings surface them (e.g. the pool-exhaustion log line becomes a D1-flavored saturation error such as `D1_ERROR: too many queued queries — 25 in flight, acquire timed out after 5000ms`; exact strings finalized in the plan against `sim/generator.ts`).

**Coherence rule (non-negotiable):** every layer that names services moves in one commit series — `sim/topology.ts` + `scenarios.ts` + generator fault strings + `seed-incident.ts` + detector references + investigator/chat prompt topology + `grade.ts` keyword groups + UI (`NODE_POSITIONS`, Galaxy labels) + all tests. A UI-only or sim-only rename is the failure mode this spec exists to prevent: the screen would say `ledger-db` while reports say `payments-db`.

Node *type* becomes first-class data on the topology (`kind: "worker" | "d1" | "kv" | "queue" | "external"` or similar), so the UI renders typed icons/sublabels from data instead of hardcoding, and the investigator prompt can describe the stack accurately.

## Workstream 2 — Grid view redesign

Problems today: the fixed-viewBox SVG scales to the full content width (cards balloon on wide screens); node cards are plain name+sparklines.

- Cap the grid's rendered width (`max-w` on the SVG container) and center it; the SVG viewBox stays fixed-layout.
- Node cards adopt the polylane resource-card idiom: type icon + name, type sublabel (`Cloudflare Worker`, `D1`, …), health dot, three metric rows (RATE/ERR/P95) with sparklines + current values.
- External `email-api` keeps the dashed treatment with its type label.
- Density: tighter paddings; the card reads at a glance without dominating the view.

## Workstream 3 — Near-real-time metrics

Today: sparklines are per-minute `rollups`, written ~20s after each minute closes; the UI polls every 5s but a new point lands ~once/minute.

- The state feed gains a **live partial point** per service for the open minute (rate/err/p95 over spans seen so far this minute), clearly distinguished from closed-minute points.
- The Systems view polls faster (~2–3s) while visible; the newest point visibly creeps, then locks in when the minute's rollup lands.
- UI affordance: a "now" marker on the live point + freshness line (e.g. `live · updated 2s ago`); reduced-motion respected.
- **Implementation (decided from the codebase map):** `SimulatorDO` *already* accumulates the open minute's full-traffic `RequestStat[]` in its `partialMinute` storage (`simulator-do.ts:81-84, 359-390`) and discards it at minute close — it is simply never exposed. The live point is that data aggregated through the existing `rollupFromStats` and surfaced through the DO status path into `/api/state` as a new `live` field (per-service `{rate, errPct, p95, minuteTs}`). Full-traffic parity with rollups by construction; **no raw-span queries** (spans are a sampled subset — a span-derived rate would systematically undercount next to rollup history), no new D1 reads/writes/indexes.
- Detection is untouched: `sweep.ts` anchors on closed minutes and `breachesSustainedThreshold` explicitly assumes complete minutes — the live partial is a UI-feed field only and must never be fed into detection.

## Workstream 4 — Tabbed incident detail

The incident modal restructures into tabs, polylane's issue-panel idiom:

- **Overview** — typed resource header (icon + service + type sublabel), summary, key metric tiles, blast radius (typed nodes), suggested action + approve.
- **Metrics** — the incident-window metric charts per affected service (existing MetricTiles data, expanded).
- **Logs** — the log excerpts already embedded in the report evidence + a live view while raw data exists. No incident-scoped logs endpoint exists today, so this tab gets a thin new read route (`GET /api/incidents/:id/logs`, a wrapper over the existing `searchLogs` scoped to the incident's window and affected services — read-only, capped like every other read).
- **Traces** — the evidence trace(s) (existing TraceDrawer content) as a tab.
- **Timeline** — the existing investigation timeline (steps, tool calls, report) — unchanged content, new home.
- **Properties** — incident metadata: id, status, severity, fingerprints, opened/reported/resolved timestamps, scenario/version strings named in the report, budget/token spend.

Which tabs need new API reads vs. reuse of existing payloads is finalized from the UI map; the modal remains hash-friendly (deep-linkable incident stays reachable from Incidents view).

## Migration & operational notes

- **Reset required post-deploy**: telemetry/baselines/rollups rows carry old service names; a world reset (wipe + reseed) re-derives everything under new names, including the `baselines` table (backfill recomputes baselines synchronously, so there is no degraded-detection window after a reset — only if the rename were deployed *without* a reset would detection silently fall back to floors-only until 24h of new-name baselines accumulated; the runbook therefore makes the reset mandatory, immediately post-deploy).
- Do not deploy the rename mid-incident: open incidents carry old-name fingerprints, and `findOwnersByFingerprint` would stop matching them (duplicate incidents). Deploy from a restored, incident-quiet world.
- The eval suite must run green under the new names before merge (grade keywords move with the rename). Scenario **ids/route slugs are stable** (`bad-deploy`, `dependency-outage`, `latency-creep`, `traffic-spike`) — only display labels/descriptions re-theme, so `eval.ts` and the chaos API surface don't change.
- D1 write budget and index count are unchanged.

## Implementation notes from the codebase maps (binding on the plan)

1. **Canonical rename table is the single source of truth** — every implementer transcribes from it; `payments` → `payments-api` must be applied longest-match-first (`payments-db` first) or word-boundary-aware, or it double-hits.
2. **Known tripwires**: `scenarios.ts:52` `establishedLogMessage("payments-db:query_ledger")` throws at module load if the key it references disappears (renames must move it in the same commit); `seed-incident.ts:499-514` gates rollup elevation on literal `WHERE service = 'payments'/'checkout'` SQL; two independent deploy version strings exist by design (live `v2.4.1`, seeded `v3.0.0`) — both survive, re-typed as Worker versions.
3. **Honesty boundary is asymmetric**: deploy notes and log messages stay symptom-only under new names (never "fault"/"chaos"/scenario names); the seeded incident's *report prose* is exempt (it's the agent's own conclusion) — preserve that asymmetry.
4. **Three UI name-keyed maps fail silently** on mismatch (`NODE_POSITIONS`, Galaxy `ANCHORS`, `SERVICE_HUE` — unknown names just don't render); they move in lockstep with the rename, and the Galaxy CVD hue-pairing (blue/violet at opposite ends, pinned per service) carries over deliberately, not regenerated.
5. **Node type becomes server data**: topology gains `kind: "worker" | "d1" | "kv" | "queue" | "external"` per service, served through the existing `/api/state` topology payload (`TopologyServiceNode` gains `kind`), so grid/galaxy/incident-Properties all render typed icons from data. `email-api` keeps `external: true`.
6. **Prompt/keyword surfaces**: `renderTopology()` auto-propagates the rename into both prompts; the two duplicated external-dependency sentences (`prompts.ts:61-62`, `chat-prompt.ts:59-60`) are hand-edited in lockstep; `grade.ts` GRADES keyword groups are re-authored per scenario (e.g. latency-creep `['payments-db','database']` → `['ledger-db','d1','database']`), keeping substring-match semantics in mind (bare `'api'`-style keywords are forbidden — too false-positive-prone).
7. **Tests have no shared fixture module** (~20 files of inline literals). The rename updates them per-cluster; `state.test.ts`'s topology-shape test is updated *first* as the structural anchor. `grade.test.ts` and investigator/tools prose fixtures are re-authored (narratives describing the new fault mechanics), not find/replaced.
8. **rules.ts doc comments** naming old services are updated with an explicit note that the empirical threshold validation was measured pre-rename on the same shapes (labels change; the measurements' provenance stays honest).

## Out of scope

- New nodes (a Durable Object hop was considered and declined — same shape stays).
- Real Cloudflare API integration; this remains the simulated world.
- Auth/multi-tenancy; UI test infra.

## Verification

- Full unit/integration suite green under new names (tests updated in lockstep).
- `pnpm eval` (all four scenarios) ≥ 3/4 against the deployed worker post-rename — same gate as v1.0.0.
- Browser pass: typed grid at desktop/mobile, live-point movement, tabbed panel on a real incident, both themes.
