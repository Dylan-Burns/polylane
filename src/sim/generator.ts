/**
 * Deterministic telemetry generator for the demo universe (spec §6). Pure: no `Date.now()`, no
 * I/O, no `crypto.randomUUID()` — driven entirely by the caller-supplied `rng` and window bounds,
 * so the same seed always reproduces the same batch. Called by both `SimulatorDO`'s tick loop and
 * the backfill job; neither may see side effects here.
 */

import type { LogLine, RollupRow, Span } from "../telemetry/types";
import type { Rng } from "./rng";
import { logNormal, poisson, randomHex } from "./rng";
import { ASYNC_STEP_KEYS, ERROR_LOG_MESSAGES, EXTERNAL_SERVICE, FLOWS, stepKey, type Flow, type Step } from "./topology";

/** Effects a fault scenario (or the chaos panel) layers onto the baseline generation model. */
export interface FaultEffects {
  /** Per-service latency multiplier (e.g. payments-api x6 during a bad deploy). Missing => 1x. */
  latencyMult: Map<string, number>;
  /** Per-service error-rate override, replacing the step's baseline `errorRate` when present. */
  errorRateOverride: Map<string, { rate: number; errorType: string; logMessage: string }>;
  /** Global traffic multiplier (e.g. 5x during the traffic-spike scenario). */
  trafficMult: number;
}

/** One (service, operation) sample — the unit `rollupFromStats` aggregates. One per span. */
export interface RequestStat {
  service: string;
  operation: string;
  duration_ms: number;
  isError: boolean;
}

/** Everything a window of simulated traffic produces, before persistence sampling. */
export interface GenBatch {
  spans: Span[];
  logs: LogLine[];
  requests: RequestStat[];
}

/** Baseline peak throughput (spec §6: "~1.5 req/s at peak"). */
const BASE_REQUESTS_PER_SECOND = 1.5;

/** Diurnal curve's peak hour (UTC). Test fixtures anchor windows here for predictable volume. */
const PEAK_HOUR_UTC = 14;

/**
 * Shared "gave up waiting" ceiling for any span whose status is 'error' because a downstream call
 * failed (brief: "duration ≈ their timeout"). A single constant rather than a per-step timeout
 * table — the demo doesn't need per-service timeout tuning, just a plausible shape.
 */
const DOWNSTREAM_TIMEOUT_MS = 3000;

/** Persistence sample rate for traces with no error span (spec §6: "10% sample"). */
const HEALTHY_TRACE_SAMPLE_RATE = 0.1;

/** Mutable accumulator threaded through the recursive span walk within a single request. */
interface GenCtx {
  spans: Span[];
  logs: LogLine[];
  requests: RequestStat[];
}

/**
 * Mild diurnal curve: 0.5-1.0x, peaking at `PEAK_HOUR_UTC` and troughing 12h opposite (spec §6).
 * `hourUtc` may be fractional (e.g. 14.5 for 14:30 UTC) or outside [0, 24) — the cosine is
 * periodic, so callers don't need to normalize.
 */
export function diurnalMult(hourUtc: number): number {
  const radians = (2 * Math.PI * (hourUtc - PEAK_HOUR_UTC)) / 24;
  return 0.75 + 0.25 * Math.cos(radians);
}

/** Weighted-random flow pick. Weights need not sum to 1 (normalized here). */
function pickFlow(rng: Rng): Flow {
  const total = FLOWS.reduce((sum, f) => sum + f.weight, 0);
  let r = rng() * total;
  for (const flow of FLOWS) {
    if (r < flow.weight) return flow;
    r -= flow.weight;
  }
  return FLOWS[FLOWS.length - 1] as Flow;
}

/** Fractional UTC hour-of-day for `ms` — a pure function of the (simulated) timestamp, not the
 * wall clock. */
function hourUtcOf(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/**
 * Walks one node of a flow's call tree, emitting its span (and, recursively, its children's) into
 * `ctx`, then returns whether it ended in error (for the *parent's* propagation decision) and the
 * ms offset at which it finished (for sequencing later siblings).
 *
 * Span insertion is pre-order — pushed into `ctx.spans` before its children are walked — so array
 * order alone proves "parents precede children"; the span's duration/status/error_type fields are
 * filled in by mutating that same object once its children are known, not by re-inserting it.
 */
function walkStep(
  step: Step,
  startMs: number,
  traceId: string,
  parentSpanId: string | null,
  effects: FaultEffects,
  rng: Rng,
  ctx: GenCtx,
): { spanId: string; errored: boolean; endMs: number } {
  const spanId = randomHex(rng, 8);
  const span: Span = {
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: parentSpanId,
    service: step.service,
    operation: step.operation,
    start_ms: startMs,
    duration_ms: 0,
    status: "ok",
    error_type: null,
  };
  ctx.spans.push(span);

  let cursor = startMs;
  let downstreamErrored = false;
  let causeService: string | null = null;
  let causeLogMessage: string | null = null;

  for (const child of step.children) {
    if (child.service === EXTERNAL_SERVICE) {
      // External dependency (spec §6): no span of its own — its latency/error outcome folds into
      // this step's own timeline and error determination instead of getting a child span.
      const override = effects.errorRateOverride.get(child.service);
      const p = override?.rate ?? child.errorRate;
      const errored = rng() < p;
      const latMult = effects.latencyMult.get(child.service) ?? 1;
      const duration = Math.max(1, Math.round(logNormal(rng, child.latency.mu, child.latency.sigma) * latMult));
      cursor += duration;
      if (errored) {
        downstreamErrored = true;
        causeService = child.service;
        causeLogMessage = override?.logMessage ?? ERROR_LOG_MESSAGES[stepKey(child)] ?? null;
      }
      continue;
    }

    if (ASYNC_STEP_KEYS.has(stepKey(child))) {
      // Fire-and-forget branch (spec §6 scenario 2: "notifications degrade; checkout
      // unaffected"): the async child starts at the current cursor but the parent does NOT wait
      // for it — no cursor advance, no contribution to the parent's duration, and no status
      // propagation. Its span may legitimately end after the parent's does.
      walkStep(child, cursor, traceId, spanId, effects, rng, ctx);
      continue;
    }
    const result = walkStep(child, cursor, traceId, spanId, effects, rng, ctx);
    cursor = result.endMs;
    if (result.errored) {
      downstreamErrored = true;
      causeService = child.service;
      causeLogMessage = null; // generic template below — the child's own span already logged specifics
    }
  }

  const override = effects.errorRateOverride.get(step.service);
  const pOwn = override?.rate ?? step.errorRate;
  const intrinsicErrored = !downstreamErrored && rng() < pOwn;
  const errored = downstreamErrored || intrinsicErrored;

  let duration: number;
  if (downstreamErrored) {
    duration = Math.max(DOWNSTREAM_TIMEOUT_MS, cursor - startMs);
  } else {
    const latMult = effects.latencyMult.get(step.service) ?? 1;
    const selfTime = Math.max(1, Math.round(logNormal(rng, step.latency.mu, step.latency.sigma) * latMult));
    duration = cursor - startMs + selfTime;
  }

  span.duration_ms = duration;
  const endMs = startMs + duration;

  if (errored) {
    span.status = "error";
    if (downstreamErrored) {
      span.error_type = "downstream";
      const message = causeLogMessage ?? `downstream call to ${causeService ?? "dependency"} failed`;
      ctx.logs.push({ ts_ms: endMs, service: step.service, level: "error", message, trace_id: traceId, span_id: spanId });
    } else {
      span.error_type = override?.errorType ?? "error";
      const message = override?.logMessage ?? ERROR_LOG_MESSAGES[stepKey(step)] ?? "request failed";
      ctx.logs.push({ ts_ms: endMs, service: step.service, level: "error", message, trace_id: traceId, span_id: spanId });
    }
  }

  ctx.requests.push({ service: step.service, operation: step.operation, duration_ms: duration, isError: errored });

  return { spanId, errored, endMs };
}

/**
 * Generates 100% of simulated traffic in `[fromMs, toMs)` — every request feeds `requests` (the
 * rollup source); only a sampled subset of traces (see `sampleForPersistence`) is meant to be
 * persisted. Pure and side-effect free: same seed + inputs always produce a deep-equal batch.
 */
export function generateWindow(fromMs: number, toMs: number, effects: FaultEffects, rng: Rng, simRate: number): GenBatch {
  const ctx: GenCtx = { spans: [], logs: [], requests: [] };

  for (let secStart = fromMs; secStart < toMs; secStart += 1000) {
    const hourUtc = hourUtcOf(secStart);
    const lambda = BASE_REQUESTS_PER_SECOND * diurnalMult(hourUtc) * simRate * effects.trafficMult;
    const count = poisson(rng, lambda);

    for (let i = 0; i < count; i++) {
      // Clamp: for non-second-aligned windows the sub-second jitter could otherwise place a
      // request up to 999ms past `toMs`, leaking traffic outside the requested window.
      const requestStartMs = Math.min(secStart + Math.floor(rng() * 1000), toMs - 1);
      const flow = pickFlow(rng);
      const traceId = randomHex(rng, 16);
      const root = walkStep(flow.entry, requestStartMs, traceId, null, effects, rng, ctx);
      // Per-request access log on the entry span's service (brief: "info" level).
      ctx.logs.push({
        ts_ms: requestStartMs,
        service: flow.entry.service,
        level: "info",
        message: `${flow.entry.operation} request handled`,
        trace_id: traceId,
        span_id: root.spanId,
      });
    }
  }

  return { spans: ctx.spans, logs: ctx.logs, requests: ctx.requests };
}

/** Nearest-rank percentile (common APM convention): rank = ceil(p * n), 1-indexed into the
 * ascending-sorted array. */
function nearestRank(sortedAsc: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sortedAsc.length));
  const value = sortedAsc[Math.min(sortedAsc.length, rank) - 1];
  // sortedAsc is non-empty for every group rollupFromStats builds (see below), so this is safe.
  return value as number;
}

/**
 * Aggregates ALL request stats (not just persisted ones — rollups reflect 100% of traffic per
 * spec §6) into one row per (service, operation), independent of persistence sampling.
 */
export function rollupFromStats(stats: RequestStat[], minuteTs: number): RollupRow[] {
  const groups = new Map<string, { service: string; operation: string; durations: number[]; errorCount: number }>();

  for (const stat of stats) {
    const key = `${stat.service} ${stat.operation}`;
    let group = groups.get(key);
    if (!group) {
      group = { service: stat.service, operation: stat.operation, durations: [], errorCount: 0 };
      groups.set(key, group);
    }
    group.durations.push(stat.duration_ms);
    if (stat.isError) group.errorCount += 1;
  }

  const rows: RollupRow[] = [];
  for (const group of groups.values()) {
    const sorted = [...group.durations].sort((a, b) => a - b);
    rows.push({
      service: group.service,
      operation: group.operation,
      minute_ts: minuteTs,
      count: sorted.length,
      error_count: group.errorCount,
      p50_ms: nearestRank(sorted, 0.5),
      p95_ms: nearestRank(sorted, 0.95),
      p99_ms: nearestRank(sorted, 0.99),
    });
  }
  return rows;
}

/**
 * Samples at whole-trace granularity: every trace with at least one error span, plus a 10% sample
 * of healthy traces, keeping each trace's spans and logs together. `requests` is returned as-is
 * (same reference) — rollups always reflect 100% of traffic regardless of what gets persisted.
 */
export function sampleForPersistence(batch: GenBatch, rng: Rng): GenBatch {
  const errorTraceIds = new Set<string>();
  const allTraceIds = new Set<string>();
  for (const span of batch.spans) {
    allTraceIds.add(span.trace_id);
    if (span.status === "error") errorTraceIds.add(span.trace_id);
  }

  const keep = new Set<string>(errorTraceIds);
  for (const traceId of allTraceIds) {
    if (errorTraceIds.has(traceId)) continue;
    if (rng() < HEALTHY_TRACE_SAMPLE_RATE) keep.add(traceId);
  }

  return {
    spans: batch.spans.filter((s) => keep.has(s.trace_id)),
    logs: batch.logs.filter((l) => l.trace_id !== undefined && keep.has(l.trace_id)),
    requests: batch.requests,
  };
}
