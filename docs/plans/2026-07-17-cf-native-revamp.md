# Cloudflare-native Revamp Implementation Plan

> **For agentic workers:** executed via orchestrated workflows (ultracode session). Every implementer transcribes names/strings from the **canonical tables** below — never invent variants. Steps use checkbox syntax for tracking.

**Goal:** Execute `docs/specs/2026-07-17-cf-native-revamp-design.md`: re-type the simulated world to an authentic Cloudflare stack end-to-end, redesign the Grid view with typed node cards, add a near-real-time live metric point, and restructure incident detail into tabs.

**Architecture:** Phase R (rename, five disjoint source clusters in parallel → tests → gate) is the foundation; Phases G (grid), L (live), T (tabs) build on it independently; Phase V verifies, deploys, resets the world, and re-runs the eval gate.

## Global Constraints

- Worker + UI change together but D1 schema does NOT: no new tables, columns, or indexes (4-index budget is hard).
- Scenario ids / chaos route slugs are FROZEN: `bad-deploy`, `dependency-outage`, `latency-creep`, `traffic-spike`. Display labels/descriptions re-theme only.
- Operations are FROZEN (`route_checkout`, `place_order`, `charge`, `query_ledger`, …) — only service names change.
- Honesty boundary: log messages + deploy notes stay symptom-only (may name real tech like `D1_ERROR`; never "fault"/"chaos"/"inject"/scenario names). Seeded-incident report prose is exempt.
- Rename order: replace `payments-db` before `payments`, everywhere (substring hazard).
- Verify cycle: `pnpm typecheck` + `pnpm test` for worker/tests; `pnpm build:ui` for UI; browser + eval in Phase V.
- Conventional commits; never commit failing tests.

---

## Canonical Table 1 — service names (the ONLY mapping)

| Old | New | kind |
|---|---|---|
| `gateway` | `edge-gateway` | `worker` |
| `checkout` | `checkout-edge` | `worker` |
| `payments` | `payments-api` | `worker` |
| `payments-db` | `ledger-db` | `d1` |
| `catalog` | `catalog-kv` | `kv` |
| `notifications` | `notify` | `queue` |
| `email-provider` | `email-api` | `external` |

`kind` type: `export type ServiceKind = "worker" | "d1" | "kv" | "queue" | "external";` declared in `src/sim/topology.ts` with `export const SERVICE_KIND: Readonly<Record<string, ServiceKind>>` covering all seven names; threaded into `/api/state`'s topology payload (`TopologyServiceNode` gains `kind: ServiceKind`).

UI sublabel copy per kind (single UI-side map): worker → `Cloudflare Worker`, d1 → `D1 database`, kv → `Worker + KV`, queue → `Queue consumer`, external → `External API`.

## Canonical Table 2 — ERROR_LOG_MESSAGES value changes (keys auto-update via `stepKey`)

Only FOUR values change (CF texture exactly where the type shows); all others keep their current strings verbatim:

| stepKey (new names) | New value |
|---|---|
| `ledger-db:query_ledger` | `D1_ERROR: too many queued queries — 25 in flight, acquire timed out after 5000ms` |
| `ledger-db:update_ledger` | `D1_ERROR: database is locked — ledger write retried 3 times, giving up` |
| `catalog-kv:list_products` | `KV list failed: cursor expired mid-pagination` |
| `catalog-kv:get_product` | `KV get failed: read timed out at edge cache` |

Unchanged values (verbatim): gateway entries `request handling failed: unexpected client disconnect`; checkout trio (`cart lookup failed: session state missing`, `checkout processing failed: invalid cart state`, `refund processing failed: order state conflict`); payments pair (`payment authorization failed: card issuer declined`, `refund request failed: settlement batch not found`); notify pair (`email send failed: connection reset by peer`, `template render error: missing field 'order_id'`); email-api `upstream 503 from provider`.

**Tripwire:** `scenarios.ts:52` `establishedLogMessage("payments-db:query_ledger")` → `establishedLogMessage("ledger-db:query_ledger")` in the SAME commit as the topology rename, or module load throws.

## Canonical Table 3 — deploys (version strings unchanged)

- bad-deploy real: `service: "payments-api", version: "v2.4.1", note: "routine release"` (id auto-derives via `deployId`).
- red herring: `service: "catalog-kv", version: "v1.8.3", note: "routine release"`.
- Seeded incident keeps `v3.0.0` on `payments-api`; its literal SQL `WHERE service = 'payments'` / `'checkout'` (seed-incident.ts:499-514) becomes `'payments-api'` / `'checkout-edge'`.

## Canonical Table 4 — SCENARIOS display text (ids frozen)

- `bad-deploy`: label `Bad Worker deploy`; description `A payments-api Worker release quietly regresses latency and reliability starting 30s after ship, cascading into checkout-edge timeouts and edge-gateway 5xxs.`; expectedDetection: same sentence as today with services renamed (payments→payments-api, checkout→checkout-edge, gateway→edge-gateway, catalog→catalog-kv).
- `dependency-outage`: description `The external email API becomes fully unavailable; notify sends fail, but checkout completes normally.`; expectedDetection renames notifications/email-provider → notify/email-api.
- `latency-creep`: label unchanged; description `ledger-db (D1) latency ramps up gradually over about 4 minutes with no sharp edge and no change in error rate.`; expectedDetection renames payments-db → ledger-db, "the database tier" stays.
- `traffic-spike`: description `Edge traffic jumps 5x; latency rises broadly across services with no underlying defect.`; expectedDetection unchanged except gateway → edge-gateway.

## Canonical Table 5 — grade.ts GRADES (re-authored)

```ts
export const GRADES: Record<ScenarioId, Grade> = {
  "bad-deploy": {
    must: [["deploy", "v2.4.1", "release", "ship"], ["payments"], ["queued quer", "saturat", "pool", "connection", "acquire", "latency"]],
  },
  "dependency-outage": { must: [["email"], ["notif"]], mustNotBlame: ["checkout"] },
  "latency-creep": {
    must: [["ledger-db", "ledger", "d1", "database"], ["latency", "slow", "p95", "creep", "degrad"]],
    mustNotBlame: ["deploy"],
  },
  "traffic-spike": { must: [["traffic", "load", "spike", "volume"]], mustNotBlame: ["bug", "deploy"] },
};
```

(`"payments"` deliberately still matches `payments-api`; no bare `"api"`-style keywords — substring semantics.)

## Canonical Table 6 — prompt sentence (both files, verbatim)

`prompts.ts` and `chat-prompt.ts` external-dependency sentence becomes:
`email-api is an external SaaS dependency the notify Worker calls; it emits no internal spans of its own, only a latency/error outcome folded into the calling step.`

## Canonical Table 7 — live metric payload

- SimulatorDO `handleStatus` gains `live`: per-service aggregate of the open minute's accumulated `RequestStat[]` (`partialMinute` storage) via the existing `rollupFromStats` shape: `{ count, error_rate, p95_ms }` + `minuteTs` (open-minute start) + `elapsedMs`.
- `/api/state` response gains `live?: { minuteTs: number; elapsedMs: number; services: Record<string, { count: number; errPct: number; p95: number }> }` (omitted when world not running).
- UI: sparkline gains ONE live slot appended after the last closed minute — err%/p95 plotted raw; rate plotted as `count * 60000 / elapsedMs` and *only when* `elapsedMs >= 10_000` (below that the extrapolation is noise — omit the live rate point, keep err/p95). Live point rendered distinct (signal-colored dot + `animate-scan-pulse`), with a `live · updated Ns ago` line. Reduced motion: no pulse.
- Systems view polls state at 3s while visible (other views keep 5s). Detection never reads `live`.

## Canonical Table 8 — tabs + logs route

- `GET /api/incidents/:id/logs`: 404 unknown id; else derive window `[opened_at - 5min, resolved_at ?? now]`, services = unique service segments of the incident's fingerprints; return `searchLogs`-backed `{ logs, total, truncated }` (limit 50, newest first, no level filter). Read-only; no schema change.
- Detail modal gains a tab bar: `Overview | Metrics | Logs | Traces | Timeline | Properties` (segmented-control styling per the app's existing pill pattern; active tab in the modal's hash-free local state).
  - Overview: typed resource header (kind icon + service + sublabel via SERVICE_KIND map), report summary, MetricTiles, blast radius chips (typed), suggested action + approve button (existing remediate flow).
  - Metrics: full MetricTiles set (existing data).
  - Logs: report evidence log excerpts + live fetch of the new route while raw data exists (graceful "raw telemetry expired" empty state).
  - Traces: existing TraceDrawer content inline.
  - Timeline: existing Timeline + StepCards (unchanged content).
  - Properties: id, status, severity, fingerprints (typed chips), opened/reported/resolved timestamps, token spend (sum of steps' tokens_in/out — already in steps payload), scenario version strings named in report if present.

---

## Phase R — the rename (foundation)

- [ ] **R1 sim-core** (`topology.ts`, `generator.ts`): apply Table 1 to SERVICES/EXTERNAL_SERVICE/Step consts; add `ServiceKind` + `SERVICE_KIND`; apply Table 2 values; update file doc comments.
- [ ] **R2 sim-faults** (`scenarios.ts`, `seed-incident.ts`, `simulator-do.ts`): FaultEffects map keys per Table 1; `establishedLogMessage` key fix (tripwire); Table 3 deploys; Table 4 SCENARIOS; seeded story prose re-authored to new names/strings (report prose may name services/versions freely); seed SQL literals.
- [ ] **R3 prompts+detection+telemetry** (`prompts.ts`, `chat-prompt.ts`, `rules.ts` comments, `state.ts`, `read.ts` touchpoints): Table 6 sentence both files; rules.ts doc comments renamed + provenance note ("thresholds validated pre-rename on identical shapes"); state.ts `buildTopology` threads `kind`; any name literals in state/read comments.
- [ ] **R4 grading** (`scripts/grade.ts`, `scripts/eval.ts` narrative): Table 5 verbatim; eval doc-comment/table text renames.
- [ ] **R5 ui-rename** (`ui/src/panels/System.tsx`, `ui/src/panels/system/Galaxy.tsx`, `ui/src/lib/types.ts`): re-key NODE_POSITIONS/ANCHORS/SERVICE_HUE per Table 1 (hues/positions preserved per name-mapping — CVD pairing intact); `TopologyServiceNode` gains `kind: ServiceKind` (type mirrored in ui types.ts as string union); no card redesign yet.
- [ ] **Gate R-a**: `pnpm typecheck` + `pnpm build:ui` green (tests still red — expected).
- [ ] **R6 tests** (parallel clusters over ~20 files, guided by the tests map): update per Table 1/2/3/4/5; longest-match-first; `state.test.ts` topology-shape test first (anchor); grade.test.ts + investigator/tools prose fixtures re-authored narratively for the new mechanics; fingerprint SQL literals updated.
- [ ] **Gate R-b**: `pnpm test` 373+/373 green + typecheck. Commit series complete.

## Phase G — typed grid redesign

- [ ] NodeCard: kind icon (hand-rolled 16px stroke SVG per kind: worker=CF-style hexagon-bolt, d1=cylinder, kv=key-square, queue=stacked-lines, external=dashed-globe) + name + kind sublabel + health dot + 3 spark rows; tighter paddings.
- [ ] Grid container: `max-w-[980px]` centered (stops the balloon); viewBox untouched; card px sizes rebalanced to fit new header row.
- [ ] Galaxy: label sublabels gain kind tag; hue/anchor behavior unchanged.
- [ ] Gate: build + browser check both themes/widths.

## Phase L — live metrics

- [ ] SimulatorDO: aggregate `partialMinute` in `handleStatus` per Table 7 (pure aggregation of already-stored stats; no new storage writes).
- [ ] `/api/state`: thread `live` through state assembly (`state.ts` + `routes.ts`).
- [ ] UI: live slot per Table 7 (Sparkline gains optional live point prop or an appended slot + dot overlay); freshness line; Systems-view 3s poll.
- [ ] Tests: unit test for the DO aggregation shape (scripted stats → expected `{count, errPct, p95}`), integration test for `/api/state.live` presence when running.
- [ ] Gate: suite green; browser check shows the live point creeping then locking in.

## Phase T — tabbed incident detail

- [ ] Route: `GET /api/incidents/:id/logs` per Table 8 + integration test (seeded incident window returns rows; unknown id 404s).
- [ ] Detail.tsx: tab bar + six tab contents per Table 8, reusing existing components; Properties tab built from existing payload fields.
- [ ] Gate: suite green; browser click-through on a real incident (all six tabs, mobile + desktop, both themes).

## Phase V — verification & ship

- [ ] Full `pnpm test` + `pnpm typecheck` + `pnpm build:ui`.
- [ ] Whole-branch review (spec-compliance + quality) with fixes applied.
- [ ] Deploy; `POST /api/admin/reset` (mandatory — rebuilds telemetry/baselines under new names); wait running.
- [ ] `pnpm eval` all four scenarios: gate ≥3/4 (target 4/4); confidence levels reviewed per the calibration rubric.
- [ ] Browser pass: typed grid, live point, tabs, both themes/widths; screenshots to user.
- [ ] README/spec sync commit; merge to main + push (user pre-authorized merge flow for this revamp only after gates pass and user confirms).
