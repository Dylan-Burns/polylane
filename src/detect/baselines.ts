/**
 * Baselines: median + MAD per (service, operation, metric ∈ {req_rate, error_rate, p95}) over the
 * trailing 24h of `rollups` (spec §8). Pure statistics over already-persisted rollups — no LLM
 * cost, deterministic, unit-testable in isolation. Deliberately no hour-of-day adjustment (spec
 * §8: "the diurnal curve is mild; multiplicative thresholds absorb it").
 *
 * Two entry points, both consumed by later tasks:
 *  - `computeBaselines(db, nowMs)` — recomputed every 15 min by the sweep (Task 3.3) and
 *    synchronously at the end of backfill (`SimulatorDO.recomputeBaselines`, wired in this task).
 *    `REPLACE INTO baselines` on the table's natural key `(service, operation, metric)`, so a
 *    recompute is idempotent: no dupes, stale rows for keys no longer present in the trailing
 *    window simply age out of relevance (never explicitly deleted — a stale baseline just isn't
 *    refreshed, which is fine since detection rules key off `getBaselines`' current snapshot).
 *  - `getBaselines(db)` — loads the whole table into a `BaselineMap` for the detection rules
 *    (Task 3.2) to consult per-minute without a per-rule D1 round trip. `baselineKey` is exported
 *    so 3.2's rule evaluator builds the exact same map key as this file writes.
 */

import type { BaselineMetric } from "../telemetry/types";

/** Trailing window baselines are computed over — exactly `backfill.ts`'s `BACKFILL_TOTAL_MS`, so a
 * freshly-seeded world's synchronous post-backfill recompute sees the full history it just wrote. */
const TRAILING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** D1 caps bound params per statement at 100; chunk to 90 to leave headroom (matches `queries.ts`'s
 * write-budget convention). 6 columns/row -> 15 rows/statement. */
const MAX_BOUND_PARAMS = 90;

export type BaselineMap = Map<string, { median: number; mad: number }>;

/** The single key-builder both this file (write side) and Task 3.2's rule evaluator (read side)
 * use for `BaselineMap`, so a typo in one can never silently desync from the other. */
export function baselineKey(service: string, operation: string, metric: BaselineMetric): string {
  return `${service}:${operation}:${metric}`;
}

/** Standard median: the middle element for odd `n`, the mean of the two middle elements for even
 * `n`. `values` is never mutated (sorted on a copy). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Raw MAD (median of absolute deviations from `med`) — deliberately NOT scaled by the usual
 * 1.4826 consistency constant: spec §8's sustained-rule threshold (`baseline + 6×MAD`) was written
 * against raw MAD, so scaling here would silently change every downstream threshold. */
function medianAbsoluteDeviation(values: readonly number[], med: number): number {
  return median(values.map((v) => Math.abs(v - med)));
}

interface RollupAggRow {
  service: string;
  operation: string;
  count: number;
  error_count: number;
  p95_ms: number;
}

interface Group {
  reqRates: number[];
  errorRates: number[];
  p95s: number[];
}

interface BaselineRow {
  service: string;
  operation: string;
  metric: BaselineMetric;
  median: number;
  mad: number;
}

/** Internal grouping-key separator for the `service`+`operation` map below — a NUL character
 * (never legitimately present in either field), matching `read.ts`'s own bucket-key convention.
 * Operation names routinely contain spaces (e.g. `"POST /checkout"`), so a plain space separator
 * would be ambiguous to split back apart; NUL is not. */
const GROUP_KEY_SEP = "\u0000";

const BASELINE_COLUMNS = ["service", "operation", "metric", "median", "mad", "computed_at"] as const;

/** Chunks `rows` into `REPLACE INTO baselines` statements (<=90 bound params each) and issues them
 * as a single `db.batch()` call — mirrors `queries.ts`'s `batchInsert` chunking convention, but
 * REPLACE (not INSERT) since the whole point is upserting on the table's `(service, operation,
 * metric)` primary key. */
async function replaceBaselines(db: D1Database, rows: readonly BaselineRow[], nowMs: number): Promise<void> {
  if (rows.length === 0) return;
  const rowsPerStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / BASELINE_COLUMNS.length));
  const rowPlaceholder = `(${BASELINE_COLUMNS.map(() => "?").join(", ")})`;

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    const chunk = rows.slice(i, i + rowsPerStatement);
    const sql = `REPLACE INTO baselines (${BASELINE_COLUMNS.join(", ")}) VALUES ${chunk
      .map(() => rowPlaceholder)
      .join(", ")}`;
    const params = chunk.flatMap((row) => [row.service, row.operation, row.metric, row.median, row.mad, nowMs]);
    statements.push(db.prepare(sql).bind(...params));
  }
  await db.batch(statements);
}

/**
 * Recomputes every (service, operation, metric) baseline from the trailing 24h of `rollups`
 * (`[nowMs - 24h, nowMs)`, half-open — matches every other window in this codebase) and `REPLACE
 * INTO baselines`s the results. Returns the number of rows written (0 if the window has no rollups
 * at all — never throws on an empty world).
 *
 * Per (service, operation) group:
 *  - `req_rate`: one data point per rollup minute (`count`), zero-traffic minutes included as a
 *    literal 0 — always written when the group has any rollup rows.
 *  - `p95`: one data point per rollup minute (`p95_ms`) — always written alongside `req_rate`
 *    (same rollup rows back both).
 *  - `error_rate`: one data point per minute (`error_count / count`), but minutes with `count = 0`
 *    are EXCLUDED (an undefined ratio, not a 0) — so if every minute in the window had zero
 *    traffic, no `error_rate` row is written for that group at all (nothing to baseline).
 */
export async function computeBaselines(db: D1Database, nowMs: number): Promise<number> {
  const fromMs = nowMs - TRAILING_WINDOW_MS;
  const { results } = await db
    .prepare("SELECT service, operation, count, error_count, p95_ms FROM rollups WHERE minute_ts >= ? AND minute_ts < ?")
    .bind(fromMs, nowMs)
    .all<RollupAggRow>();

  const groups = new Map<string, Group>();
  for (const row of results ?? []) {
    const key = `${row.service}${GROUP_KEY_SEP}${row.operation}`;
    let group = groups.get(key);
    if (!group) {
      group = { reqRates: [], errorRates: [], p95s: [] };
      groups.set(key, group);
    }
    group.reqRates.push(row.count);
    group.p95s.push(row.p95_ms);
    if (row.count > 0) group.errorRates.push(row.error_count / row.count);
  }

  const rows: BaselineRow[] = [];
  for (const [key, group] of groups) {
    const sepIdx = key.indexOf(GROUP_KEY_SEP);
    const service = key.slice(0, sepIdx);
    const operation = key.slice(sepIdx + 1);

    const reqMedian = median(group.reqRates);
    rows.push({ service, operation, metric: "req_rate", median: reqMedian, mad: medianAbsoluteDeviation(group.reqRates, reqMedian) });

    const p95Median = median(group.p95s);
    rows.push({ service, operation, metric: "p95", median: p95Median, mad: medianAbsoluteDeviation(group.p95s, p95Median) });

    if (group.errorRates.length > 0) {
      const errorMedian = median(group.errorRates);
      rows.push({
        service,
        operation,
        metric: "error_rate",
        median: errorMedian,
        mad: medianAbsoluteDeviation(group.errorRates, errorMedian),
      });
    }
  }

  await replaceBaselines(db, rows, nowMs);
  return rows.length;
}

interface BaselineRowDb {
  service: string;
  operation: string;
  metric: BaselineMetric;
  median: number;
  mad: number;
}

/** Loads the entire `baselines` table into a `BaselineMap` keyed by `baselineKey(service,
 * operation, metric)`, for the detection rules (Task 3.2) to consult per-minute without a D1 round
 * trip per rule. Empty table -> empty map (never throws). */
export async function getBaselines(db: D1Database): Promise<BaselineMap> {
  const { results } = await db.prepare("SELECT service, operation, metric, median, mad FROM baselines").all<BaselineRowDb>();
  const map: BaselineMap = new Map();
  for (const row of results ?? []) {
    map.set(baselineKey(row.service, row.operation, row.metric), { median: row.median, mad: row.mad });
  }
  return map;
}
