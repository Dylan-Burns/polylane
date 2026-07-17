import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { insertDeploy, insertLogs, insertRollups, insertSpans } from "../../src/telemetry/queries";
import { executeTool, SUBMIT_REPORT, TOOLS, type ToolDef } from "../../src/agent/tools";
import { parseWindow, WindowError } from "../../src/agent/window";
import type { LogLine, RollupRow, Span } from "../../src/telemetry/types";

// ============================================================================================
// window.ts
// ============================================================================================

describe("parseWindow", () => {
  const NOW = Date.UTC(2026, 0, 5, 14, 30, 0);
  const MIN = 60_000;

  it("defaults from to -30m and to to now when both are omitted", () => {
    const { fromMs, toMs } = parseWindow({}, NOW);
    expect(toMs).toBe(NOW);
    expect(fromMs).toBe(NOW - 30 * MIN);
  });

  it("treats explicit null the same as omission for both bounds", () => {
    const { fromMs, toMs } = parseWindow({ from: null, to: null }, NOW);
    expect(toMs).toBe(NOW);
    expect(fromMs).toBe(NOW - 30 * MIN);
  });

  it("parses an ISO-8601 timestamp for either bound", () => {
    const { fromMs, toMs } = parseWindow({ from: "2026-01-05T13:00:00.000Z", to: "2026-01-05T14:00:00.000Z" }, NOW);
    expect(fromMs).toBe(Date.UTC(2026, 0, 5, 13, 0, 0));
    expect(toMs).toBe(Date.UTC(2026, 0, 5, 14, 0, 0));
  });

  it.each([
    ["-90s", 90 * 1_000],
    ["-30m", 30 * MIN],
    ["-2h", 2 * 60 * MIN],
    ["-1d", 24 * 60 * MIN],
  ])("parses relative offset %s as %dms before now", (offset, expectedMs) => {
    const { fromMs } = parseWindow({ from: offset, to: "2026-01-05T14:30:00.000Z" }, NOW);
    expect(fromMs).toBe(NOW - expectedMs);
  });

  it('resolves the literal "now" to the anchor time for either bound', () => {
    const { fromMs, toMs } = parseWindow({ from: "-10m", to: "now" }, NOW);
    expect(toMs).toBe(NOW);
    expect(fromMs).toBe(NOW - 10 * MIN);
  });

  it.each(["garbage", "", "  ", "-5x", "30m", "+30m", "not-a-date"])(
    "throws WindowError for garbage bound %j",
    (bad) => {
      expect(() => parseWindow({ from: bad }, NOW)).toThrow(WindowError);
    },
  );

  it("swaps reversed bounds instead of erroring", () => {
    const { fromMs, toMs } = parseWindow({ from: "-1m", to: "-10m" }, NOW);
    expect(fromMs).toBe(NOW - 10 * MIN);
    expect(toMs).toBe(NOW - 1 * MIN);
    expect(fromMs).toBeLessThan(toMs);
  });

  it("throws WindowError when both bounds resolve to the exact same instant", () => {
    expect(() => parseWindow({ from: "-5m", to: "-5m" }, NOW)).toThrow(WindowError);
  });

  it("WindowError is a named Error subclass", () => {
    try {
      parseWindow({ from: "garbage" }, NOW);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(WindowError);
      expect((err as Error).name).toBe("WindowError");
    }
  });
});

// ============================================================================================
// tools.ts — fixture
// ============================================================================================

const T0 = Date.UTC(2026, 0, 5, 14, 0, 0);
const MIN = 60_000;
const CTX = { db: env.DB, nowMs: T0 + 30 * MIN };

async function seedFixture(): Promise<void> {
  const rollups: RollupRow[] = [
    { service: "checkout-edge", operation: "POST /checkout", minute_ts: T0, count: 100, error_count: 5, p50_ms: 40, p95_ms: 150, p99_ms: 250 },
    { service: "payments-api", operation: "charge", minute_ts: T0, count: 80, error_count: 1, p50_ms: 30, p95_ms: 90, p99_ms: 140 },
  ];
  await insertRollups(env.DB, rollups);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO baselines (service, operation, metric, median, mad, computed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("checkout-edge", "POST /checkout", "req_rate", 50, 10, T0),
    env.DB.prepare(
      "INSERT INTO baselines (service, operation, metric, median, mad, computed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("checkout-edge", "POST /checkout", "error_rate", 0.025, 0.01, T0),
    env.DB.prepare(
      "INSERT INTO baselines (service, operation, metric, median, mad, computed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("checkout-edge", "POST /checkout", "p95", 10, 2, T0),
  ]);

  // A small error-cascade trace (round-trips find_traces + get_trace + search_logs). Narrates a
  // bad-deploy-flavored regression: the payments-api Worker's own charge span fails with the
  // D1 queued-query saturation symptom (ledger-db's established phrasing surfaces on the
  // caller's span, per scenarios.ts's establishedLogMessage), which edge-gateway observes as a
  // downstream failure on its own POST /checkout span.
  const cascadeStart = T0 + 5 * MIN;
  const cascadeSpans: Span[] = [
    { trace_id: "trace-cascade", span_id: "root", parent_span_id: null, service: "edge-gateway", operation: "POST /checkout", start_ms: cascadeStart, duration_ms: 800, status: "error", error_type: "downstream" },
    { trace_id: "trace-cascade", span_id: "payments-api", parent_span_id: "root", service: "payments-api", operation: "charge", start_ms: cascadeStart + 10, duration_ms: 700, status: "error", error_type: "pool_exhausted" },
  ];
  const cascadeLogs: LogLine[] = [
    { ts_ms: cascadeStart + 10 + 700, service: "payments-api", level: "error", message: "D1_ERROR: too many queued queries — 25 in flight, acquire timed out after 5000ms", trace_id: "trace-cascade", span_id: "payments-api" },
  ];

  // A 90-span trace built to exceed get_trace's 40-span cap (mirrors Task 2.1's fixture shape),
  // so the "oversized ask -> truncated: true passthrough" test has something to exercise.
  const capStart = T0 + 10 * MIN;
  const capSpans: Span[] = [
    { trace_id: "trace-cap", span_id: "cap-root", parent_span_id: null, service: "edge-gateway", operation: "GET /catalog", start_ms: capStart, duration_ms: 900, status: "error", error_type: "downstream" },
  ];
  for (let i = 0; i < 89; i++) {
    capSpans.push({
      trace_id: "trace-cap",
      span_id: `cap-leaf-${i}`,
      parent_span_id: "cap-root",
      service: "catalog-kv",
      operation: "list_items",
      start_ms: capStart + 1 + i,
      duration_ms: 20,
      status: "ok",
      error_type: null,
    });
  }
  expect(capSpans).toHaveLength(90);

  await insertSpans(env.DB, [...cascadeSpans, ...capSpans]);

  const noiseLogs: LogLine[] = Array.from({ length: 60 }, (_, i) => ({
    ts_ms: T0 + i * 1_000,
    service: "catalog-kv",
    level: "info" as const,
    message: `noise log ${i}`,
  }));
  await insertLogs(env.DB, [...cascadeLogs, ...noiseLogs]);

  await insertDeploy(env.DB, { id: "deploy-1", service: "payments-api", version: "v2.4.1", ts_ms: T0 + 1 * MIN, note: "routine release" });

  const trigger = { statement: "checkout-edge error_rate 22% vs baseline", fingerprints: ["checkout-edge:errors"] };
  const report = { summary: "Bad Worker deploy caused checkout-edge errors." };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO incidents (id, status, severity, opened_at, reported_at, resolved_at, trigger_json, report_json, follow_up_of) VALUES (?, 'resolved', 'critical', ?, ?, ?, ?, ?, NULL)",
    ).bind("incident-1", T0 + 1 * MIN, T0 + 2 * MIN, T0 + 3 * MIN, JSON.stringify(trigger), JSON.stringify(report)),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, ?, ?, ?)",
    ).bind("incident-1", "checkout-edge:errors", T0 + 1 * MIN, 1),
  ]);
}

beforeAll(async () => {
  await seedFixture();
});

// ============================================================================================
// TOOLS / SUBMIT_REPORT — shape
// ============================================================================================

describe("TOOLS", () => {
  it("has exactly the six read tools, each strict, each additionalProperties: false", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "query_metrics",
      "search_logs",
      "find_traces",
      "get_trace",
      "list_deploys",
      "get_incidents",
    ]);
    for (const tool of TOOLS) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(20);
      // Every property must be listed in `required` — strict tool use has no true-optional key.
      const props = Object.keys(tool.input_schema.properties ?? {});
      expect(tool.input_schema.required).toBeDefined();
      expect([...(tool.input_schema.required ?? [])].sort()).toEqual([...props].sort());
    }
  });

  it("no schema node combines a multi-type array with an enum (the Anthropic strict validator 400s on it)", () => {
    // Live-observed failure (Task 4.3 go-live), then reproduced directly against the API: the
    // strict validator rejects ANY node that has both a multi-element `type` array and an `enum`,
    // regardless of whether the enum lists null —
    //   {type:["string","null"], enum:["info","warn","error"]}       -> 400
    //   {type:["string","null"], enum:["info","warn","error",null]}  -> 400  (adding null does NOT help)
    //   {enum:["info","warn","error",null]}  (no `type` at all)       -> OK   (the fix we ship)
    // The error message ("Enum value 'info' does not match declared type '['string','null']'") is
    // misleading — the real rule is "enum ⇒ scalar type or no type", never a type union.
    type SchemaNode = {
      type?: string | readonly string[];
      enum?: readonly (string | null)[];
      anyOf?: readonly SchemaNode[];
      properties?: Record<string, SchemaNode>;
      items?: SchemaNode;
    };
    const walk = (schema: SchemaNode, path: string): void => {
      if (schema.enum !== undefined && Array.isArray(schema.type) && schema.type.length > 1) {
        expect.fail(`${path}: enum combined with a multi-type array ${JSON.stringify(schema.type)} is rejected by the strict validator`);
      }
      for (const branch of schema.anyOf ?? []) walk(branch, `${path}|anyOf`);
      for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, `${path}.${key}`);
      if (schema.items) walk(schema.items, `${path}[]`);
    };
    for (const tool of [...TOOLS, SUBMIT_REPORT]) walk(tool.input_schema as SchemaNode, tool.name);
  });

  it("uses enums for level and criteria, not free-form strings", () => {
    const searchLogs = TOOLS.find((t) => t.name === "search_logs") as ToolDef;
    expect(searchLogs.input_schema.properties?.level?.enum).toEqual(["info", "warn", "error", null]);

    const findTraces = TOOLS.find((t) => t.name === "find_traces") as ToolDef;
    expect(findTraces.input_schema.properties?.criteria?.enum).toEqual(["errors", "slowest"]);
    // criteria is not nullable — the tool table calls it a required choice, not optional.
    expect(findTraces.input_schema.properties?.criteria?.type).toBe("string");
  });

  it("does not use unsupported strict-schema keywords (minimum/maximum/minLength/etc.)", () => {
    const raw = JSON.stringify(TOOLS);
    for (const forbidden of ["minimum", "maximum", "minLength", "maxLength", "multipleOf"]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

// A minimal structural JSON-schema validator, hand-rolled per the task brief (no dependency
// added for this). Supports exactly the subset `tools.ts` actually uses: type (incl. arrays for
// nullable fields), properties/required/additionalProperties, items, enum.
function validate(schema: ToolDef["input_schema"], value: unknown, path = "$"): string[] {
  const errors: string[] = [];

  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? "number" : typeof value;
  // `type` is optional: a nullable-enum node (`{enum: [...values, null]}`) omits it, letting the
  // enum below be the only value constraint. Only type-check when a `type` is actually declared.
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matchesType = types.some((t) => {
      if (t === "integer") return typeof value === "number" && Number.isInteger(value);
      return t === actualType;
    });
    if (!matchesType) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${actualType}`);
      return errors; // type mismatch makes deeper checks meaningless
    }
  }

  if (value === null) {
    if (schema.enum && !schema.enum.includes(null)) {
      errors.push(`${path}: null not in enum [${schema.enum.join(", ")}]`);
    }
    return errors;
  }

  if (schema.enum && typeof value === "string" && !schema.enum.includes(value)) {
    errors.push(`${path}: ${value} not in enum [${schema.enum.join(", ")}]`);
  }

  if (schema.properties && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: missing required property`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) errors.push(`${path}.${key}: additional property not allowed`);
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      if (key in obj) errors.push(...validate(subSchema, obj[key], `${path}.${key}`));
    }
  }

  if (schema.items && Array.isArray(value)) {
    value.forEach((item, i) => errors.push(...validate(schema.items as ToolDef["input_schema"], item, `${path}[${i}]`)));
  }

  return errors;
}

describe("SUBMIT_REPORT", () => {
  it("is strict with additionalProperties: false and every property required", () => {
    expect(SUBMIT_REPORT.strict).toBe(true);
    expect(SUBMIT_REPORT.input_schema.additionalProperties).toBe(false);
    const props = Object.keys(SUBMIT_REPORT.input_schema.properties ?? {});
    expect([...(SUBMIT_REPORT.input_schema.required ?? [])].sort()).toEqual([...props].sort());
    expect(props.sort()).toEqual(
      ["summary", "timeline", "root_cause", "evidence", "blast_radius", "confidence", "suggested_action"].sort(),
    );
  });

  const goodReport = {
    summary: "Bad Worker deploy caused checkout-edge errors.",
    timeline: [{ time: "14:32Z", description: "checkout-edge error_rate spiked" }],
    root_cause: { hypothesis: "D1 queued-query saturation on ledger-db", mechanism: "payments-api's ledger-db queries queued up and timed out under load" },
    evidence: [
      { description: "error_rate 22% vs baseline 0.4%", trace_id: "trace-cascade", metric: "checkout-edge error_rate", log_excerpt: null },
    ],
    blast_radius: { affected_services: ["checkout-edge", "payments-api"], customer_impact: "~5% of checkouts failed for 12 minutes" },
    confidence: { level: "high", why: "reproduced in a single trace and confirmed by D1 queued-query saturation logs" },
    suggested_action: "roll back the payments-api Worker deploy",
  };

  it("validates a well-formed report object", () => {
    expect(validate(SUBMIT_REPORT.input_schema, goodReport)).toEqual([]);
  });

  it("rejects a report missing a required top-level field", () => {
    const { suggested_action: _drop, ...bad } = goodReport;
    const errors = validate(SUBMIT_REPORT.input_schema, bad);
    expect(errors.some((e) => e.includes("suggested_action"))).toBe(true);
  });

  it("rejects a report with an invalid confidence.level enum value", () => {
    const bad = { ...goodReport, confidence: { level: "extremely-high", why: "because" } };
    const errors = validate(SUBMIT_REPORT.input_schema, bad);
    expect(errors.some((e) => e.includes("confidence.level"))).toBe(true);
  });

  it("rejects a report with an unknown extra top-level property", () => {
    const bad = { ...goodReport, extra_field: "not allowed" };
    const errors = validate(SUBMIT_REPORT.input_schema, bad);
    expect(errors.some((e) => e.includes("extra_field"))).toBe(true);
  });

  it("rejects a report whose evidence item is missing a required field", () => {
    const bad = { ...goodReport, evidence: [{ description: "x", trace_id: null, metric: null }] };
    const errors = validate(SUBMIT_REPORT.input_schema, bad);
    expect(errors.some((e) => e.includes("log_excerpt"))).toBe(true);
  });
});

// ============================================================================================
// executeTool — round trips against the fixture
// ============================================================================================

describe("executeTool", () => {
  it("query_metrics round-trips with baseline/delta attached", async () => {
    const result = (await executeTool(
      "query_metrics",
      { service: "checkout-edge", operation: null, metrics: null, window: { from: "-30m", to: null }, step: null },
      CTX,
    )) as { points: Array<{ service: string; delta?: Record<string, number> }>; count: number };

    expect(result.count).toBe(1);
    expect(result.points[0]?.service).toBe("checkout-edge");
    expect(result.points[0]?.delta).toEqual({ req_rate: 2, error_rate: 2, p95: 15 });
  });

  it("query_metrics `metrics` narrows the baseline/delta overlay without touching raw values", async () => {
    const result = (await executeTool(
      "query_metrics",
      { service: "checkout-edge", operation: null, metrics: ["p95"], window: { from: "-30m", to: null }, step: null },
      CTX,
    )) as { points: Array<{ p50: number; delta?: Record<string, number> }> };

    const point = result.points[0];
    expect(point?.delta).toEqual({ p95: 15 });
    expect(point?.p50).toBe(40); // raw values untouched by the metrics filter
  });

  it("search_logs round-trips a contains filter with trace linkage and an exact total", async () => {
    const result = (await executeTool(
      "search_logs",
      { service: null, level: "error", contains: "queued queries", window: { from: "-30m", to: null }, limit: null },
      CTX,
    )) as { logs: Array<{ trace_id?: string }>; count: number; total: number; truncated: boolean; note?: string };

    expect(result.count).toBe(1);
    expect(result.total).toBe(1);
    expect(result.logs[0]?.trace_id).toBe("trace-cascade");
    expect(result.truncated).toBe(false);
    expect(result.note).toBeUndefined(); // note appears only on truncated results, like get_trace
  });

  it("search_logs clamps an oversized limit and reports exact truncation with a showing-N-of-M note", async () => {
    const result = (await executeTool(
      "search_logs",
      { service: "catalog-kv", level: "info", contains: null, window: { from: "-30m", to: null }, limit: 1000 },
      CTX,
    )) as { logs: unknown[]; count: number; total: number; truncated: boolean; note?: string };

    expect(result.count).toBe(50); // 60 noise logs match, page capped at 50
    expect(result.total).toBe(60); // ...but total reports the uncapped match count
    expect(result.truncated).toBe(true);
    expect(result.note).toBe("showing 50 of 60 matching log lines");
  });

  it("search_logs with count exactly at the caller's limit is NOT truncated when total matches (old heuristic's false positive)", async () => {
    const result = (await executeTool(
      "search_logs",
      { service: null, level: "error", contains: "queued queries", window: { from: "-30m", to: null }, limit: 1 },
      CTX,
    )) as { count: number; total: number; truncated: boolean };

    // Exactly 1 match, limit 1: the page is "full" but nothing was cut off — the COUNT(*)-backed
    // total makes this exact where the old count===limit heuristic misreported truncated: true.
    expect(result.count).toBe(1);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("find_traces criteria 'errors' round-trips entry service/operation/status with an exact total", async () => {
    const result = (await executeTool(
      "find_traces",
      { service: null, window: { from: "-30m", to: null }, criteria: "errors", limit: null },
      CTX,
    )) as { traces: Array<{ trace_id: string; status: string }>; count: number; total: number; truncated: boolean };

    expect(result.traces.map((t) => t.trace_id).sort()).toEqual(["trace-cap", "trace-cascade"]);
    for (const t of result.traces) expect(t.status).toBe("error");
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("find_traces below-total limit reports truncated with a showing-N-of-M note", async () => {
    const result = (await executeTool(
      "find_traces",
      { service: null, window: { from: "-30m", to: null }, criteria: "errors", limit: 1 },
      CTX,
    )) as { traces: unknown[]; count: number; total: number; truncated: boolean; note?: string };

    expect(result.count).toBe(1);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.note).toBe("showing 1 of 2 matching traces");
  });

  it("get_trace passes through truncated: true and note untouched for an oversized trace", async () => {
    const result = (await executeTool("get_trace", { trace_id: "trace-cap" }, CTX)) as {
      spans: unknown[];
      truncated: boolean;
      note?: string;
    };

    expect(result.truncated).toBe(true);
    expect(result.spans.length).toBeLessThanOrEqual(40);
    expect(result.note).toContain("90");
  });

  it("get_trace returns truncated: false untouched for a trace under the cap", async () => {
    const result = (await executeTool("get_trace", { trace_id: "trace-cascade" }, CTX)) as {
      spans: unknown[];
      truncated: boolean;
      note?: string;
    };

    expect(result.truncated).toBe(false);
    expect(result.note).toBeUndefined();
    expect(result.spans).toHaveLength(2);
  });

  it("list_deploys round-trips within the window and never exposes the internal id", async () => {
    const result = (await executeTool("list_deploys", { window: { from: "-30m", to: null } }, CTX)) as {
      deploys: Array<{ id?: string; service: string; version: string }>;
      count: number;
    };
    expect(result.count).toBe(1);
    expect(result.deploys.map((d) => `${d.service}@${d.version}`)).toEqual(["payments-api@v2.4.1"]);
    // Deploy ids embed the scenario name (`deploy-<scenario>-…`) — exposing one would hand the
    // agent the injected fault's name, defeating the simulation honesty boundary.
    expect(result.deploys[0]).not.toHaveProperty("id");
  });

  it("get_incidents by id returns the single incident with report/trigger parsed", async () => {
    const result = (await executeTool("get_incidents", { id: "incident-1", window: null }, CTX)) as {
      incidents: Array<{ id: string; report: unknown }>;
    };
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]?.id).toBe("incident-1");
    expect(result.incidents[0]?.report).toEqual({ summary: "Bad Worker deploy caused checkout-edge errors." });
  });

  it("get_incidents by window returns matching incidents newest first", async () => {
    const result = (await executeTool(
      "get_incidents",
      { id: null, window: { from: "-30m", to: null } },
      CTX,
    )) as { incidents: Array<{ id: string }> };
    expect(result.incidents.map((i) => i.id)).toEqual(["incident-1"]);
  });

  it("returns {error} for an unknown tool name, never throws", async () => {
    const result = (await executeTool("delete_everything", {}, CTX)) as { error: string };
    expect(result.error).toContain("unknown tool");
    expect(result.error).toContain("delete_everything");
  });

  it("returns {error} for a garbage window instead of throwing", async () => {
    const result = (await executeTool(
      "search_logs",
      { service: null, level: null, contains: null, window: { from: "not-a-real-date", to: null }, limit: null },
      CTX,
    )) as { error: string };
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
  });

  it("returns {error} for missing required input (find_traces without criteria), never throws", async () => {
    const result = (await executeTool(
      "find_traces",
      { service: null, window: null, limit: null },
      CTX,
    )) as { error: string };
    expect(result.error).toBeDefined();
  });

  it("returns {error} for a wrong-typed field instead of throwing", async () => {
    const result = (await executeTool(
      "search_logs",
      { service: null, level: null, contains: null, window: null, limit: "fifty" },
      CTX,
    )) as { error: string };
    expect(result.error).toBeDefined();
  });

  it("returns {error} for non-object input instead of throwing", async () => {
    const result = (await executeTool("list_deploys", "not an object", CTX)) as { error: string };
    expect(result.error).toBeDefined();
  });
});
