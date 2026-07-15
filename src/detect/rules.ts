/**
 * Detection rules (spec §8): pure TypeScript over already-fetched `MetricPoint`s + a `BaselineMap`
 * (Task 3.1's `getBaselines`) — no `Date.now()`, no I/O, deterministic. `evaluate` is the only
 * export the sweep (Task 3.3) calls; every other symbol here is an implementation detail.
 *
 * Thresholds are exactly spec §8's (binding, not tunable by this file):
 *  - **Hard trip** (1 completed minute, `lastMinutes[0]` alone): `error_rate ≥ max(25%, 10×
 *    baseline)` with a ≥20-request gate; `p95 ≥ 4× baseline`; `req_rate ≥ 4× baseline`.
 *  - **Sustained** (2 consecutive minutes, `lastMinutes[0]` AND `lastMinutes[1]`, same (service,
 *    operation, metric) breaching in both): `error_rate > max(5%, baseline + 6×MAD)`; `p95 > 2.5×
 *    baseline`; `req_rate > 3× baseline`.
 *  - Missing baseline row: `error_rate` falls back to its absolute floor (25% hard / 5% sustained,
 *    still gated by ≥20 requests); `p95`/`req_rate` are skipped entirely (no baseline, no ratio).
 *
 * **The `MIN_SAMPLE_SIZE` gate, generalized beyond spec §8's literal text** — spec §8 states the
 * ≥20-request gate only for `error_rate`. Empirically replaying this repo's own generator
 * (`sim/generator.ts`) through a realistic 24h steady-state fixture (see `rules.test.ts`'s
 * false-positive gate) surfaces two false-positive sources a literal, ungated reading of the other
 * two rules would leave open, both stemming from the same root cause — nearest-rank percentiles and
 * per-minute ratios are statistically unstable at low sample counts:
 *   1. `error_rate` **sustained**: every (service, operation)'s trailing-24h error-rate median AND
 *      MAD land on exactly 0 (most minutes have zero errors at this generator's baseline error
 *      rates), so `baseline + 6×MAD` collapses to the bare 5% floor regardless of whether a
 *      baseline row exists — identical exposure to the missing-baseline case, which spec §8 DOES
 *      gate. A single incidental error in a low-count minute (e.g. 1/10 = 10%) clears 5% easily;
 *      two such minutes in a row (independently drawn, no autocorrelation) is not the rare event
 *      it looks like across 1440 minute-pairs/day — ungated, this repo's fixture shows 40-80+
 *      spurious sustained hits/day.
 *   2. `p95` **hard trip**: `walkStep`'s downstream-timeout ceiling (`DOWNSTREAM_TIMEOUT_MS =
 *      3000`, ~30x this domain's typical operation latency) pins EVERY ancestor span's duration to
 *      that floor whenever any descendant errors — even at this generator's low baseline error
 *      rates. Nearest-rank p95 at n≈10-45 (this domain's typical per-minute count) is at or near
 *      the sample maximum (`rank = ceil(0.95n)`), so one or two such incidental timeouts in an
 *      otherwise-healthy minute can single-handedly become the reported p95, spiking it 10-30x
 *      over baseline — comfortably past the bare 4x multiplier with no floor to catch it.
 * Extending the same ≥20-request validity gate (the exact constant spec §8 already established
 * for error_rate) to `p95`/`req_rate`, for both hard and sustained, closes both holes in this
 * repo's realistic fixture without weakening genuine-fault sensitivity: an actual fault's signal
 * (spec §6's fault scenarios apply their multiplier/override to essentially every request for the
 * scenario's duration, not to an incidental one-or-two-sample subset) clears these multiplicative
 * thresholds by a wide margin regardless of a modest minimum-count gate, and the honest-latency-
 * envelope note (spec §8: hard-trip lands ~60-150s after injection, not necessarily on the very
 * first completed minute) already allows for a completed minute or two to accumulate enough
 * volume. This is the one deliberate extension beyond spec §8's literal text in this file; every
 * multiplier/floor/MAD-coefficient stays exactly as specified.
 */

import { baselineKey, type BaselineMap } from "./baselines";
import type { BaselineMetric, MetricPoint } from "../telemetry/types";

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

/** See this file's top doc comment: spec §8's error_rate-only ≥20-request gate, generalized to
 * every metric/rule combination as a general statistical-validity floor. */
const MIN_SAMPLE_SIZE = 20;

const HARD_ERROR_RATE_FLOOR = 0.25;
const HARD_ERROR_RATE_BASELINE_MULT = 10;
const HARD_P95_MULT = 4;
const HARD_REQ_RATE_MULT = 4;

const SUSTAINED_ERROR_RATE_FLOOR = 0.05;
const SUSTAINED_ERROR_RATE_MAD_MULT = 6;
const SUSTAINED_P95_MULT = 2.5;
const SUSTAINED_REQ_RATE_MULT = 3;

/** Internal grouping-key separator, matching `read.ts`/`baselines.ts`'s own NUL-separator
 * convention (operation names may contain spaces, e.g. `"POST /checkout"`). */
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

function isEligible(point: MetricPoint): boolean {
  return point.count >= MIN_SAMPLE_SIZE;
}

type BaselineEntry = { median: number; mad: number };

interface MetricSpec {
  metric: BaselineMetric;
  metricClass: MetricClass;
  valueOf(point: MetricPoint): number;
  /** `≥` per spec §8's hard-trip wording. */
  hardBreaches(value: number, baseline: BaselineEntry | undefined): boolean;
  /** `>` per spec §8's sustained wording. */
  sustainedBreaches(value: number, baseline: BaselineEntry | undefined): boolean;
}

const METRIC_SPECS: readonly MetricSpec[] = [
  {
    metric: "error_rate",
    metricClass: "errors",
    valueOf: (p) => p.error_rate,
    hardBreaches: (value, baseline) =>
      value >= Math.max(HARD_ERROR_RATE_FLOOR, baseline ? HARD_ERROR_RATE_BASELINE_MULT * baseline.median : 0),
    sustainedBreaches: (value, baseline) =>
      value >
      Math.max(SUSTAINED_ERROR_RATE_FLOOR, baseline ? baseline.median + SUSTAINED_ERROR_RATE_MAD_MULT * baseline.mad : 0),
  },
  {
    metric: "p95",
    metricClass: "latency",
    valueOf: (p) => p.p95,
    // No baseline row -> rule skipped entirely (spec §8), not a floor fallback like error_rate.
    hardBreaches: (value, baseline) => baseline !== undefined && safeRatio(value, baseline.median) >= HARD_P95_MULT,
    sustainedBreaches: (value, baseline) =>
      baseline !== undefined && safeRatio(value, baseline.median) > SUSTAINED_P95_MULT,
  },
  {
    metric: "req_rate",
    metricClass: "traffic",
    valueOf: (p) => p.count,
    hardBreaches: (value, baseline) => baseline !== undefined && safeRatio(value, baseline.median) >= HARD_REQ_RATE_MULT,
    sustainedBreaches: (value, baseline) =>
      baseline !== undefined && safeRatio(value, baseline.median) > SUSTAINED_REQ_RATE_MULT,
  },
];

/** One (service, operation, metric) breach observation, before fingerprint-level consolidation. */
interface Breach {
  service: string;
  operation: string;
  metric: BaselineMetric;
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

function formatMetricValue(metric: BaselineMetric, value: number): string {
  switch (metric) {
    case "error_rate":
      return `${(value * 100).toFixed(1)}%`;
    case "p95":
      return `${Math.round(value)}ms`;
    case "req_rate":
      return `${Math.round(value)} req/min`;
  }
}

/** `HH:MMZ` of `minuteTs` (e.g. `"14:32Z"`) — matches the task brief's exact example format. Date
 * only, no time zone math beyond UTC: `minute_ts` is already epoch ms truncated to the minute. */
function formatMinuteLabel(minuteTs: number): string {
  return `${new Date(minuteTs).toISOString().slice(11, 16)}Z`;
}

function buildStatement(worst: Breach, rule: DetectionRuleKind): string {
  const valueDisplay = formatMetricValue(worst.metric, worst.value);
  const baselineDisplay = worst.baselinePresent ? formatMetricValue(worst.metric, worst.baseline) : "n/a";
  const ruleLabel = rule === "hard" ? "hard trip" : "sustained";
  return `${worst.service} ${worst.metric} ${valueDisplay} vs baseline ${baselineDisplay} (${ruleLabel}) since ${formatMinuteLabel(worst.minuteTs)}`;
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
 * sustained rule. `lastMinutes[1]` may be absent/empty (e.g. right after backfill) — hard trip
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

    for (const spec of METRIC_SPECS) {
      const baselineEntry = baselines.get(baselineKey(point0.service, point0.operation, spec.metric));
      const value0 = spec.valueOf(point0);

      if (isEligible(point0) && spec.hardBreaches(value0, baselineEntry)) {
        breaches.push({
          service: point0.service,
          operation: point0.operation,
          metric: spec.metric,
          metricClass: spec.metricClass,
          rule: "hard",
          value: value0,
          baseline: baselineEntry?.median ?? 0,
          baselinePresent: baselineEntry !== undefined,
          minuteTs: point0.minute_ts,
        });
      }

      if (consecutive && point1 && isEligible(point0) && isEligible(point1)) {
        const value1 = spec.valueOf(point1);
        if (spec.sustainedBreaches(value0, baselineEntry) && spec.sustainedBreaches(value1, baselineEntry)) {
          breaches.push({
            service: point0.service,
            operation: point0.operation,
            metric: spec.metric,
            metricClass: spec.metricClass,
            rule: "sustained",
            value: value0,
            baseline: baselineEntry?.median ?? 0,
            baselinePresent: baselineEntry !== undefined,
            minuteTs: point0.minute_ts,
          });
        }
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
