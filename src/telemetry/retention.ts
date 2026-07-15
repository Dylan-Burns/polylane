/**
 * Retention: chunked deletes of aged-out telemetry, run every sweep tick (spec §6: "raw spans/logs
 * 6h; rollups 72h; incidents/investigations kept indefinitely" — this file only ever touches
 * `spans`/`logs`/`rollups`). `spans`/`logs`/`rollups` deliberately carry no declared PK beyond
 * SQLite's implicit `rowid` (migration 0001's write-budget note), which doubles as the handle a
 * bounded "delete the oldest N rows" query needs.
 *
 * **Bounded per run**: `maxRows` (default 5000) caps the *total* rows deleted across all three
 * tables in one `sweepRetention` call — never a single unbounded `DELETE ... WHERE ts < cutoff`,
 * which could stall a cron tick against a large backlog (e.g. after retention was silently broken
 * for a while). Each table gets whatever budget is left when its turn comes, in a fixed order
 * (spans, logs, rollups).
 *
 * **Watermark** (`meta.retention_watermark_ms`): one JSON object `{spans, logs, rollups}`, each
 * value the cutoff a table was *confirmed fully cleared* to as of the end of the last run (i.e. the
 * table's own delete finished under budget, not because it hit `maxRows` mid-backlog). Used purely
 * as a fast-skip: if this run's cutoff for a table hasn't moved past its recorded watermark, that
 * table is skipped without issuing a `DELETE` at all. This is a monitoring/introspection aid more
 * than a performance one — a row that's already been deleted no longer exists for a later scan to
 * re-examine regardless of the watermark, so correctness never depends on it; the real bound on
 * per-run work is `maxRows` alone.
 */

const SPANS_LOGS_RETENTION_MS = 6 * 60 * 60 * 1000;
const ROLLUPS_RETENTION_MS = 72 * 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 5000;
const WATERMARK_KEY = "retention_watermark_ms";

interface Watermarks {
  spans: number;
  logs: number;
  rollups: number;
}

const EPOCH_WATERMARKS: Watermarks = { spans: 0, logs: 0, rollups: 0 };

async function loadWatermarks(db: D1Database): Promise<Watermarks> {
  const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(WATERMARK_KEY).first<{ value: string }>();
  if (!row) return { ...EPOCH_WATERMARKS };
  try {
    const parsed = JSON.parse(row.value) as Partial<Watermarks>;
    return {
      spans: parsed.spans ?? 0,
      logs: parsed.logs ?? 0,
      rollups: parsed.rollups ?? 0,
    };
  } catch (err) {
    // Fail safe, re-scan from epoch -- logged so a corrupt watermark (which silently forces a
    // full re-scan every run forever) isn't invisible to whoever's watching logs.
    console.error("retention: retention_watermark_ms meta value is corrupt; resetting to epoch", err);
    return { ...EPOCH_WATERMARKS };
  }
}

async function saveWatermarks(db: D1Database, watermarks: Watermarks): Promise<void> {
  await db.prepare(`REPLACE INTO meta (key, value) VALUES (?, ?)`).bind(WATERMARK_KEY, JSON.stringify(watermarks)).run();
}

interface RetentionTarget {
  key: keyof Watermarks;
  table: "spans" | "logs" | "rollups";
  column: "start_ms" | "ts_ms" | "minute_ts";
  retentionMs: number;
}

const TARGETS: readonly RetentionTarget[] = [
  { key: "spans", table: "spans", column: "start_ms", retentionMs: SPANS_LOGS_RETENTION_MS },
  { key: "logs", table: "logs", column: "ts_ms", retentionMs: SPANS_LOGS_RETENTION_MS },
  { key: "rollups", table: "rollups", column: "minute_ts", retentionMs: ROLLUPS_RETENTION_MS },
];

/** Deletes up to `limit` of the oldest rows in `table` with `column < cutoff`, via a `rowid`
 * subquery (the only bounded-delete handle available on a table with no declared PK — see the file
 * doc comment). Returns the number of rows actually deleted (`<= limit`). `table`/`column` are
 * always one of this file's own `TARGETS` entries, never caller input. */
async function deleteOldest(db: D1Database, table: string, column: string, cutoff: number, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const res = await db
    .prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? ORDER BY ${column} ASC LIMIT ?)`,
    )
    .bind(cutoff, limit)
    .run();
  return res.meta.changes ?? 0;
}

export interface SweepRetentionOptions {
  maxRows?: number;
}

/**
 * Runs one bounded retention pass: for each of `spans`/`logs`/`rollups`, deletes rows older than
 * that table's cutoff (`nowMs - retentionMs`), oldest first, up to whatever's left of the shared
 * `maxRows` budget (default 5000) — see the file doc comment for the exact per-table order and the
 * watermark's role. Returns the total rows deleted across all three tables (never throws on an
 * empty/already-clean world — 0 deleted is a normal outcome).
 */
export async function sweepRetention(db: D1Database, nowMs: number, opts: SweepRetentionOptions = {}): Promise<number> {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const watermarks = await loadWatermarks(db);
  const nextWatermarks: Watermarks = { ...watermarks };

  let remaining = maxRows;
  let totalDeleted = 0;

  for (const target of TARGETS) {
    if (remaining <= 0) break;
    const cutoff = nowMs - target.retentionMs;
    if (watermarks[target.key] >= cutoff) continue; // already confirmed clear up to (at least) this cutoff

    const limit = remaining;
    const deleted = await deleteOldest(db, target.table, target.column, cutoff, limit);
    totalDeleted += deleted;
    remaining -= deleted;

    // Only advance this table's watermark when the delete wasn't budget-capped -- i.e. we know
    // nothing older than `cutoff` remains. A budget-capped delete may have left older rows behind,
    // so the watermark must not jump past what's actually confirmed cleared.
    if (deleted < limit) {
      nextWatermarks[target.key] = cutoff;
    }
  }

  await saveWatermarks(db, nextWatermarks);
  return totalDeleted;
}
