# Break-it hardening checklist (Task 7.1)

Executed against the deployed URL `https://watchtower.dylanburns.workers.dev` on 2026-07-15.
Every item passed; where a gap was found it was fixed with a test (noted inline).

## Static / validation (read-only, no world disruption)

- [x] **Browser-navigate every GET endpoint** (SPA/`run_worker_first` regression). With
  `Accept: text/html`, `/api/health`, `/api/state`, `/api/incidents`, `/api/logs`, and
  `/api/traces/:id` all return `application/json`, never the SPA HTML shell. `run_worker_first:
  ["/api/*"]` holds.
- [x] **`GET /api/incidents/999`, `GET /api/traces/999`** → `404 {"error":"not_found"}` (clean JSON,
  no 500).
- [x] **Garbage query params** → `GET /api/logs?level=bogus` → `400 {"error":"invalid_level",...}`;
  `?from=garbage` → `400` with the `WindowError` message; same for `/api/incidents?from=garbage`.
- [x] **Malformed chat JSON** → `400 {"error":"request body must be valid JSON"}`;
  first-turn-assistant → `400 "conversation must start with the user"`; non-string content →
  `400 "content must be a string"`. No 500s in `wrangler tail`.
- [x] **Garbage chaos scenario** → `POST /api/chaos/not-a-scenario` → `404 {"error":"unknown_scenario"}`.

## Budget kill-switch

- [x] **Hourly investigation budget exhausted** → the incident still opens, but no investigator
  starts and a visible `note` step ("Investigation deferred — the hourly investigation budget is
  exhausted…") is written to the incident timeline instead of silence. **Fix applied:** the
  budget-exhausted branch in `detect/sweep.ts` previously only `console.warn`ed; it now records the
  note. Covered by `test/integration/sweep.test.ts` → "budget kill-switch".

## Live lifecycle (chaos / reset stress)

Executed 2026-07-16 06:41–07:20Z against the deployed URL (worker version `67d48dcb`).

- [x] **Double-click chaos button (races the cooldown)** → two concurrent
  `POST /api/chaos/bad-deploy` at 06:53:07Z: one `200` (fault set), one `409
  {"error":"scenario_active"}` — the DO's `blockConcurrencyWhile` input gate serializes them.
  Exactly one fault in `/api/state`, exactly one incident followed (`inc-bc9cf9d8…`, opened
  06:55:52Z — 165s from inject; bad-deploy's effects start 30s post-inject by design, so ~135s
  from effect onset).
- [x] **Reset mid-investigation** → `POST /api/admin/reset` at 06:56:33Z while `inc-bc9cf9d8…` was
  `investigating`: `202 {"status":"resetting"}`; the incident flipped to `failed` with
  `failure_reason: "world reset"` and its partial timeline stayed visible (13 steps: note,
  tool_calls, tool_results). World reseeded to `running`; the next chaos click worked (cycle below).
- [x] **Chaos during `seeding`** → `POST /api/chaos/latency-creep` 2s after the reset: `409
  {"error":"world_not_ready","worldStatus":"seeding"}`. **Fix applied:** `handleFault` previously
  gated only on active-fault + 30s cooldown — a reset clears the fault and seeding outlives the
  cooldown, so a direct mid-seed POST was silently accepted (the fault sat invisibly until the
  world flipped to running). `SimulatorDO.handleFault` now requires `worldStatus === "running"`;
  the chaos panel gets a distinct toast for the race where a click lands as the world flips.
  Covered by `test/integration/simulator.test.ts` → "rejects /fault with 409 world_not_ready".
- [x] **Auto-resolve soak (restore → resolved)** → the pre-existing `reported` dependency-outage
  incident (`inc-e4f7b38f…`) resolved ~6 min after `POST /api/chaos/restore` at 06:41:13Z
  (5-consecutive-healthy-minutes rule), and per-service health followed red → amber → green.

- [x] **Restore 30s after inject (recovery before/during investigation)** → `dependency-outage`
  injected 06:58:52Z (a `200` — also proving chaos works right after the reset above), restored
  06:59:22Z. The ~30s error burst still hard-tripped detection: incident opened 06:59:52Z (60s
  from inject), investigation ran 37.7s, report landed 07:00:29Z with the correct root cause
  (email-provider 503s, high confidence, recurrence noted). Incident auto-resolved 07:05:52Z —
  6.5 min after restore. **Honest deviation from the checklist's expectation:** the report does
  NOT "note recovery", and at this system's measured timing it structurally can't — the first
  fully-recovered rollup minute (07:00) closed at ~07:01:11, 42s *after* the report was submitted.
  Detection (60s) plus investigation (38s) outrun the one-minute rollup granularity, so recovery
  is never observable to the reporting agent; it is handled one level up, by the incident
  lifecycle's auto-resolve (and is visible to the chat agent on later queries). The item's core
  intent — a mid-recovery investigation neither wedges nor misattributes, the report lands, the
  incident resolves — holds.

