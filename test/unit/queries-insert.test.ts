import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertDeploy, insertLogs, insertRollups, insertSpans } from "../../src/telemetry/queries";
import type { Deploy, LogLine, RollupRow, Span } from "../../src/telemetry/types";

function makeSpan(i: number): Span {
  return {
    trace_id: `trace-${i}`,
    span_id: `span-${i}`,
    parent_span_id: i % 2 === 0 ? null : `span-${i - 1}`,
    service: "checkout-edge",
    operation: "POST /checkout",
    start_ms: 1_700_000_000_000 + i,
    duration_ms: 10 + (i % 50),
    status: i % 17 === 0 ? "error" : "ok",
    error_type: i % 17 === 0 ? "timeout" : null,
  };
}

function makeLog(i: number): LogLine {
  return {
    ts_ms: 1_700_000_000_000 + i,
    service: "checkout-edge",
    level: "info",
    message: `handled request ${i}`,
    trace_id: `trace-${i}`,
    span_id: `span-${i}`,
  };
}

function makeRollup(i: number): RollupRow {
  return {
    service: "checkout-edge",
    operation: "POST /checkout",
    minute_ts: 1_700_000_000_000 + i * 60_000,
    count: 100 + i,
    error_count: i % 5,
    p50_ms: 20,
    p95_ms: 80,
    p99_ms: 150,
  };
}

afterEach(async () => {
  await env.DB.exec("DELETE FROM spans");
  await env.DB.exec("DELETE FROM logs");
  await env.DB.exec("DELETE FROM rollups");
  await env.DB.exec("DELETE FROM deploys");
});

describe("insertSpans", () => {
  it("inserts 250 spans, chunked to <=90 bound params per batched statement", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => makeSpan(i));

    const batchSpy = vi.spyOn(env.DB, "batch");
    await insertSpans(env.DB, rows);

    // 9 columns/row -> floor(90/9) = 10 rows/statement -> ceil(250/10) = 25 statements.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const statements = batchSpy.mock.calls[0]?.[0] as unknown[];
    expect(statements.length).toBeGreaterThan(1);
    expect(statements.length).toBe(25);
    batchSpy.mockRestore();

    const result = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
    expect(result?.n).toBe(250);
  });

  it("round-trips nullable parent_span_id / error_type", async () => {
    await insertSpans(env.DB, [makeSpan(2), makeSpan(17)]);

    const okRow = await env.DB.prepare("SELECT * FROM spans WHERE span_id = 'span-2'").first<{
      parent_span_id: string | null;
      error_type: string | null;
      status: string;
    }>();
    expect(okRow?.parent_span_id).toBeNull();
    expect(okRow?.error_type).toBeNull();
    expect(okRow?.status).toBe("ok");

    const errRow = await env.DB.prepare("SELECT * FROM spans WHERE span_id = 'span-17'").first<{
      error_type: string | null;
      status: string;
    }>();
    expect(errRow?.status).toBe("error");
    expect(errRow?.error_type).toBe("timeout");
  });

  it("is a no-op for an empty array (no batch call, no rows)", async () => {
    const batchSpy = vi.spyOn(env.DB, "batch");
    await insertSpans(env.DB, []);
    expect(batchSpy).not.toHaveBeenCalled();
    batchSpy.mockRestore();

    const result = await env.DB.prepare("SELECT count(*) as n FROM spans").first<{ n: number }>();
    expect(result?.n).toBe(0);
  });
});

describe("insertLogs", () => {
  it("inserts 250 logs, chunked to <=90 bound params per batched statement", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => makeLog(i));

    const batchSpy = vi.spyOn(env.DB, "batch");
    await insertLogs(env.DB, rows);

    // 6 columns/row -> floor(90/6) = 15 rows/statement -> ceil(250/15) = 17 statements.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const statements = batchSpy.mock.calls[0]?.[0] as unknown[];
    expect(statements.length).toBeGreaterThan(1);
    expect(statements.length).toBe(17);
    batchSpy.mockRestore();

    const result = await env.DB.prepare("SELECT count(*) as n FROM logs").first<{ n: number }>();
    expect(result?.n).toBe(250);
  });

  it("stores logs with no trace_id/span_id as NULL", async () => {
    await insertLogs(env.DB, [
      { ts_ms: 1, service: "catalog-kv", level: "warn", message: "cache miss" },
    ]);
    const row = await env.DB.prepare("SELECT * FROM logs WHERE message = 'cache miss'").first<{
      trace_id: string | null;
      span_id: string | null;
    }>();
    expect(row?.trace_id).toBeNull();
    expect(row?.span_id).toBeNull();
  });
});

describe("insertRollups", () => {
  it("inserts 250 rollups, chunked to <=90 bound params per batched statement", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => makeRollup(i));

    const batchSpy = vi.spyOn(env.DB, "batch");
    await insertRollups(env.DB, rows);

    // 8 columns/row -> floor(90/8) = 11 rows/statement -> ceil(250/11) = 23 statements.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const statements = batchSpy.mock.calls[0]?.[0] as unknown[];
    expect(statements.length).toBeGreaterThan(1);
    expect(statements.length).toBe(23);
    batchSpy.mockRestore();

    const result = await env.DB.prepare("SELECT count(*) as n FROM rollups").first<{ n: number }>();
    expect(result?.n).toBe(250);
  });
});

describe("insertDeploy", () => {
  it("inserts a single deploy row", async () => {
    const deploy: Deploy = {
      id: "deploy-1",
      service: "payments-api",
      version: "v2.4.1",
      ts_ms: 1_700_000_000_000,
      note: "bump payment provider SDK",
    };
    await insertDeploy(env.DB, deploy);

    const row = await env.DB.prepare("SELECT * FROM deploys WHERE id = 'deploy-1'").first<Deploy>();
    expect(row).toMatchObject(deploy);
  });
});
