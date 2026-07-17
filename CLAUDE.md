# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

polylane ("Watchtower") is an AI incident investigator on Cloudflare Workers: a simulated e-commerce system emits telemetry into D1, a cron sweep detects anomalies and opens incidents, and an agent loop (Claude via the Anthropic SDK) investigates and reports. Since 2026-07-17 the simulated topology is CF-native — `edge-gateway`/`checkout-edge`/`payments-api` (Workers), `ledger-db` (D1), `catalog-kv` (Worker+KV), `notify` (Queue consumer), `email-api` (external) — the old `gateway/checkout/payments/payments-db/catalog/notifications/email-provider` names survive only in pre-rename incident reports and provenance comments. Design specs: `docs/specs/2026-07-14-watchtower-design.md` + `docs/specs/2026-07-17-cf-native-revamp-design.md`; implementation plans: `docs/plans/`.

## Commands

- `pnpm test` — full suite (vitest + `@cloudflare/vitest-pool-workers`; migrations auto-applied per test isolate)
- `pnpm test -- test/unit/loop.test.ts` — a single test file; add `-t "name"` for a single test
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm dev` — wrangler dev + UI dev server concurrently
- `pnpm deploy` — builds `ui/dist` then `wrangler deploy` (bare `wrangler deploy` serves a stale/missing UI)
- `pnpm eval [--base https://…]` — drive all four fault scenarios against a deployed URL, grade root-cause accuracy, write `docs/eval-latest.md`
- Migrations: `wrangler d1 migrations apply watchtower` (files in `migrations/`; add `--remote` for the deployed DB)

## Architecture

- `src/index.ts` — entry: Hono app (mounts `api/routes.ts` GETs, `api/chaos.ts`, `api/chat.ts`, `api/remediate.ts` at `/api/*`) + the `scheduled` handler driving `detect/sweep.ts` every minute
- `src/sim/` — SimulatorDO (singleton `world`): topology, generator, fault scenarios, backfill/reset
- `src/telemetry/` — D1 read/write layer (`read.ts` is the query seam; shape-aware result caps live here), incidents lifecycle, retention
- `src/detect/` — baselines (median/MAD), rules, the cron sweep (world gate → detect → lifecycle → baselines → retention)
- `src/agent/` — the loop core (`loop.ts`, domain-agnostic; LLM seam in `llm.ts`: `realLLM`/`streamingLLM` are the real adapters, `scriptedLLM`/`scriptedStreamingLLM` the test doubles), tools (strict schemas), prompts, InvestigatorDO (persistence/resume/budgets), chat prompt
- `src/api/chat.ts` — hardened SSE chat endpoint (validation, meta-backed cost guardrails)
- `ui/` — Vite SPA served from `ui/dist` via Workers assets (`run_worker_first=["/api/*"]`)
- Tests: `test/unit/` (pure/D1 logic) and `test/integration/` (SELF fetch, DOs via `runInDurableObject`); all local, no network — LLM paths use scripted doubles

## Constraints that bite

- Secrets via `.dev.vars` / `wrangler secret put ANTHROPIC_API_KEY`; `.env`/`.dev.vars` are gitignored — never commit them
- Epoch-ms timestamps everywhere (`_ms` suffix); windows resolve via `agent/window.ts`'s `parseWindow`
- Exactly four explicit D1 indexes (two on `spans`, one on `logs`, one on `rollups`) — the write budget is real
- Commit conventional-commit style; never commit failing tests
