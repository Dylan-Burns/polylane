/**
 * The incident detail modal: live timeline while `investigating`, the rich report once one exists.
 * Polls `GET /api/incidents/:id` at 2s while `status === "investigating"` (spec: "poll at 2s during
 * investigation") and stops once it isn't — new steps only ever land during that window, so there's
 * nothing left to catch by continuing to poll once it's reported/resolved/failed.
 *
 * Body is a six-tab layout (plan Table 8: Overview | Metrics | Logs | Traces | Timeline |
 * Properties) — a segmented-control tab bar (styling copied from `System.tsx`'s `ViewToggle`, not
 * imported: that component isn't exported and lives in another cluster's file) switches which panel
 * renders below it. Only the active tab's content mounts, so live-polling children (`MetricTiles`,
 * `LogsTab`'s lazy fetch) never run for a hidden tab. `TraceDrawer` and `DigDeeper` stay mounted
 * across every tab (evidence chips in the Traces tab open the same drawer Overview's would).
 */

import { useEffect, useState } from "react";
import { getIncidentDetail, getState, remediateIncident } from "../../lib/api";
import { clockTime, relativeTime } from "../../lib/format";
import { KIND_META } from "../../lib/kinds";
import { usePoll } from "../../lib/poll";
import { CONFIDENCE_META, INCIDENT_STATUS_META } from "../../lib/status";
import { useToast } from "../../lib/toast";
import type { IncidentDetailResponse, IncidentView, Report, ReportEvidenceEntry, ServiceKind, StepView } from "../../lib/types";
import { DigDeeper } from "./DigDeeper";
import { LogsTab } from "./LogsTab";
import { MetricTiles } from "./MetricTiles";
import { extractFailureReason, extractTriggerStatement, isFullReport } from "./normalize";
import { PropertiesTab } from "./Properties";
import { Timeline } from "./Timeline";
import { TraceDrawer } from "./TraceDrawer";

const LIVE_POLL_MS = 2000;

function Timestamp({ label, ms }: { label: string; ms: number | null }) {
  if (ms === null) return null;
  return (
    <span className="font-mono text-[11px] text-ink-faint">
      {label} {clockTime(ms)} ({relativeTime(ms)})
    </span>
  );
}

/** The one-click approval for the report's suggested action (spec-wise: the agent only ever
 * SUGGESTS; this button is the human approving it — see `src/api/remediate.ts`). Offered only
 * while the incident is `reported`: before that there's no report to act on, and after resolve
 * there's nothing left to fix. Every rejection the server can produce (no active fault, already
 * closed, cooldown) is an expected outcome surfaced as a toast, mirroring the chaos panel's
 * result-toast convention. `onApplied` lets the modal force an immediate detail re-poll so the
 * remediation note lands in the timeline without waiting a full poll cycle. */
function RemediateAction({ incidentId, onApplied }: { incidentId: string; onApplied: () => void }) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [applied, setApplied] = useState(false);

  async function approve() {
    setPending(true);
    let result: Awaited<ReturnType<typeof remediateIncident>>;
    try {
      // remediateIncident maps every HTTP status to a result, but the fetch itself can still
      // reject (network drop) — without the finally the button would wedge on "Applying…".
      result = await remediateIncident(incidentId);
    } catch {
      result = { kind: "error", status: 0, message: "couldn't reach Watchtower" };
    } finally {
      setPending(false);
    }
    switch (result.kind) {
      case "ok":
        setApplied(true);
        toast.push("info", "Remediation applied — rolled back; watching for recovery.");
        onApplied();
        return;
      case "rejected":
        toast.push("warning", result.message);
        break;
      case "cooldown":
        toast.push("warning", `Remediation is on a cooldown — try again in ${Math.ceil(result.retryAfterMs / 1000)}s.`);
        break;
      case "error":
        toast.push("error", `Remediation didn't go through (${result.message}).`);
        break;
    }
  }

  if (applied) {
    return <p className="mt-2.5 font-mono text-[11px] text-status-green">✓ Remediation applied — recovery usually shows within a couple of minutes.</p>;
  }

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => void approve()}
        className="rounded-full bg-signal px-3.5 py-1.5 font-sans text-xs font-medium text-void transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Applying…" : "Approve & apply"}
      </button>
      <span className="text-[11px] text-ink-faint">Rolls back the offending change. The watchdog keeps watching either way.</span>
    </div>
  );
}

// --- Tab bar ---------------------------------------------------------------------------------

type TabId = "overview" | "metrics" | "logs" | "traces" | "timeline" | "properties";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "metrics", label: "Metrics" },
  { id: "logs", label: "Logs" },
  { id: "traces", label: "Traces" },
  { id: "timeline", label: "Timeline" },
  { id: "properties", label: "Properties" },
];

/** Segmented-control tab bar, classes copied from `System.tsx`'s `ViewToggle` (not imported — that
 * component belongs to another cluster's file). Wrapped in its own `overflow-x-auto` so all six
 * tabs stay reachable by horizontal scroll at mobile widths without wrapping or shrinking labels. */
function DetailTabBar({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  return (
    <div className="overflow-x-auto">
      <div role="tablist" aria-label="Incident detail sections" className="flex w-max items-center gap-0.5 rounded-full bg-panel-raised p-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`incident-tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`incident-tabpanel-${t.id}`}
            onClick={() => onChange(t.id)}
            className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 font-sans text-xs font-medium transition-colors ${
              active === t.id ? "border border-hairline bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Shared derivations ------------------------------------------------------------------------

/** One-shot (`usePoll(fn, null)`) fetch of `/api/state`'s topology, reduced to a name→kind lookup —
 * the "simplest correct" fallback the plan calls for when no kinds map is threaded down from a
 * parent panel: the modal only ever opens on demand, so one extra state fetch per open is cheap and
 * self-contained, and it never competes with `App.tsx`'s own 5s poll. */
function useServiceKinds(): Record<string, ServiceKind> {
  const { data } = usePoll(getState, null);
  const map: Record<string, ServiceKind> = {};
  for (const node of data?.topology.services ?? []) map[node.name] = node.kind;
  return map;
}

/** The incident's headline service: the first fingerprint's service segment (fingerprints are
 * `service:metricClass`, `detect/rules.ts`), falling back to the report's own blast radius once one
 * exists. `undefined` when neither is available — the resource header simply omits itself then. */
function primaryService(incident: IncidentView): string | undefined {
  const fp = incident.fingerprints[0];
  if (fp) return fp.split(":")[0] || fp;
  if (isFullReport(incident.report)) return incident.report.blast_radius.affected_services[0];
  return undefined;
}

function ResourceHeader({ service, kind }: { service: string | undefined; kind: ServiceKind | undefined }) {
  if (!service) return null;
  const meta = kind ? KIND_META[kind] : undefined;
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-hairline bg-panel-raised px-3.5 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel text-ink-dim" aria-hidden="true">
        {meta ? meta.icon : <span className="h-2 w-2 rounded-full bg-ink-faint" />}
      </span>
      <div className="flex flex-col">
        <span className="font-mono text-sm text-ink">{service}</span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{meta ? meta.label : "Unknown service kind"}</span>
      </div>
    </div>
  );
}

// --- Tabs ----------------------------------------------------------------------------------

function OverviewTab({
  incident,
  kinds,
  onRemediated,
}: {
  incident: IncidentView;
  kinds: Record<string, ServiceKind>;
  onRemediated: () => void;
}) {
  const service = primaryService(incident);
  const failureReason = extractFailureReason(incident.report);
  const triggerStatement = extractTriggerStatement(incident.trigger);
  const report = isFullReport(incident.report) ? incident.report : null;
  const live = incident.status !== "resolved" && incident.status !== "failed";

  return (
    <div className="flex flex-col gap-5">
      <ResourceHeader service={service} kind={service ? kinds[service] : undefined} />

      {incident.status === "failed" && failureReason && (
        <section className="rounded-lg border border-status-red/30 bg-status-red/5 px-4 py-3">
          <h4 className="font-mono text-[11px] uppercase tracking-wide text-status-red">Investigation failed</h4>
          <p className="mt-1 text-sm text-ink">{failureReason}</p>
        </section>
      )}

      {report && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-display text-lg leading-snug text-ink">{report.summary}</p>
          <span
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-panel-raised px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide"
            style={{ color: CONFIDENCE_META[report.confidence.level].color }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: CONFIDENCE_META[report.confidence.level].color }}
              aria-hidden="true"
            />
            {CONFIDENCE_META[report.confidence.level].label}
          </span>
        </div>
      )}
      {!report && incident.status !== "failed" && (
        <p className="text-sm text-ink-dim">{triggerStatement ?? "Investigation in progress — no summary yet."}</p>
      )}

      <MetricTiles incidentId={incident.id} live={live} />

      {report && (
        <>
          <section>
            <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Root cause</h4>
            <p className="mt-1 text-sm font-medium text-ink">{report.root_cause.hypothesis}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-dim">{report.root_cause.mechanism}</p>
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
            {incident.status === "reported" && <RemediateAction incidentId={incident.id} onApplied={onRemediated} />}
          </section>

          <p className="text-[11px] text-ink-faint">{report.confidence.why}</p>
        </>
      )}
    </div>
  );
}

/** Evidence with neither a `trace_id` nor a `log_excerpt` — metric-only citations (a valid shape
 * per `agent/report-schema.ts`) that Logs (log_excerpt) and this tab's trace grid (trace_id) would
 * otherwise both skip. Rendered here, non-clickable (no drawer content to open), so nothing the
 * model cited silently disappears from the modal. */
function OtherEvidenceCard({ entry }: { entry: ReportEvidenceEntry }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-hairline bg-panel px-3 py-2 text-xs">
      <p className="text-ink-dim">{entry.description}</p>
      {entry.metric && <span className="font-mono text-[10px] text-ink-faint">{entry.metric}</span>}
    </div>
  );
}

function TracesTab({ report, onOpenEvidence }: { report: Report | null; onOpenEvidence: (entry: ReportEvidenceEntry) => void }) {
  const evidence = report?.evidence ?? [];
  const traceEvidence = evidence.filter((e) => e.trace_id !== null && e.trace_id !== undefined);
  const otherEvidence = evidence.filter(
    (e) => (e.trace_id === null || e.trace_id === undefined) && (e.log_excerpt === null || e.log_excerpt === undefined),
  );

  if (traceEvidence.length === 0 && otherEvidence.length === 0) {
    return (
      <p className="text-xs text-ink-dim">
        {report ? "No trace evidence was cited in the report." : "Traces will appear once the investigation reports its evidence."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {traceEvidence.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {traceEvidence.map((entry, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onOpenEvidence(entry)}
              className="flex flex-col gap-1 rounded-lg border border-hairline bg-panel px-3 py-2 text-left text-xs transition-colors hover:border-hairline-bright hover:bg-panel-raised"
            >
              <p className="text-ink-dim">{entry.description}</p>
              <span className="font-mono text-[10px] text-signal-glow">trace {entry.trace_id?.slice(0, 12)}… →</span>
              {entry.metric && <span className="font-mono text-[10px] text-ink-faint">{entry.metric}</span>}
            </button>
          ))}
        </div>
      )}

      {otherEvidence.length > 0 && (
        <section>
          <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Other evidence</h4>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {otherEvidence.map((entry, i) => (
              <OtherEvidenceCard key={i} entry={entry} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function TimelineTab({
  report,
  steps,
  openedAtMs,
  investigating,
}: {
  report: Report | null;
  steps: StepView[];
  openedAtMs: number;
  investigating: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      {report && report.timeline.length > 0 && (
        <section>
          <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Reported timeline</h4>
          <ol className="mt-2 flex flex-col gap-1.5">
            {report.timeline.map((entry, i) => (
              <li key={i} className="flex gap-3 text-xs">
                <span className="w-24 shrink-0 font-mono text-ink-faint">{entry.time || "—"}</span>
                <span className="text-ink-dim">{entry.description}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <Timeline steps={steps} openedAtMs={openedAtMs} investigating={investigating} />
    </div>
  );
}

function DetailBody({ detail, onRemediated }: { detail: IncidentDetailResponse; onRemediated: () => void }) {
  const [evidenceEntry, setEvidenceEntry] = useState<ReportEvidenceEntry | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const kinds = useServiceKinds();
  const { incident, steps } = detail;
  const investigating = incident.status === "investigating";
  const live = incident.status !== "resolved" && incident.status !== "failed";
  const report = isFullReport(incident.report) ? incident.report : null;

  return (
    <>
      <DetailTabBar active={activeTab} onChange={setActiveTab} />

      <div role="tabpanel" id={`incident-tabpanel-${activeTab}`} aria-labelledby={`incident-tab-${activeTab}`} className="mt-4">
        {activeTab === "overview" && <OverviewTab incident={incident} kinds={kinds} onRemediated={onRemediated} />}
        {activeTab === "metrics" && <MetricTiles incidentId={incident.id} live={live} />}
        {activeTab === "logs" && <LogsTab incidentId={incident.id} evidence={report?.evidence ?? []} />}
        {activeTab === "traces" && <TracesTab report={report} onOpenEvidence={setEvidenceEntry} />}
        {activeTab === "timeline" && (
          <TimelineTab report={report} steps={steps} openedAtMs={incident.opened_at} investigating={investigating} />
        )}
        {activeTab === "properties" && <PropertiesTab incident={incident} steps={steps} />}
      </div>

      <div className="mt-6 border-t border-hairline pt-5">
        <DigDeeper incidentId={incident.id} />
      </div>

      <TraceDrawer entry={evidenceEntry} onClose={() => setEvidenceEntry(null)} />
    </>
  );
}

export function IncidentDetailModal({ incidentId, onClose }: { incidentId: string; onClose: () => void }) {
  // Starts optimistic (assume live) so a freshly-opened incident polls right away; once the first
  // response lands, tracks the real status. Polling stops only on the TRUE terminal states
  // (resolved | failed) — "reported" is not terminal: auto-resolve flips reported→resolved from
  // the cron sweep minutes later with no new step row, and an open modal must show that heal live.
  const [knownStatus, setKnownStatus] = useState<string | null>(null);
  const interval = knownStatus === "resolved" || knownStatus === "failed" ? null : LIVE_POLL_MS;
  const { data, error, refresh } = usePoll(() => getIncidentDetail(incidentId), interval);

  useEffect(() => {
    if (data) setKnownStatus(data.incident.status);
  }, [data]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const statusMeta = data ? INCIDENT_STATUS_META[data.incident.status] : null;
  const triggerStatement = data ? extractTriggerStatement(data.incident.trigger) : undefined;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Incident detail"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {statusMeta && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-panel-raised px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide"
                  style={{ color: statusMeta.color }}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${statusMeta.pulse ? "animate-scan-pulse" : ""}`}
                    style={{ backgroundColor: statusMeta.color }}
                    aria-hidden="true"
                  />
                  {statusMeta.label}
                </span>
              )}
              {data && (
                <span className="rounded-full border border-hairline bg-panel-raised px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-ink-dim">
                  {data.incident.severity}
                </span>
              )}
            </div>
            {data && (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                <Timestamp label="opened" ms={data.incident.opened_at} />
                <Timestamp label="reported" ms={data.incident.reported_at} />
                <Timestamp label="resolved" ms={data.incident.resolved_at} />
              </div>
            )}
            {triggerStatement && <p className="max-w-xl text-xs text-ink-dim">{triggerStatement}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close incident detail"
            className="shrink-0 rounded-full border border-hairline px-2.5 py-1.5 text-xs text-ink-dim hover:border-hairline-bright"
          >
            Close
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {error !== undefined && data === undefined && (
            <p className="text-sm text-status-red">Couldn't load this incident. It may have been reset — try closing and reopening it.</p>
          )}
          {data === undefined && error === undefined && <p className="text-sm text-ink-dim">Loading incident…</p>}
          {data && <DetailBody detail={data} onRemediated={refresh} />}
        </div>
      </div>
    </div>
  );
}
