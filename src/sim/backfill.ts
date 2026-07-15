/**
 * Chunked history backfill for a freshly-reset world (spec §6: "24h of rollups + sampled
 * exemplars ... chunked across SimulatorDO alarm ticks"). Pure, like `generator.ts`: no
 * `Date.now()`, no I/O — `SimulatorDO` is the only thing that reads the wall clock or touches D1;
 * this module just computes what one chunk's telemetry looks like.
 *
 * `RequestStat` (see `generator.ts`) carries no timestamp of its own, so the only way to attribute
 * a chunk's requests to the right per-minute rollup is to call `generateWindow` once per
 * minute-aligned sub-window rather than once for the whole chunk — mirrors `SimulatorDO`'s live
 * tick loop, which faces the same constraint.
 */

import type { LogLine, RollupRow, Span } from "../telemetry/types";
import { generateWindow, rollupFromStats, sampleForPersistence } from "./generator";
import { mulberry32 } from "./rng";
import { identityEffects } from "./scenarios";

/** Total backfilled history on reset (spec §6: "24h ending at reset time"). */
export const BACKFILL_TOTAL_MS = 24 * 60 * 60 * 1000;

/** Per-alarm-tick chunk size (spec §6 / task brief: "~4h of history per tick"). Evenly divides
 * `BACKFILL_TOTAL_MS` into exactly 6 chunks. */
export const BACKFILL_CHUNK_MS = 4 * 60 * 60 * 1000;

/** Minute granularity shared with `SimulatorDO`'s live-tick rollup accounting. */
export const MINUTE_MS = 60_000;

/** Deterministic 32-bit seed derived from a window's start ms (Knuth-style integer mix), so
 * re-generating the same chunk (e.g. after a hypothetical retry) reproduces the same synthetic
 * history. Not cryptographic — determinism is the only requirement, matching `rng.ts`'s
 * `mulberry32` contract. */
export function seedForWindow(fromMs: number): number {
  let h = fromMs >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** What one backfill chunk generates, ready for the caller to persist. */
export interface BackfillChunkBatch {
  spans: Span[];
  logs: LogLine[];
  rollups: RollupRow[];
}

/**
 * Generates one chunk's worth of history in `[fromMs, toMs)` — always with `identityEffects`
 * (backfill never replays a fault scenario; the seeded incident's own telemetry, if any, is
 * `seed-incident.ts`'s concern, not this module's). `fromMs`/`toMs` are expected minute-aligned
 * (true for every chunk boundary `SimulatorDO` computes off a minute-floored reset time), so the
 * per-minute loop below always walks whole minutes.
 */
export function runBackfillChunk(fromMs: number, toMs: number, simRate: number): BackfillChunkBatch {
  const spans: Span[] = [];
  const logs: LogLine[] = [];
  const rollups: RollupRow[] = [];
  const effects = identityEffects();

  for (let minuteStart = fromMs; minuteStart < toMs; minuteStart += MINUTE_MS) {
    const minuteEnd = Math.min(minuteStart + MINUTE_MS, toMs);
    const rng = mulberry32(seedForWindow(minuteStart));
    const batch = generateWindow(minuteStart, minuteEnd, effects, rng, simRate);
    const sampled = sampleForPersistence(batch, rng);
    spans.push(...sampled.spans);
    logs.push(...sampled.logs);
    // Rollups always reflect 100% of traffic (spec §6), independent of persistence sampling —
    // built from the unsampled `batch.requests`, not `sampled`.
    rollups.push(...rollupFromStats(batch.requests, minuteStart));
  }

  return { spans, logs, rollups };
}
