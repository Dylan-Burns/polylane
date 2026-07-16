/**
 * `investigation_steps.content_json` (and `incidents.report_json`/`trigger_json`) are all typed
 * `unknown` by the time they reach the UI (spec/`telemetry/read.ts`'s own convention — parsed JSON,
 * not re-validated). The seeded incident (`sim/seed-incident.ts`) and a live investigation
 * (`agent/loop.ts`'s `record` calls) both write the same tool_call/tool_result shape —
 * `{tool_use_id, name, input}` / `{tool_use_id, name, output, is_error}` — so seeded and live steps
 * render identically. The `rec.tool` fallback below is a defensive leftover, not load-bearing for
 * either producer; every normalizer keeps it as a no-cost safety net against some future caller
 * that writes a nonstandard shape.
 */

import { isRecord, prettyJson } from "../../lib/format";
import type { Report } from "../../lib/types";

export interface NormalizedToolCall {
  name: string;
  input: unknown;
}

export function normalizeToolCall(content: unknown): NormalizedToolCall {
  const rec = isRecord(content) ? content : {};
  const name = typeof rec.name === "string" ? rec.name : typeof rec.tool === "string" ? rec.tool : "unknown_tool";
  return { name, input: rec.input };
}

export interface NormalizedToolResult {
  name: string;
  output: unknown;
  isError: boolean;
}

export function normalizeToolResult(content: unknown): NormalizedToolResult {
  const rec = isRecord(content) ? content : {};
  const name = typeof rec.name === "string" ? rec.name : typeof rec.tool === "string" ? rec.tool : "unknown_tool";
  return { name, output: rec.output, isError: rec.is_error === true };
}

/** `{text}` (most notes), `{update}` (live mid-loop status notes — `agent/loop.ts`'s
 * `record("note", { update })`), or `{note}` (the sweep's budget-deferred note and
 * `api/remediate.ts`'s operator-approval note). */
export function normalizeNote(content: unknown): string {
  const rec = isRecord(content) ? content : {};
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.update === "string") return rec.update;
  if (typeof rec.note === "string") return rec.note;
  return prettyJson(content);
}

export interface NormalizedError {
  message: string;
  stopReason?: string;
}

export function normalizeError(content: unknown): NormalizedError {
  const rec = isRecord(content) ? content : {};
  return {
    message: typeof rec.message === "string" ? rec.message : prettyJson(content),
    stopReason: typeof rec.stop_reason === "string" ? rec.stop_reason : undefined,
  };
}

/** A step's `content` for `kind: "report"` is the raw `submit_report` input (`Report`, pre-embed) —
 * pulls just the summary line for the compact timeline card; the rich render lives in the incident's
 * own (embedded) `report`, not this step. */
export function reportStepSummary(content: unknown): string | undefined {
  const rec = isRecord(content) ? content : {};
  return typeof rec.summary === "string" ? rec.summary : undefined;
}

/** Best-effort one-line summary of a tool_result's `output` — the live executor's shapes
 * (`agent/tools.ts`: `{points|logs|traces|deploys|incidents|spans, count, total, truncated, note}`),
 * which the seeded incident's tool results also match — falling back to a generic key-count
 * description. The `summary`/`logExcerpt` branches are a defensive leftover for any future caller
 * that isn't shaped like `agent/tools.ts`'s executors. The full JSON is always still reachable via
 * the caller's "show full result" disclosure, so this never needs to be exhaustive. */
export function summarizeToolOutput(output: unknown): string {
  if (!isRecord(output)) return prettyJson(output);
  if (typeof output.error === "string") return `error: ${output.error}`;
  if (typeof output.note === "string") return output.note;
  if (typeof output.summary === "string") return output.summary;
  if (typeof output.logExcerpt === "string") return output.logExcerpt;

  const arrayFields: [string, string][] = [
    ["points", "point"],
    ["logs", "log line"],
    ["traces", "trace"],
    ["deploys", "deploy"],
    ["incidents", "incident"],
    ["spans", "span"],
  ];
  const parts: string[] = [];
  for (const [key, noun] of arrayFields) {
    const value = output[key];
    if (Array.isArray(value)) parts.push(`${value.length} ${noun}${value.length === 1 ? "" : "s"}`);
  }
  if (typeof output.total === "number" && typeof output.count === "number" && output.total > output.count) {
    parts.push(`of ${output.total} total`);
  }
  if (output.truncated === true) parts.push("truncated");
  return parts.length > 0 ? parts.join(", ") : "result received";
}

/** Structural check that `incident.report` is a real submitted `Report` (spec §9 shape) rather
 * than one of the other things `report_json` can hold: `null` (no report yet) or `{failure_reason}`
 * (a `failed` incident — `investigator-do.ts`'s `finalizeFailed`/`api/chaos.ts`'s
 * `failActiveIncidents`). Deliberately structural, not a full re-validation like
 * `agent/report-schema.ts`'s `validateReport` (server-side, throws) — this just needs to decide
 * which of three render paths to take. */
export function isFullReport(report: unknown): report is Report {
  return (
    isRecord(report) &&
    typeof report.summary === "string" &&
    Array.isArray(report.timeline) &&
    isRecord(report.root_cause) &&
    Array.isArray(report.evidence) &&
    isRecord(report.blast_radius) &&
    isRecord(report.confidence) &&
    typeof report.suggested_action === "string"
  );
}

export function extractFailureReason(report: unknown): string | undefined {
  if (isRecord(report) && typeof report.failure_reason === "string") return report.failure_reason;
  return undefined;
}

/** The detection trigger's human-readable statement(s) — used as the incident feed's summary line
 * fallback before a report exists. Two persisted shapes reach the UI (same set chat-prompt.ts's
 * `triggerStatements` reads): the sweep's `buildTrigger` writes `{statements: string[], anomalies}`
 * for every live incident, and the seeded demo incident writes a singular `{statement}`. Missing
 * the array shape meant every live pre-report incident showed the generic placeholder instead of
 * the detector's own words. */
export function extractTriggerStatement(trigger: unknown): string | undefined {
  if (!isRecord(trigger)) return undefined;
  if (Array.isArray(trigger.statements)) {
    const statements = trigger.statements.filter((s): s is string => typeof s === "string");
    if (statements.length > 0) return statements.join(" | ");
  }
  return typeof trigger.statement === "string" ? trigger.statement : undefined;
}

/** The feed/detail summary line: the submitted report's own summary once one exists, else the
 * detection trigger's statement, else an honest "still working on it" placeholder — never blank. */
export function incidentSummaryLine(report: unknown, trigger: unknown): string {
  if (isFullReport(report)) return report.summary;
  const failure = extractFailureReason(report);
  if (failure) return `Investigation failed: ${failure}`;
  const statement = extractTriggerStatement(trigger);
  if (statement) return statement;
  return "Investigation in progress — no summary yet.";
}
