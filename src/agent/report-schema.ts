/**
 * The investigator's report shape (spec §9's report rubric, mirrored 1:1 from `tools.ts`'s
 * `SUBMIT_REPORT` strict tool schema) plus two operations `InvestigatorDO` needs at submit time:
 * `validateReport` (defense in depth — `strict: true` on `SUBMIT_REPORT` already makes a
 * malformed shape an API-level impossibility per `tools.ts`'s own doc comment, but a scripted or
 * future non-Anthropic caller could still hand `runLoop` a malformed `report`, and this is the
 * last checkpoint before it becomes a permanent D1 row) and `embedEvidence` (spec §9: "evidence
 * payloads are embedded into report_json at submit time — reports stay fully viewable after raw
 * telemetry expires").
 */

import { getTrace } from "../telemetry/read";
import type { TraceView } from "../telemetry/types";

export interface ReportTimelineEntry {
  time: string;
  description: string;
}

export interface ReportRootCause {
  hypothesis: string;
  mechanism: string;
}

export interface ReportEvidenceEntry {
  description: string;
  trace_id: string | null;
  metric: string | null;
  log_excerpt: string | null;
  /** Populated by `embedEvidence` for every entry whose `trace_id` is non-null — the trace's
   * span-tree view at submit time, or `{error}` if the fetch itself failed (e.g. an already-aged-out
   * trace_id the model cited from memory of an earlier tool result). Absent until embedded. */
  embedded?: TraceView | { error: string };
}

export interface ReportBlastRadius {
  affected_services: string[];
  customer_impact: string;
}

export interface ReportConfidence {
  level: "low" | "medium" | "high";
  why: string;
}

export interface Report {
  summary: string;
  timeline: ReportTimelineEntry[];
  root_cause: ReportRootCause;
  evidence: ReportEvidenceEntry[];
  blast_radius: ReportBlastRadius;
  confidence: ReportConfidence;
  suggested_action: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(rec: Record<string, unknown>, field: string, path: string): string {
  const v = rec[field];
  if (typeof v !== "string") throw new Error(`report.${path} must be a string`);
  return v;
}

function requireStringOrNull(rec: Record<string, unknown>, field: string, path: string): string | null {
  const v = rec[field];
  if (v === null) return null;
  if (typeof v !== "string") throw new Error(`report.${path} must be a string or null`);
  return v;
}

/**
 * Structural validation of a `submit_report` tool-call's `input` against `SUBMIT_REPORT`'s shape
 * (`tools.ts`) — every field `strict: true` already requires the model to have supplied, checked
 * again here since `LoopResult.report` is typed `unknown` by the time it reaches `InvestigatorDO`.
 * Throws (rather than returning `null`) on the first structural problem found, so the caller's
 * catch site can fold the message straight into a `failed` incident's `failure_reason`.
 */
export function validateReport(input: unknown): Report {
  if (!isRecord(input)) throw new Error("report must be an object");

  const summary = requireString(input, "summary", "summary");

  if (!Array.isArray(input.timeline)) throw new Error("report.timeline must be an array");
  const timeline: ReportTimelineEntry[] = input.timeline.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`report.timeline[${i}] must be an object`);
    return {
      time: requireString(entry, "time", `timeline[${i}].time`),
      description: requireString(entry, "description", `timeline[${i}].description`),
    };
  });

  if (!isRecord(input.root_cause)) throw new Error("report.root_cause must be an object");
  const root_cause: ReportRootCause = {
    hypothesis: requireString(input.root_cause, "hypothesis", "root_cause.hypothesis"),
    mechanism: requireString(input.root_cause, "mechanism", "root_cause.mechanism"),
  };

  if (!Array.isArray(input.evidence)) throw new Error("report.evidence must be an array");
  const evidence: ReportEvidenceEntry[] = input.evidence.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`report.evidence[${i}] must be an object`);
    return {
      description: requireString(entry, "description", `evidence[${i}].description`),
      trace_id: requireStringOrNull(entry, "trace_id", `evidence[${i}].trace_id`),
      metric: requireStringOrNull(entry, "metric", `evidence[${i}].metric`),
      log_excerpt: requireStringOrNull(entry, "log_excerpt", `evidence[${i}].log_excerpt`),
    };
  });

  if (!isRecord(input.blast_radius)) throw new Error("report.blast_radius must be an object");
  const affectedServicesRaw = input.blast_radius.affected_services;
  if (!Array.isArray(affectedServicesRaw) || affectedServicesRaw.some((s) => typeof s !== "string")) {
    throw new Error("report.blast_radius.affected_services must be a string array");
  }
  const blast_radius: ReportBlastRadius = {
    affected_services: affectedServicesRaw as string[],
    customer_impact: requireString(input.blast_radius, "customer_impact", "blast_radius.customer_impact"),
  };

  if (!isRecord(input.confidence)) throw new Error("report.confidence must be an object");
  const level = input.confidence.level;
  if (level !== "low" && level !== "medium" && level !== "high") {
    throw new Error('report.confidence.level must be "low", "medium", or "high"');
  }
  const confidence: ReportConfidence = { level, why: requireString(input.confidence, "why", "confidence.why") };

  const suggested_action = requireString(input, "suggested_action", "suggested_action");

  return { summary, timeline, root_cause, evidence, blast_radius, confidence, suggested_action };
}

/**
 * Embeds a span-tree view for every `evidence` entry that cites a `trace_id`, fetched via the read
 * layer NOW (submit time) while the raw telemetry it references still exists — spec §9: "reports
 * stay fully viewable after raw telemetry expires (6h)". A fetch failure (unknown/already-expired
 * trace_id) embeds `{error}` on that entry rather than failing the whole report — one stale
 * citation must not discard an otherwise-complete investigation.
 *
 * Only `trace_id` is dereferenced — intended, not an omission: `metric` and `log_excerpt` are
 * inline model-authored text (the model pastes the delta/excerpt it saw straight into the
 * report), already self-contained with no external raw data left to fetch.
 */
export async function embedEvidence(db: D1Database, report: Report): Promise<Report> {
  const evidence = await Promise.all(
    report.evidence.map(async (entry): Promise<ReportEvidenceEntry> => {
      if (entry.trace_id === null) return entry;
      try {
        const embedded = await getTrace(db, entry.trace_id);
        return { ...entry, embedded };
      } catch (err) {
        return { ...entry, embedded: { error: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );
  return { ...report, evidence };
}
