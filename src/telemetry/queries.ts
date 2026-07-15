import type { Deploy, LogLine, RollupRow, Span } from "./types";

/**
 * D1 caps bound params per statement at 100; we chunk to 90 to leave
 * headroom (Global Constraints / spec §6 write-budget note).
 */
const MAX_BOUND_PARAMS = 90;

/** Splits `rows` into chunks that each bind at most `MAX_BOUND_PARAMS` params. */
function chunkRows<T>(rows: readonly T[], columnsPerRow: number): T[][] {
  const rowsPerStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columnsPerRow));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    chunks.push(rows.slice(i, i + rowsPerStatement));
  }
  return chunks;
}

/** Builds one multi-row `INSERT INTO table (...) VALUES (...), (...), ...` prepared statement. */
function buildInsertStatement(
  db: D1Database,
  table: string,
  columns: readonly string[],
  valueRows: readonly (readonly unknown[])[],
): D1PreparedStatement {
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valueRows
    .map(() => rowPlaceholder)
    .join(", ")}`;
  const params = valueRows.flat();
  return db.prepare(sql).bind(...params);
}

/** Chunks `rows` and issues a single `db.batch()` call of insert statements, one per chunk. */
async function batchInsert<T>(
  db: D1Database,
  table: string,
  columns: readonly string[],
  rows: readonly T[],
  toValues: (row: T) => readonly unknown[],
): Promise<void> {
  if (rows.length === 0) return;
  const chunks = chunkRows(rows, columns.length);
  const statements = chunks.map((chunk) =>
    buildInsertStatement(
      db,
      table,
      columns,
      chunk.map((row) => toValues(row)),
    ),
  );
  await db.batch(statements);
}

const SPAN_COLUMNS = [
  "trace_id",
  "span_id",
  "parent_span_id",
  "service",
  "operation",
  "start_ms",
  "duration_ms",
  "status",
  "error_type",
] as const;

export async function insertSpans(db: D1Database, rows: readonly Span[]): Promise<void> {
  await batchInsert(db, "spans", SPAN_COLUMNS, rows, (row) => [
    row.trace_id,
    row.span_id,
    row.parent_span_id,
    row.service,
    row.operation,
    row.start_ms,
    row.duration_ms,
    row.status,
    row.error_type,
  ]);
}

const LOG_COLUMNS = ["ts_ms", "service", "level", "message", "trace_id", "span_id"] as const;

export async function insertLogs(db: D1Database, rows: readonly LogLine[]): Promise<void> {
  await batchInsert(db, "logs", LOG_COLUMNS, rows, (row) => [
    row.ts_ms,
    row.service,
    row.level,
    row.message,
    row.trace_id ?? null,
    row.span_id ?? null,
  ]);
}

const ROLLUP_COLUMNS = [
  "service",
  "operation",
  "minute_ts",
  "count",
  "error_count",
  "p50_ms",
  "p95_ms",
  "p99_ms",
] as const;

export async function insertRollups(db: D1Database, rows: readonly RollupRow[]): Promise<void> {
  await batchInsert(db, "rollups", ROLLUP_COLUMNS, rows, (row) => [
    row.service,
    row.operation,
    row.minute_ts,
    row.count,
    row.error_count,
    row.p50_ms,
    row.p95_ms,
    row.p99_ms,
  ]);
}

const DEPLOY_COLUMNS = ["id", "service", "version", "ts_ms", "note"] as const;

export async function insertDeploy(db: D1Database, deploy: Deploy): Promise<void> {
  await batchInsert(db, "deploys", DEPLOY_COLUMNS, [deploy], (row) => [
    row.id,
    row.service,
    row.version,
    row.ts_ms,
    row.note,
  ]);
}
