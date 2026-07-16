/**
 * The agent-world interface (spec §9): six read tools backed by `telemetry/read.ts`, plus
 * `SUBMIT_REPORT` (defined separately — investigator-only, ends an investigation rather than
 * reading anything). `executeTool` is the single dispatch point every caller (the investigator
 * loop, Task 4.x; the chat backend, Task 6.x) goes through — it never throws: unknown tool
 * names, malformed input, a garbage window, or a D1 error all come back as a plain
 * `{error: string}` result, exactly like a normal (if unhelpful) tool result, so a single bad
 * tool call can't crash an investigation step.
 *
 * Executors are thin adapters over `read.ts` — they parse/validate `input` (untyped JSON from
 * the model), resolve `window` via `parseWindow`, call the matching `read.ts` function, and
 * shape the result for the model. Row/span caps themselves live entirely in `read.ts`; nothing
 * here re-implements or second-guesses them (the cap constants mentioned in schema descriptions
 * are imported from `read.ts`, never copied). `get_trace`'s `truncated`/`note` fields are carried
 * through untouched. `search_logs`/`find_traces` return a `total` match count from `read.ts`
 * alongside the capped page, so this layer reports exact truncation (`truncated: total > count`,
 * plus a "showing N of M" note mirroring `get_trace`'s phrasing).
 */

import { parseWindow, WindowError, type WindowInput } from "./window";
import {
  FIND_TRACES_MAX_LIMIT,
  findTraces,
  GET_INCIDENTS_MAX_LIMIT,
  getIncidents,
  getTrace,
  listDeploys,
  MAX_METRIC_POINTS,
  MAX_TRACE_SPANS,
  queryMetrics,
  SEARCH_LOGS_MAX_LIMIT,
  searchLogs,
} from "../telemetry/read";
import type { BaselineMetric, MetricPoint } from "../telemetry/types";

// --- JSON Schema (Anthropic strict-tool-use-compatible subset) -----------------------------
//
// Strict tool use validates `tool_use.input` exactly against `input_schema`, which restricts
// the schema to a subset of JSON Schema: every property must be listed in `required` (there is
// no true "optional" key — a field that's optional in spirit is instead typed `[T, "null"]` and
// the caller passes `null`), every object needs `additionalProperties: false`, and numeric/string
// length constraints (`minimum`/`maximum`/`minLength`/etc.) are NOT supported and are dropped —
// bounds like "limit clamps to 50" are documented in `description` prose instead, enforced for
// real by `read.ts`'s row caps.

interface JSONSchema {
  /** Optional so a nullable *enum* can be expressed as `{enum: [...values, null]}` with NO `type`
   * key. The Anthropic strict validator rejects any node that pairs `enum` with a multi-element
   * `type` array (e.g. `{type: ["string","null"], enum: [...]}` — 400, whether or not null is in
   * the enum; verified directly against the API in Task 4.3). Dropping `type` entirely is the one
   * shape that keeps both the enum constraint and null as an allowed value. */
  type?: string | readonly string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: readonly string[];
  /** May include `null`. Do NOT also set a multi-element `type` array on the same node — that
   * combination is a hard 400 from the strict validator (see `type`'s doc comment). A scalar
   * `type` (e.g. `"string"`) alongside `enum` is fine; a nullable enum omits `type` altogether. */
  enum?: readonly (string | null)[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: JSONSchema;
  strict: true;
}

const LOG_LEVELS = ["info", "warn", "error"] as const;
const FIND_TRACES_CRITERIA = ["errors", "slowest"] as const;
const BASELINE_METRICS = ["req_rate", "error_rate", "p95", "p50"] as const;
const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

/** Shared window schema fragment. Both the object and its bounds are REQUIRED and non-null (no
 * `"null"` in any `type`): the Anthropic strict validator caps a request at 16 union-typed
 * parameters, and this window is reused across five tools — leaving its three nodes nullable put
 * the whole tool set at 18 unions and 400'd every investigation (Task 4.3). For the last-30-minutes
 * default, the model passes `{"from": "-30m", "to": "now"}` (`parseWindow` resolves `"now"`). */
const WINDOW_SCHEMA: JSONSchema = {
  type: "object",
  description:
    'Time range to query, half-open [from, to). Each bound is an ISO-8601 timestamp, a relative offset from now ("-30m", "-2h", "-90s", "-1d"), or the literal "now". For the last 30 minutes, pass {"from": "-30m", "to": "now"}.',
  properties: {
    from: { type: "string", description: 'Start of the window (older bound): an ISO-8601 timestamp, a relative offset like "-30m", or "now".' },
    to: { type: "string", description: 'End of the window (newer, exclusive bound): an ISO-8601 timestamp, a relative offset, or "now".' },
  },
  required: ["from", "to"],
  additionalProperties: false,
};

const QUERY_METRICS_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    service: { type: ["string", "null"], description: "Restrict to one service (e.g. \"checkout\"). Omit/null for all services." },
    operation: { type: ["string", "null"], description: "Restrict to one operation within a service (e.g. \"POST /checkout\"). Omit/null for all operations." },
    metrics: {
      type: ["array", "null"],
      description:
        "Which baseline/delta classes to overlay on each point (req_rate | error_rate | p95 | p50). Narrows the `baseline`/`delta` fields only — count/p50/p95/p99 raw values are always returned in full. Omit/null to see every class with a baseline.",
      items: { type: "string", enum: BASELINE_METRICS },
    },
    window: WINDOW_SCHEMA,
    step: { type: ["integer", "null"], description: "Bucket width in minutes for the timeseries. Defaults to 1 (one point per rollup minute)." },
  },
  required: ["service", "operation", "metrics", "window", "step"],
  additionalProperties: false,
};

const SEARCH_LOGS_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    service: { type: ["string", "null"], description: "Restrict to log lines emitted by one service. Omit/null for all services." },
    // Nullable enum: `enum` carries null as an allowed value, and `type` is omitted entirely — a
    // `type: ["string","null"]` union alongside `enum` is a hard 400 from the strict validator
    // (see JSONSchema.type's doc comment; verified against the API in Task 4.3).
    level: { enum: [...LOG_LEVELS, null], description: "Restrict to one log level (info, warn, error). Omit/null for all levels." },
    contains: { type: ["string", "null"], description: "Literal (non-pattern) case-insensitive substring the log message must contain. Omit/null for no filter." },
    window: WINDOW_SCHEMA,
    limit: { type: ["integer", "null"], description: `Max rows to return, newest first. Clamped to [1, ${SEARCH_LOGS_MAX_LIMIT}]; defaults to ${SEARCH_LOGS_MAX_LIMIT}.` },
  },
  required: ["service", "level", "contains", "window", "limit"],
  additionalProperties: false,
};

const FIND_TRACES_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    service: { type: ["string", "null"], description: "Restrict to traces whose entry (root) span is in this service. Omit/null for all services." },
    window: WINDOW_SCHEMA,
    criteria: {
      type: "string",
      enum: FIND_TRACES_CRITERIA,
      description:
        "\"errors\": traces containing an error span anywhere in the tree (the root may still be ok under an async fire-and-forget branch) — use this to find concrete failing requests. \"slowest\": all matching traces sorted by the root span's own duration, descending — use this for latency investigations.",
    },
    limit: { type: ["integer", "null"], description: `Max trace summaries to return. Clamped to [1, ${FIND_TRACES_MAX_LIMIT}]; defaults to ${FIND_TRACES_MAX_LIMIT}.` },
  },
  required: ["service", "window", "criteria", "limit"],
  additionalProperties: false,
};

const GET_TRACE_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    trace_id: { type: "string", description: "The trace_id to fetch, from find_traces or a log line's trace_id field." },
  },
  required: ["trace_id"],
  additionalProperties: false,
};

const LIST_DEPLOYS_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    window: WINDOW_SCHEMA,
  },
  required: ["window"],
  additionalProperties: false,
};

const GET_INCIDENTS_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    id: { type: ["string", "null"], description: "Fetch one specific incident by id. When set, `window` is ignored." },
    window: WINDOW_SCHEMA,
  },
  required: ["id", "window"],
  additionalProperties: false,
};

export const TOOLS: ToolDef[] = [
  {
    name: "query_metrics",
    description:
      `Timeseries of request rate, error rate, and latency percentiles (p50/p95/p99) per service/operation, bucketed by \`step\` minutes, with a trailing-24h baseline (median/MAD) and a value-vs-baseline delta overlaid per point wherever a baseline exists. Start here to scope which services and time ranges are abnormal before drilling into logs or traces — a delta near 1 is normal; a delta of several-x on error_rate or p95 marks a genuine anomaly worth chasing. Use \`metrics\` to narrow the baseline/delta overlay once you know which signal matters; omit it to see every class. Returns at most ${MAX_METRIC_POINTS} points (the first ${MAX_METRIC_POINTS}, deterministically ordered by service/operation/bucket); \`truncated: true\` plus a \`note\` mean there were more — narrow the window, add a service/operation filter, or raise \`step\` to see the rest.`,
    input_schema: QUERY_METRICS_SCHEMA,
    strict: true,
  },
  {
    name: "search_logs",
    description:
      `Matching log lines in the window, newest first, each with its service/level/message and (when available) the trace_id/span_id linking it back to a specific request. Use once query_metrics has scoped a time range and service, to read the actual messages driving an anomaly — \`contains\` is a literal substring match, not a pattern language. Returns at most \`limit\` (default and max ${SEARCH_LOGS_MAX_LIMIT}) lines plus \`total\`, the full match count; \`truncated: true\` means only the newest \`count\` of \`total\` matches are shown — narrow the window/service/level to see the rest.`,
    input_schema: SEARCH_LOGS_SCHEMA,
    strict: true,
  },
  {
    name: "find_traces",
    description:
      `Trace summaries (entry service/operation, start time, root-span duration, status, span_count) for traces entering in the window — not full span trees. Use \`criteria: "errors"\` to find concrete failing requests once query_metrics/search_logs point at a service, or \`criteria: "slowest"\` for latency investigations. Follow up with get_trace on a specific trace_id to see the causal chain. Returns at most \`limit\` (default and max ${FIND_TRACES_MAX_LIMIT}) summaries plus \`total\`, the full match count; \`truncated: true\` means only \`count\` of \`total\` matches are shown.`,
    input_schema: FIND_TRACES_SCHEMA,
    strict: true,
  },
  {
    name: "get_trace",
    description:
      `The full span tree for one trace_id — every span's service/operation/timing/status, plus the error-level log lines linked to that trace. This is how to see the causal chain of a single failing or slow request: which service called which, and where an error or latency actually originated versus where it was merely observed downstream. Capped at ${MAX_TRACE_SPANS} spans; on a larger trace, repeated healthy sibling spans collapse into "...N similar ok spans" markers while the full error root-to-leaf path is always kept intact — \`truncated: true\` plus \`note\` explain what was collapsed. Get a trace_id from find_traces or a log line first.`,
    input_schema: GET_TRACE_SCHEMA,
    strict: true,
  },
  {
    name: "list_deploys",
    description:
      "Deploy/change events (service, version, timestamp, note) in the window, chronological ascending — a timeline for correlating a regression's onset with a recent release. Use once query_metrics has narrowed down roughly when an anomaly started, to check whether something shipped right before it.",
    input_schema: LIST_DEPLOYS_SCHEMA,
    strict: true,
  },
  {
    name: "get_incidents",
    description:
      `Past incidents — status, severity, trigger, and (once written) the submitted report — either one by \`id\`, or every incident whose opened_at falls in the window, newest first. Powers "what happened at 14:32?" style questions in chat, and gives the investigator prior-incident context (has this fingerprint fired before? what was the root cause, and did it recur?) before treating a new trigger as novel. A window lookup returns at most ${GET_INCIDENTS_MAX_LIMIT} incidents plus \`total\`, the full match count; \`truncated: true\` means only the newest \`count\` of \`total\` are shown — narrow the window to see the rest.`,
    input_schema: GET_INCIDENTS_SCHEMA,
    strict: true,
  },
];

/**
 * The investigator's report-submission tool (spec §9's report shape). Not part of `TOOLS` and
 * not dispatched by `executeTool` — submitting a report ends the investigation and writes to
 * `incidents` (Task 3.3/4.2 own that write path), which is a fundamentally different action from
 * the six read-only lookups above, not another read to adapt.
 */
export const SUBMIT_REPORT: ToolDef = {
  name: "submit_report",
  description:
    "Ends the investigation by submitting the final structured report. Call this exactly once, only after gathering enough evidence (metrics, logs, traces, deploys, prior incidents) to state a root cause with a defensible confidence level — not on the first anomalous signal seen. `evidence` should cite the concrete metric deltas, trace_ids, and log excerpts that actually support `root_cause`, not just restate the trigger that opened the investigation. `confidence` should reflect how directly the evidence supports the proposed mechanism, not how severe the incident is.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One or two sentences: what happened, in plain language." },
      timeline: {
        type: "array",
        description: "Chronological sequence of the key events that explain the incident (deploys, onset, cascade, detection).",
        items: {
          type: "object",
          properties: {
            time: { type: "string", description: "When this happened — an ISO-8601 timestamp or a short relative/clock reference (e.g. \"14:32Z\")." },
            description: { type: "string", description: "What happened at this point." },
          },
          required: ["time", "description"],
          additionalProperties: false,
        },
      },
      root_cause: {
        type: "object",
        description: "The proposed cause and the mechanism by which it produced the observed symptoms.",
        properties: {
          hypothesis: { type: "string", description: "The proposed root cause, stated plainly (e.g. \"payments connection pool exhaustion\")." },
          mechanism: { type: "string", description: "How the hypothesis causally led to the observed symptoms." },
        },
        required: ["hypothesis", "mechanism"],
        additionalProperties: false,
      },
      evidence: {
        type: "array",
        description: "Concrete evidence supporting root_cause — metric deltas, trace IDs, and log excerpts, not a restatement of the trigger.",
        items: {
          type: "object",
          properties: {
            description: { type: "string", description: "What this piece of evidence shows and why it's relevant." },
            trace_id: { type: ["string", "null"], description: "A trace_id this evidence references, if any." },
            metric: { type: ["string", "null"], description: "A metric/delta this evidence references (e.g. \"payments p95: 8.2x baseline\"), if any." },
            log_excerpt: { type: ["string", "null"], description: "A log line or short excerpt this evidence references, if any." },
          },
          required: ["description", "trace_id", "metric", "log_excerpt"],
          additionalProperties: false,
        },
      },
      blast_radius: {
        type: "object",
        description: "Which services were affected and a judgment call on customer impact.",
        properties: {
          affected_services: { type: "array", description: "Services impacted by the incident.", items: { type: "string" } },
          customer_impact: { type: "string", description: "Plain-language judgment of what customers experienced (e.g. \"~5% of checkouts failed for 12 minutes\")." },
        },
        required: ["affected_services", "customer_impact"],
        additionalProperties: false,
      },
      confidence: {
        type: "object",
        description: "How confident the root-cause hypothesis is, and why.",
        properties: {
          level: { type: "string", enum: CONFIDENCE_LEVELS, description: "Overall confidence in root_cause." },
          why: { type: "string", description: "What would make confidence higher, or what already makes it solid." },
        },
        required: ["level", "why"],
        additionalProperties: false,
      },
      suggested_action: { type: "string", description: "A concrete next step (rollback, scale up, patch, page a team, etc.)." },
    },
    required: ["summary", "timeline", "root_cause", "evidence", "blast_radius", "confidence", "suggested_action"],
    additionalProperties: false,
  },
  strict: true,
};

// --- executeTool ------------------------------------------------------------------------------

export interface ExecuteToolCtx {
  db: D1Database;
  nowMs: number;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("tool input must be a JSON object");
  }
  return input as Record<string, unknown>;
}

function optionalString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

function requiredString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
  return v;
}

function optionalNumber(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`"${key}" must be a finite number`);
  return v;
}

function optionalEnum<T extends string>(rec: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`"${key}" must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

function requiredEnum<T extends string>(rec: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = rec[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`"${key}" is required and must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

function optionalEnumArray<T extends string>(rec: Record<string, unknown>, key: string, allowed: readonly T[]): T[] | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`"${key}" must be an array`);
  for (const item of v) {
    if (typeof item !== "string" || !(allowed as readonly string[]).includes(item)) {
      throw new Error(`"${key}" must contain only: ${allowed.join(", ")}`);
    }
  }
  return v as T[];
}

function optionalWindow(rec: Record<string, unknown>): WindowInput {
  const v = rec.window;
  if (v === undefined || v === null) return {};
  const w = asRecord(v);
  return { from: optionalString(w, "from"), to: optionalString(w, "to") };
}

/** Narrows a `MetricPoint`'s `baseline`/`delta` to only the requested classes, preserving
 * `read.ts`'s own convention of omitting the field entirely (not `{}`) when nothing survives the
 * filter. Raw `count`/`p50`/`p95`/`p99` values are never touched — `metrics` narrows the overlay,
 * not the underlying timeseries. */
function filterMetricPoint(point: MetricPoint, metrics: readonly BaselineMetric[]): MetricPoint {
  if (!point.baseline && !point.delta) return point;
  const keep = new Set<BaselineMetric>(metrics);
  const result: MetricPoint = { ...point };

  if (result.baseline) {
    const filtered: Partial<Record<BaselineMetric, { median: number; mad: number }>> = {};
    for (const k of Object.keys(result.baseline) as BaselineMetric[]) {
      const entry = result.baseline[k];
      if (keep.has(k) && entry) filtered[k] = entry;
    }
    if (Object.keys(filtered).length > 0) result.baseline = filtered;
    else delete result.baseline;
  }

  if (result.delta) {
    const filtered: Partial<Record<BaselineMetric, number>> = {};
    for (const k of Object.keys(result.delta) as BaselineMetric[]) {
      const entry = result.delta[k];
      if (keep.has(k) && entry !== undefined) filtered[k] = entry;
    }
    if (Object.keys(filtered).length > 0) result.delta = filtered;
    else delete result.delta;
  }

  return result;
}

async function runQueryMetrics(input: unknown, ctx: ExecuteToolCtx): Promise<object> {
  const rec = asRecord(input);
  const service = optionalString(rec, "service");
  const operation = optionalString(rec, "operation");
  const metrics = optionalEnumArray(rec, "metrics", BASELINE_METRICS);
  const stepMin = optionalNumber(rec, "step") ?? 1;
  const { fromMs, toMs } = parseWindow(optionalWindow(rec), ctx.nowMs);

  const points = await queryMetrics(ctx.db, { service, operation, fromMs, toMs, stepMin });
  const shaped = metrics && metrics.length > 0 ? points.map((p) => filterMetricPoint(p, metrics)) : points;

  // Shape-aware cap applied here (not in read.ts — see MAX_METRIC_POINTS's doc comment): take the
  // first MAX_METRIC_POINTS of the read layer's own deterministic order, same "first N, honestly
  // flagged" contract as every other capped tool result.
  const truncated = shaped.length > MAX_METRIC_POINTS;
  const page = truncated ? shaped.slice(0, MAX_METRIC_POINTS) : shaped;
  return {
    points: page,
    count: page.length,
    truncated,
    ...(truncated
      ? {
          note: `showing ${page.length} of ${shaped.length} points; narrow the window, add a service/operation filter, or raise \`step\` to see the rest`,
        }
      : {}),
  };
}

async function runSearchLogs(input: unknown, ctx: ExecuteToolCtx): Promise<object> {
  const rec = asRecord(input);
  const service = optionalString(rec, "service");
  const level = optionalEnum(rec, "level", LOG_LEVELS);
  const contains = optionalString(rec, "contains");
  const limitInput = optionalNumber(rec, "limit");
  const { fromMs, toMs } = parseWindow(optionalWindow(rec), ctx.nowMs);

  const { logs, total } = await searchLogs(ctx.db, { service, level, contains, fromMs, toMs, limit: limitInput });
  const truncated = total > logs.length;
  return {
    logs,
    count: logs.length,
    total,
    truncated,
    ...(truncated ? { note: `showing ${logs.length} of ${total} matching log lines` } : {}),
  };
}

async function runFindTraces(input: unknown, ctx: ExecuteToolCtx): Promise<object> {
  const rec = asRecord(input);
  const service = optionalString(rec, "service");
  const criteria = requiredEnum(rec, "criteria", FIND_TRACES_CRITERIA);
  const limitInput = optionalNumber(rec, "limit");
  const { fromMs, toMs } = parseWindow(optionalWindow(rec), ctx.nowMs);

  const { traces, total } = await findTraces(ctx.db, { service, fromMs, toMs, criteria, limit: limitInput });
  const truncated = total > traces.length;
  return {
    traces,
    count: traces.length,
    total,
    truncated,
    ...(truncated ? { note: `showing ${traces.length} of ${total} matching traces` } : {}),
  };
}

async function runGetTrace(input: unknown, ctx: ExecuteToolCtx): Promise<object> {
  const rec = asRecord(input);
  const traceId = requiredString(rec, "trace_id");
  // Passed through untouched — `truncated`/`note` are read.ts's own shape-aware cap signal.
  return await getTrace(ctx.db, traceId);
}

async function runListDeploys(input: unknown, ctx: ExecuteToolCtx): Promise<object> {
  const rec = asRecord(input);
  const { fromMs, toMs } = parseWindow(optionalWindow(rec), ctx.nowMs);
  const deploys = await listDeploys(ctx.db, { fromMs, toMs });
  return { deploys, count: deploys.length };
}

async function runGetIncidents(input: unknown, ctx: ExecuteToolCtx): Promise<object> {
  const rec = asRecord(input);
  const id = optionalString(rec, "id");
  if (id !== undefined) {
    const { incidents, total } = await getIncidents(ctx.db, { id });
    return { incidents, count: incidents.length, total, truncated: false };
  }
  const { fromMs, toMs } = parseWindow(optionalWindow(rec), ctx.nowMs);
  const { incidents, total } = await getIncidents(ctx.db, { fromMs, toMs });
  const truncated = total > incidents.length;
  return {
    incidents,
    count: incidents.length,
    total,
    truncated,
    ...(truncated ? { note: `showing ${incidents.length} of ${total} matching incidents` } : {}),
  };
}

/**
 * Dispatches one tool call to the matching `read.ts` function. Never throws: an unknown tool
 * name, malformed `input` (wrong types, missing required fields), an unparseable `window`
 * (`WindowError`), or a D1 error from the read layer are all caught here and turned into a plain
 * `{error: string}` object — same shape a model would get back as any other tool result, so a
 * single bad call degrades the investigation instead of crashing the loop.
 */
export async function executeTool(name: string, input: unknown, ctx: ExecuteToolCtx): Promise<object> {
  try {
    switch (name) {
      case "query_metrics":
        return await runQueryMetrics(input, ctx);
      case "search_logs":
        return await runSearchLogs(input, ctx);
      case "find_traces":
        return await runFindTraces(input, ctx);
      case "get_trace":
        return await runGetTrace(input, ctx);
      case "list_deploys":
        return await runListDeploys(input, ctx);
      case "get_incidents":
        return await runGetIncidents(input, ctx);
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    if (err instanceof WindowError) return { error: err.message };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
