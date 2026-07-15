import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { sweepRetention } from "../../src/telemetry/retention";
import { insertLogs, insertRollups, insertSpans } from "../../src/telemetry/queries";
import type { LogLine, RollupRow, Span } from "../../src/telemetry/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 0, 5, 14, 0, 0);

function mkSpan(i: number, startMs: number): Span {
  return {
    trace_id: `t-${i}`,
    span_id: `s-${i}`,
    parent_span_id: null,
    service: "checkout",
    operation: "place_order",
    start_ms: startMs,
    duration_ms: 10,
    status: "ok",
    error_type: null,
  };
}

function mkLog(i: number, tsMs: number): LogLine {
  return { ts_ms: tsMs, service: "checkout", level: "info", message: `line ${i}` };
}

function mkRollup(minuteTs: number): RollupRow {
  return { service: "checkout", operation: "place_order", minute_ts: minuteTs, count: 10, error_count: 0, p50_ms: 10, p95_ms: 20, p99_ms: 30 };
}

async function counts() {
  const [spans, logs, rollups] = await Promise.all([
    env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>(),
    env.DB.prepare("SELECT count(*) as n FROM logs").first<{ n: number }>(),
    env.DB.prepare("SELECT count(*) as n FROM rollups").first<{ n: number }>(),
  ]);
  return { spans: spans?.n ?? 0, logs: logs?.n ?? 0, rollups: rollups?.n ?? 0 };
}

afterEach(async () => {
  for (const table of ["spans", "logs", "rollups", "meta"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("sweepRetention", () => {
  it("returns 0 and writes nothing on an empty world", async () => {
    const deleted = await sweepRetention(env.DB, T0);
    expect(deleted).toBe(0);
    expect(await counts()).toEqual({ spans: 0, logs: 0, rollups: 0 });
  });

  it("deletes spans/logs older than 6h but keeps fresher ones", async () => {
    await insertSpans(env.DB, [mkSpan(1, T0 - 7 * HOUR), mkSpan(2, T0 - 1 * HOUR)]);
    await insertLogs(env.DB, [mkLog(1, T0 - 7 * HOUR), mkLog(2, T0 - 1 * HOUR)]);

    const deleted = await sweepRetention(env.DB, T0);
    expect(deleted).toBe(2); // one old span + one old log

    const remainingSpans = await env.DB.prepare("SELECT span_id FROM spans").all<{ span_id: string }>();
    expect(remainingSpans.results?.map((r) => r.span_id)).toEqual(["s-2"]);
    const remainingLogs = await env.DB.prepare("SELECT message FROM logs").all<{ message: string }>();
    expect(remainingLogs.results?.map((r) => r.message)).toEqual(["line 2"]);
  });

  it("keeps rollups until 72h, unlike spans/logs at 6h", async () => {
    await insertRollups(env.DB, [mkRollup(T0 - 70 * HOUR), mkRollup(T0 - 73 * HOUR)]);

    const deleted = await sweepRetention(env.DB, T0);
    expect(deleted).toBe(1);

    const remaining = await env.DB.prepare("SELECT minute_ts FROM rollups").all<{ minute_ts: number }>();
    expect(remaining.results).toHaveLength(1);
    expect(remaining.results?.[0]?.minute_ts).toBe(T0 - 70 * HOUR);
  });

  it("chunks deletes to maxRows per run, deleting the oldest rows first", async () => {
    const spans: Span[] = [];
    for (let i = 0; i < 10; i++) {
      spans.push(mkSpan(i, T0 - 7 * HOUR + i * 1000)); // 10 old spans, distinct timestamps
    }
    await insertSpans(env.DB, spans);

    const firstRun = await sweepRetention(env.DB, T0, { maxRows: 3 });
    expect(firstRun).toBe(3);
    const afterFirst = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
    expect(afterFirst?.n).toBe(7);

    // The 3 deleted must be the oldest 3 (i=0,1,2), not an arbitrary selection.
    const remainingIds = await env.DB.prepare("SELECT span_id FROM spans ORDER BY start_ms ASC").all<{ span_id: string }>();
    expect(remainingIds.results?.map((r) => r.span_id)).toEqual(["s-3", "s-4", "s-5", "s-6", "s-7", "s-8", "s-9"]);

    const secondRun = await sweepRetention(env.DB, T0, { maxRows: 3 });
    expect(secondRun).toBe(3);
    const thirdRun = await sweepRetention(env.DB, T0, { maxRows: 10 });
    expect(thirdRun).toBe(4); // remaining 4 cleared, even though budget was 10
    const finalCount = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
    expect(finalCount?.n).toBe(0);
  });

  it("splits a shared maxRows budget across spans/logs/rollups in order (spans, logs, rollups)", async () => {
    await insertSpans(env.DB, [mkSpan(1, T0 - 7 * HOUR), mkSpan(2, T0 - 7 * HOUR)]);
    await insertLogs(env.DB, [mkLog(1, T0 - 7 * HOUR), mkLog(2, T0 - 7 * HOUR)]);
    await insertRollups(env.DB, [mkRollup(T0 - 73 * HOUR)]);

    // Budget of 3: both old spans (2) exhaust most of it, leaving 1 for logs, 0 for rollups.
    const deleted = await sweepRetention(env.DB, T0, { maxRows: 3 });
    expect(deleted).toBe(3);

    const after = await counts();
    expect(after.spans).toBe(0);
    expect(after.logs).toBe(1); // only 1 of the 2 old logs cleared this run
    expect(after.rollups).toBe(1); // untouched -- budget ran out before rollups' turn
  });

  it("persists a watermark in meta under 'retention_watermark_ms'", async () => {
    await insertSpans(env.DB, [mkSpan(1, T0 - 7 * HOUR)]);
    await sweepRetention(env.DB, T0);

    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind("retention_watermark_ms").first<{ value: string }>();
    expect(row).not.toBeNull();
    const watermarks = JSON.parse(row?.value ?? "{}") as { spans: number; logs: number; rollups: number };
    expect(watermarks.spans).toBe(T0 - 6 * HOUR); // spans/logs fully cleared this run -> watermark advances to this run's cutoff
  });

  it("does not advance a table's watermark past what it actually cleared when budget-capped", async () => {
    const spans: Span[] = [];
    for (let i = 0; i < 5; i++) spans.push(mkSpan(i, T0 - 7 * HOUR + i * 1000));
    await insertSpans(env.DB, spans);

    await sweepRetention(env.DB, T0, { maxRows: 2 }); // budget-capped: 2 of 5 old spans deleted
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind("retention_watermark_ms").first<{ value: string }>();
    const watermarks = JSON.parse(row?.value ?? "{}") as { spans: number; logs: number; rollups: number };
    expect(watermarks.spans).toBe(0); // NOT advanced -- 3 old spans still remain below the cutoff

    const remaining = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
    expect(remaining?.n).toBe(3);
  });
});
