/**
 * Evidence chips open this drawer. Crucially, it prefers `entry.embedded` — the span-tree view
 * `agent/report-schema.ts`'s `embedEvidence` already fetched and baked into `report_json` at
 * submit time — over a fresh `GET /api/traces/:id` call. That matters for real, not just as an
 * optimization: the seeded incident's evidence cites a `trace_id` that was never actually inserted
 * into `spans` (`sim/seed-incident.ts`'s own doc comment says so explicitly), so a live fetch for
 * it would 404. Reports are designed to "stay fully viewable after raw telemetry expires" — this
 * drawer only falls back to a live fetch when no embedded copy exists at all.
 */

import { useEffect, useState } from "react";
import { ApiError, getTrace } from "../../lib/api";
import { clockTime } from "../../lib/format";
import type { ReportEvidenceEntry, Span, TraceView } from "../../lib/types";

/** A 404 here means the raw trace has aged out of retention (or, for the seeded incident
 * specifically, was never a real trace to begin with — see this file's top doc comment); any other
 * failure is a genuine fetch problem. Distinct copy for each so the drawer never just parrots an
 * HTTP status code at the user. */
function describeTraceFetchError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return "This trace is no longer available — raw telemetry is retained for a limited window after an incident.";
  }
  return `Couldn't load this trace (${err instanceof Error ? err.message : String(err)}).`;
}

type TraceOrError = TraceView | { error: string };

function isTraceView(v: TraceOrError | null): v is TraceView {
  return v !== null && "spans" in v;
}

interface SpanNode {
  span: Span;
  children: SpanNode[];
}

function buildSpanTree(spans: Span[]): SpanNode[] {
  const bySpanId = new Map<string, SpanNode>(spans.map((s) => [s.span_id, { span: s, children: [] }]));
  const roots: SpanNode[] = [];
  for (const node of bySpanId.values()) {
    const parentId = node.span.parent_span_id;
    const parent = parentId !== null ? bySpanId.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function SpanRow({ node, depth }: { node: SpanNode; depth: number }) {
  const { span } = node;
  return (
    <>
      <div className="flex items-center gap-2 py-1 font-mono text-[11px]" style={{ paddingLeft: depth * 16 }}>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${span.status === "error" ? "bg-status-red" : "bg-status-green"}`}
          aria-hidden="true"
        />
        <span className="text-ink">
          {span.service}.{span.operation}
        </span>
        <span className="text-ink-faint">{span.duration_ms}ms</span>
        {span.error_type && <span className="text-status-red">{span.error_type}</span>}
      </div>
      {node.children.map((child) => (
        <SpanRow key={child.span.span_id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

export function TraceDrawer({ entry, onClose }: { entry: ReportEvidenceEntry | null; onClose: () => void }) {
  const [live, setLive] = useState<TraceOrError | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLive(null);
    if (!entry || entry.embedded !== undefined || !entry.trace_id) return;
    const traceId = entry.trace_id;
    setLoading(true);
    getTrace(traceId)
      .then((t) => setLive(t))
      .catch((err: unknown) => setLive({ error: describeTraceFetchError(err) }))
      .finally(() => setLoading(false));
  }, [entry]);

  useEffect(() => {
    if (!entry) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose]);

  if (!entry) return null;

  const trace: TraceOrError | null = entry.embedded ?? live;
  const roots = isTraceView(trace) ? buildSpanTree(trace.spans) : [];

  return (
    <div className="fixed inset-0 z-[80] flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Trace detail"
        className="relative flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-hairline bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-sm font-semibold text-ink">Trace</h3>
            {entry.trace_id && <p className="mt-0.5 break-all font-mono text-[11px] text-ink-faint">{entry.trace_id}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close trace drawer"
            className="shrink-0 rounded-full border border-hairline px-2 py-1 text-xs text-ink-dim hover:border-hairline-bright"
          >
            Close
          </button>
        </div>

        {loading && <p className="text-xs text-ink-dim">Loading trace…</p>}
        {!loading && trace === null && <p className="text-xs text-ink-dim">No trace data is available for this piece of evidence.</p>}
        {trace && !isTraceView(trace) && <p className="text-xs text-status-red">{trace.error}</p>}

        {isTraceView(trace) && (
          <>
            {trace.truncated && trace.note && (
              <p className="rounded-lg border border-status-amber/30 bg-status-amber/5 px-3 py-2 text-[11px] text-status-amber">
                {trace.note}
              </p>
            )}
            <section>
              <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Span tree</h4>
              <div className="mt-2 rounded-lg border border-hairline bg-panel-raised p-2">
                {roots.length === 0 ? (
                  <p className="p-1 text-xs text-ink-dim">No spans.</p>
                ) : (
                  roots.map((root) => <SpanRow key={root.span.span_id} node={root} depth={0} />)
                )}
              </div>
            </section>
            {trace.errorLogs.length > 0 && (
              <section>
                <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Error logs</h4>
                <div className="mt-2 flex flex-col gap-1">
                  {trace.errorLogs.map((log, i) => (
                    <p key={i} className="font-mono text-[11px] leading-relaxed text-ink-dim">
                      <span className="text-ink-faint">{clockTime(log.ts_ms)}</span> <span className="text-status-red">[{log.level}]</span>{" "}
                      <span className="text-ink">{log.service}</span>: {log.message}
                    </p>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
