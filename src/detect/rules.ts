/**
 * Detection rules (spec §8 v2.1): pure TypeScript over already-fetched `MetricPoint`s + a
 * `BaselineMap` (`getBaselines`) — no `Date.now()`, no I/O, deterministic. `evaluate` is the only
 * export the sweep (Task 3.3) calls; every other symbol here is an implementation detail.
 *
 * Every rule pairs a ratio threshold with an EVIDENCE gate (spec §8 v2.1) — absolute error counts
 * for error rules, a p50 distribution-shift confirmation for latency rules — because at this
 * world's per-operation volumes (~10-15 req/min on the checkout path) small-sample noise otherwise
 * produces hundreds of spurious p95 trips/day, while naive request-count gates (>= 20 req/min)
 * structurally disable detection on exactly the operations the fault scenarios hit. Both failure
 * modes were measured empirically (v2 literal: ~437 p95 FP/day; uniform >=20 gate: 15-31% scenario
 * detection); the v2.1 gates below are the ratified fix, validated in both directions by
 * `rules.test.ts`'s multi-day false-positive bound and scenario-detection tests.
 *
 * The complete rule table — each line is `ratio threshold` AND `evidence gate(s)`, both required:
 *
 *  **Hard trip** (1 completed minute, `lastMinutes[0]` alone):
 *   - errors:  `error_rate >= max(25%, 10 x baseline.median)`  AND  `error_count >= 3`
 *   - latency: `p95 >= 4 x p95-baseline.median`  AND  `p50 >= 2 x p50-baseline.median`
 *              AND  `count >= 5`
 *   - traffic: `count >= 4 x req_rate-baseline.median`  AND  `count >= 20`
 *
 *  **Sustained** (2 consecutive minutes; every condition below must hold in EACH of
 *  `lastMinutes[0]` and `lastMinutes[1]` for the same (service, operation)):
 *   - errors:  `error_rate > max(5%, baseline.median + 6 x baseline.mad)`  AND
 *              `error_count >= 3` (in each minute)
 *   - latency: `p95 > 2.5 x p95-baseline.median`  AND  `p50 >= 2 x p50-baseline.median`
 *              AND  `count >= 5` (each, in each minute)
 *   - traffic: `count > 3 x req_rate-baseline.median`  AND  `count >= 10` (in each minute)
 *
 *  **Missing baseline rows**:
 *   - errors:  falls back to the absolute floors alone (25% hard / 5% sustained) — the
 *     error-count gates still apply.
 *   - latency: requires BOTH the `p95` and `p50` baseline rows; skipped if either is missing.
 *   - traffic: requires the `req_rate` baseline row; skipped without it.
 *
 * Why each gate is shaped the way it is:
 *   - The error-count gates (>= 3 per breaching minute, both rules) demand absolute evidence a
 *     human would accept — "1 error out of 10 requests" is a 10% error rate but zero evidence of
 *     an incident; three simultaneous errors at a >= 25% rate is not noise at any volume this
 *     world produces.
 *   - The p50 confirmation is the outlier-killer: a single 3s downstream-timeout span (the
 *     generator's `DOWNSTREAM_TIMEOUT_MS` ceiling on ancestor spans of any incidental error)
 *     lands at/near the nearest-rank p95 of a 10-40-sample minute and lifts it 10-30x, but leaves
 *     the median untouched; a real x2.5+ latency regression (fault scenarios multiply every
 *     request's duration) lifts both. `count >= 5` merely keeps a 2-3-sample minute from defining
 *     either percentile.
 *   - The traffic floors (>= 20 hard / >= 10-per-minute sustained) are safe volume gates for this
 *     one metric because a real traffic spike is high count BY DEFINITION — a "4x spike" onto
 *     fewer than 20 requests/min is not an event worth an investigation.
 *
 * Two gates are TIGHTER than spec §8 v2.1's published values, forced by the multi-day
 * false-positive bound (the ratified escalation path: tighten via evidence gates, never via
 * traffic-volume gates) and validated to cost zero scenario-detection trials:
 *   - p50 confirmation is 2x, not 1.5x: `notifications.send_email`'s external-provider call has
 *     sigma 0.5, so its per-minute sample p50 naturally crosses 1.5x baseline several times a day;
 *     whenever that coincides with one incidental timeout minute, 1.5x leaks a hard trip
 *     (observed ratios 1.50-1.59, ~1.6 FP/day). Every fault path lifts p50 by >= 2.3x, so 2x
 *     keeps full margin on detection (40/40 trials, unchanged latency distribution).
 *   - Sustained error evidence is >= 3 errors per minute, not >= 2: one payments-db baseline error
 *     propagates to checkout AND gateway in the same request (`walkStep`'s downstream
 *     propagation), so "2 errors/minute, twice in a row" occurs ~1-2x/day from ~1.3% compound
 *     baseline error rates at ~20 req/min (observed: exactly-2-error pairs on checkout/gateway).
 *     Three propagated errors per minute for two consecutive minutes does not occur at baseline
 *     rates in any tested window; all four scenarios clear >= 3 with wide margin.
 */

import { baselineKey, type BaselineMap } from "./baselines";
import type { MetricPoint } from "../telemetry/types";

export type MetricClass = "errors" | "latency" | "traffic";
export type DetectionRuleKind = "hard" | "sustained";

/** The binding output shape (Task 3.3 consumes this array directly). */
export interface Anomaly {
  fingerprint: string;
  service: string;
  metricClass: MetricClass;
  rule: DetectionRuleKind;
  value: number;
  baseline: number;
  statement: string;
}

const MINUTE_MS = 60_000;

// --- Spec §8 v2.1 thresholds and evidence gates (see the rule table in the top doc comment) ----

const HARD_ERROR_RATE_FLOOR = 0.25;
const HARD_ERROR_RATE_BASELINE_MULT = 10;
const HARD_ERROR_MIN_ERRORS = 3;
const HARD_P95_MULT = 4;
const HARD_REQ_RATE_MULT = 4;
const HARD_REQ_RATE_MIN_COUNT = 20;

const SUSTAINED_ERROR_RATE_FLOOR = 0.05;
const SUSTAINED_ERROR_RATE_MAD_MULT = 6;
/** Tighter than v2.1's published >= 2 — see the "Two gates are TIGHTER" note in the top doc
 * comment (correlated cascade errors make exactly-2-error minute pairs a ~daily event). */
const SUSTAINED_ERROR_MIN_ERRORS = 3;
const SUSTAINED_P95_MULT = 2.5;
const SUSTAINED_REQ_RATE_MULT = 3;
const SUSTAINED_REQ_RATE_MIN_COUNT = 10;

/** Shared by hard and sustained latency rules: the p50 distribution-shift confirmation ratio and
 * the minimum sample count for either percentile to be meaningful at all. The 2x confirm is
 * tighter than v2.1's published 1.5x — see the "Two gates are TIGHTER" note in the top doc
 * comment (high-sigma operations naturally cross 1.5x several times a day). */
const LATENCY_P50_CONFIRM_MULT = 2;
const LATENCY_MIN_COUNT = 5;

/** Internal (service, operation) grouping-key separator, matching `read.ts`/`baselines.ts`'s own
 * NUL-separator convention (operation names may contain spaces, e.g. `"POST /checkout"`, which
 * would make a space-separated key ambiguous). */
const KEY_SEP = "\u0000";

function pointKey(point: Pick<MetricPoint, "service" | "operation">): string {
  return `${point.service}${KEY_SEP}${point.operation}`;
}

/** `value / median`, never `NaN`/division-by-zero — mirrors `read.ts`'s private `safeRatio`
 * exactly (a zero baseline with a still-zero observed value is "no deviation"; a zero baseline
 * with any nonzero observed value is an unbounded spike, `Infinity`, still a valid comparable
 * `number`). Reimplemented locally rather than imported since `read.ts` doesn't export it and this
 * is a 3-line pure function, not worth a cross-module coupling. */
function safeRatio(value: number, median: number): number {
  if (median === 0) return value === 0 ? 0 : Infinity;
  return value / median;
}

/** Absolute error count for a minute's point, recovered from the rate: `MetricPoint` carries
 * `error_rate` (= error_count / count, exact at stepMin 1 — see `queryMetrics`), so the round-trip
 * back to a count is exact up to float noise, which `Math.round` absorbs. */
function errorCountOf(point: Pick<MetricPoint, "count" | "error_rate">): number {
  return Math.round(point.error_rate * point.count);
}

type BaselineEntry = { median: number; mad: number };

/** All baseline rows for one (service, operation), resolved once per point. Any field may be
 * absent (fresh world, brand-new operation) — each rule's missing-baseline behavior is spelled
 * out in the top doc comment. */
interface OpBaselines {
  req_rate?: BaselineEntry;
  error_rate?: BaselineEntry;
  p95?: BaselineEntry;
  p50?: BaselineEntry;
}

function opBaselinesFor(baselines: BaselineMap, service: string, operation: string): OpBaselines {
  return {
    req_rate: baselines.get(baselineKey(service, operation, "req_rate")),
    error_rate: baselines.get(baselineKey(service, operation, "error_rate")),
    p95: baselines.get(baselineKey(service, operation, "p95")),
    p50: baselines.get(baselineKey(service, operation, "p50")),
  };
}

interface MetricSpec {
  metricClass: MetricClass;
  /** The metric's reported value on an `Anomaly` (`error_rate` / `p95` / `count`). */
  valueOf(point: MetricPoint): number;
  /** The baseline the anomaly is reported against (undefined => rendered as "n/a"). */
  reportedBaseline(b: OpBaselines): BaselineEntry | undefined;
  /** Full hard-trip check for one minute: ratio threshold AND evidence gate(s). */
  hardBreaches(point: MetricPoint, b: OpBaselines): boolean;
  /** Full per-minute sustained check (ratio AND gates); `evaluate` requires it to pass in BOTH
   * consecutive minutes before recording a sustained breach. */
  sustainedBreaches(point: MetricPoint, b: OpBaselines): boolean;
}

/** Latency evidence gate shared by hard and sustained: p50 distribution-shift confirmation plus
 * the minimum-sample floor. Requires the p50 baseline row (callers check it alongside p95's). */
function p50Confirms(point: MetricPoint, p50Baseline: BaselineEntry): boolean {
  return point.count >= LATENCY_MIN_COUNT && safeRatio(point.p50, p50Baseline.median) >= LATENCY_P50_CONFIRM_MULT;
}

const METRIC_SPECS: readonly MetricSpec[] = [
  {
    metricClass: "errors",
    valueOf: (p) => p.error_rate,
    reportedBaseline: (b) => b.error_rate,
    // Missing baseline row => the absolute 25% floor alone (the 10x term contributes nothing);
    // the >= 3-error evidence gate applies either way.
    hardBreaches: (point, b) =>
      errorCountOf(point) >= HARD_ERROR_MIN_ERRORS &&
      point.error_rate >=
        Math.max(HARD_ERROR_RATE_FLOOR, b.error_rate ? HARD_ERROR_RATE_BASELINE_MULT * b.error_rate.median : 0),
    // Missing baseline row => the absolute 5% floor alone; >= 2 errors required in each minute.
    sustainedBreaches: (point, b) =>
      errorCountOf(point) >= SUSTAINED_ERROR_MIN_ERRORS &&
      point.error_rate >
        Math.max(
          SUSTAINED_ERROR_RATE_FLOOR,
          b.error_rate ? b.error_rate.median + SUSTAINED_ERROR_RATE_MAD_MULT * b.error_rate.mad : 0,
        ),
  },
  {
    metricClass: "latency",
    valueOf: (p) => p.p95,
    reportedBaseline: (b) => b.p95,
    // Needs BOTH p95 and p50 baseline rows (spec §8 v2.1) — skipped entirely if either is missing.
    hardBreaches: (point, b) =>
      b.p95 !== undefined &&
      b.p50 !== undefined &&
      p50Confirms(point, b.p50) &&
      safeRatio(point.p95, b.p95.median) >= HARD_P95_MULT,
    sustainedBreaches: (point, b) =>
      b.p95 !== undefined &&
      b.p50 !== undefined &&
      p50Confirms(point, b.p50) &&
      safeRatio(point.p95, b.p95.median) > SUSTAINED_P95_MULT,
  },
  {
    metricClass: "traffic",
    valueOf: (p) => p.count,
    reportedBaseline: (b) => b.req_rate,
    // Needs the req_rate baseline row — skipped without it.
    hardBreaches: (point, b) =>
      b.req_rate !== undefined &&
      point.count >= HARD_REQ_RATE_MIN_COUNT &&
      safeRatio(point.count, b.req_rate.median) >= HARD_REQ_RATE_MULT,
    sustainedBreaches: (point, b) =>
      b.req_rate !== undefined &&
      point.count >= SUSTAINED_REQ_RATE_MIN_COUNT &&
      safeRatio(point.count, b.req_rate.median) > SUSTAINED_REQ_RATE_MULT,
  },
];

/** One (service, operation, metricClass) breach observation, before fingerprint consolidation. */
interface Breach {
  service: string;
  operation: string;
  metricClass: MetricClass;
  rule: DetectionRuleKind;
  value: number;
  baseline: number;
  /** Whether a real baseline row backed `baseline` (vs. the missing-baseline floor fallback, where
   * `baseline` is reported as 0) — used only to render `statement`'s "vs baseline ..." clause
   * honestly, never surfaced on the `Anomaly` itself. */
  baselinePresent: boolean;
  minuteTs: number;
}

/** Severity ordering for "worst-breaching operation" consolidation: how many multiples of its own
 * baseline a breach represents (mirrors `safeRatio`'s zero-baseline convention, so a
 * missing-baseline error-rate floor breach — `baseline` reported as 0 — sorts as maximally severe,
 * consistent with "no historical baseline at all" being at least as notable as any measured one). */
function severityOf(breach: Pick<Breach, "value" | "baseline">): number {
  return safeRatio(breach.value, breach.baseline);
}

function pickWorst(pool: readonly Breach[]): Breach {
  return pool.reduce((worst, candidate) => {
    const worstSeverity = severityOf(worst);
    const candidateSeverity = severityOf(candidate);
    if (candidateSeverity !== worstSeverity) return candidateSeverity > worstSeverity ? candidate : worst;
    if (candidate.value !== worst.value) return candidate.value > worst.value ? candidate : worst;
    // Final, deterministic tie-break so output never depends on input array order.
    return candidate.operation < worst.operation ? candidate : worst;
  });
}

/** Human-facing display name per metric class, matching the task brief's statement example
 * ("checkout error_rate 22.4% vs baseline 0.4% ..."). */
function metricLabel(metricClass: MetricClass): string {
  switch (metricClass) {
    case "errors":
      return "error_rate";
    case "latency":
      return "p95";
    case "traffic":
      return "req_rate";
  }
}

function formatMetricValue(metricClass: MetricClass, value: number): string {
  switch (metricClass) {
    case "errors":
      return `${(value * 100).toFixed(1)}%`;
    case "latency":
      return `${Math.round(value)}ms`;
    case "traffic":
      return `${Math.round(value)} req/min`;
  }
}

/** `HH:MMZ` of `minuteTs` (e.g. `"14:32Z"`) — matches the task brief's exact example format.
 * `minute_ts` is already epoch ms truncated to the minute, so slicing the ISO string suffices. */
function formatMinuteLabel(minuteTs: number): string {
  return `${new Date(minuteTs).toISOString().slice(11, 16)}Z`;
}

function buildStatement(worst: Breach, rule: DetectionRuleKind): string {
  const label = metricLabel(worst.metricClass);
  const valueDisplay = formatMetricValue(worst.metricClass, worst.value);
  const baselineDisplay = worst.baselinePresent ? formatMetricValue(worst.metricClass, worst.baseline) : "n/a";
  const ruleLabel = rule === "hard" ? "hard trip" : "sustained";
  return `${worst.service} ${label} ${valueDisplay} vs baseline ${baselineDisplay} (${ruleLabel}) since ${formatMinuteLabel(worst.minuteTs)}`;
}

/**
 * Evaluates the two most recent completed minutes against `baselines` and returns one `Anomaly`
 * per (service, metricClass) fingerprint that breached — never more than one per fingerprint, even
 * if several operations of that service breach the same metric class or an operation breaches both
 * the hard and sustained rule simultaneously (hard wins; the worst-breaching operation, by ratio to
 * its own baseline, supplies `value`/`baseline`/`statement`).
 *
 * `lastMinutes[0]` = the most recent completed minute's points (every (service, operation) with
 * traffic that minute); `lastMinutes[1]` = the minute immediately before it, used only for the
 * sustained rules. `lastMinutes[1]` may be absent/empty (e.g. right after backfill) — hard trip
 * still evaluates fully; sustained simply never fires without it.
 */
export function evaluate(lastMinutes: MetricPoint[][], baselines: BaselineMap): Anomaly[] {
  const minute0 = lastMinutes[0] ?? [];
  const minute1 = lastMinutes[1] ?? [];
  const minute1ByKey = new Map(minute1.map((p) => [pointKey(p), p] as const));

  const breaches: Breach[] = [];

  for (const point0 of minute0) {
    const point1 = minute1ByKey.get(pointKey(point0));
    // Guards against a caller-supplied lastMinutes[1] that isn't actually the immediately
    // preceding minute (e.g. a gap) — sustained only ever compares truly adjacent minutes.
    const consecutive = point1 !== undefined && point1.minute_ts === point0.minute_ts - MINUTE_MS;
    const opBaselines = opBaselinesFor(baselines, point0.service, point0.operation);

    for (const spec of METRIC_SPECS) {
      const reported = spec.reportedBaseline(opBaselines);
      const push = (rule: DetectionRuleKind): void => {
        breaches.push({
          service: point0.service,
          operation: point0.operation,
          metricClass: spec.metricClass,
          rule,
          value: spec.valueOf(point0),
          baseline: reported?.median ?? 0,
          baselinePresent: reported !== undefined,
          minuteTs: point0.minute_ts,
        });
      };

      if (spec.hardBreaches(point0, opBaselines)) push("hard");

      if (
        consecutive &&
        point1 &&
        spec.sustainedBreaches(point0, opBaselines) &&
        spec.sustainedBreaches(point1, opBaselines)
      ) {
        push("sustained");
      }
    }
  }

  const byFingerprint = new Map<string, Breach[]>();
  for (const breach of breaches) {
    const fingerprint = `${breach.service}:${breach.metricClass}`;
    const group = byFingerprint.get(fingerprint);
    if (group) group.push(breach);
    else byFingerprint.set(fingerprint, [breach]);
  }

  const anomalies: Anomaly[] = [];
  for (const [fingerprint, group] of byFingerprint) {
    const hardOnes = group.filter((b) => b.rule === "hard");
    const rule: DetectionRuleKind = hardOnes.length > 0 ? "hard" : "sustained";
    const worst = pickWorst(hardOnes.length > 0 ? hardOnes : group);
    anomalies.push({
      fingerprint,
      service: worst.service,
      metricClass: worst.metricClass,
      rule,
      value: worst.value,
      baseline: worst.baseline,
      statement: buildStatement(worst, rule),
    });
  }

  return anomalies.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}
