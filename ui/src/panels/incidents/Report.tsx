import type { ReactNode } from "react";
import { prettyJson } from "../../lib/format";
import { CONFIDENCE_META } from "../../lib/status";
import type { Report, ReportEvidenceEntry, ReportTimelineEntry } from "../../lib/types";

/**
 * `isFullReport` (see `panels/incidents/normalize.ts`) only checks that `timeline`/`evidence` are
 * arrays of objects — it can't guarantee each entry's individual fields match `ReportTimelineEntry`/
 * `ReportEvidenceEntry` exactly. Both real producers (a live investigation's `submit_report` call
 * and the seeded incident, `sim/seed-incident.ts`) write this schema's actual `{time, description}`
 * / `{description, trace_id, metric, log_excerpt}` shapes (spec §9 / `agent/report-schema.ts`), so
 * the fallbacks below are defensive only — guarding against some future non-conforming producer,
 * not a known divergence. Rather than render blank text for a field that isn't actually a string,
 * these helpers fall back to a compact raw dump — the same "degrade honestly, never render
 * silence" convention the rest of this codebase uses for malformed persisted JSON.
 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timelineTime(entry: ReportTimelineEntry): string {
  return asString(entry.time) ?? "—";
}

function timelineDescription(entry: ReportTimelineEntry): string {
  return asString(entry.description) ?? prettyJson(entry);
}

function EvidenceChip({ entry, onOpen }: { entry: ReportEvidenceEntry; onOpen: (entry: ReportEvidenceEntry) => void }) {
  const clickable = entry.trace_id !== null && entry.trace_id !== undefined;
  const description = asString(entry.description) ?? prettyJson(entry);

  const inner = (
    <>
      <p className="text-ink-dim">{description}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-ink-faint">
        {entry.trace_id && <span className={clickable ? "text-signal-glow" : ""}>trace {entry.trace_id.slice(0, 12)}… →</span>}
        {entry.metric && <span>{entry.metric}</span>}
        {entry.log_excerpt && <span className="italic">&ldquo;{entry.log_excerpt}&rdquo;</span>}
      </div>
    </>
  );

  if (!clickable) {
    return <div className="flex flex-col gap-1 rounded-lg border border-hairline bg-panel px-3 py-2 text-left text-xs">{inner}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className="flex flex-col gap-1 rounded-lg border border-hairline bg-panel px-3 py-2 text-left text-xs transition-colors hover:border-hairline-bright hover:bg-panel-raised"
    >
      {inner}
    </button>
  );
}

/** `action` is the suggested-action section's optional call-to-action slot — the remediation
 * approval button (`Detail.tsx`'s `RemediateAction`) renders there so "what the agent suggests"
 * and "the one click that executes it" read as a single unit, exactly polylane.com's
 * suggestion→autofix pairing. This component stays presentation-only; the caller owns when an
 * action is offered at all. */
export function ReportView({
  report,
  onOpenEvidence,
  action,
}: {
  report: Report;
  onOpenEvidence: (entry: ReportEvidenceEntry) => void;
  action?: ReactNode;
}) {
  const confidence = CONFIDENCE_META[report.confidence.level];

  return (
    <div id="incident-report" className="flex scroll-mt-6 flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Report</h3>
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-panel-raised px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide"
          style={{ color: confidence.color }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: confidence.color }} aria-hidden="true" />
          {confidence.label}
        </span>
      </header>

      <p className="font-display text-lg leading-snug text-ink">{report.summary}</p>

      <section>
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Timeline</h4>
        <ol className="mt-2 flex flex-col gap-1.5">
          {report.timeline.map((entry, i) => (
            <li key={i} className="flex gap-3 text-xs">
              <span className="w-24 shrink-0 font-mono text-ink-faint">{timelineTime(entry)}</span>
              <span className="text-ink-dim">{timelineDescription(entry)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Root cause</h4>
        <p className="mt-1 text-sm font-medium text-ink">{report.root_cause.hypothesis}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">{report.root_cause.mechanism}</p>
      </section>

      <section>
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Evidence</h4>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {report.evidence.map((entry, i) => (
            <EvidenceChip key={i} entry={entry} onOpen={onOpenEvidence} />
          ))}
        </div>
      </section>

      <section>
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Blast radius</h4>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {report.blast_radius.affected_services.map((s) => (
            <span key={s} className="rounded-full border border-hairline bg-panel-raised px-2 py-0.5 font-mono text-[11px] text-ink-dim">
              {s}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-dim">{report.blast_radius.customer_impact}</p>
      </section>

      <section className="rounded-lg border border-signal/30 bg-signal/5 px-4 py-3">
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-signal-glow">Suggested action</h4>
        <p className="mt-1 text-sm text-ink">{report.suggested_action}</p>
        {action}
      </section>

      <p className="text-[11px] text-ink-faint">{report.confidence.why}</p>
    </div>
  );
}
