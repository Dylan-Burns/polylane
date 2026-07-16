/**
 * The incident detail modal: live timeline while `investigating`, the rich report once one exists.
 * Polls `GET /api/incidents/:id` at 2s while `status === "investigating"` (spec: "poll at 2s during
 * investigation") and stops once it isn't — new steps only ever land during that window, so there's
 * nothing left to catch by continuing to poll once it's reported/resolved/failed.
 */

import { useEffect, useState } from "react";
import { getIncidentDetail, remediateIncident } from "../../lib/api";
import { clockTime, relativeTime } from "../../lib/format";
import { usePoll } from "../../lib/poll";
import { INCIDENT_STATUS_META } from "../../lib/status";
import { useToast } from "../../lib/toast";
import type { IncidentDetailResponse, ReportEvidenceEntry } from "../../lib/types";
import { DigDeeper } from "./DigDeeper";
import { MetricTiles } from "./MetricTiles";
import { extractFailureReason, extractTriggerStatement, isFullReport } from "./normalize";
import { ReportView } from "./Report";
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

function DetailBody({ detail, onRemediated }: { detail: IncidentDetailResponse; onRemediated: () => void }) {
  const [evidenceEntry, setEvidenceEntry] = useState<ReportEvidenceEntry | null>(null);
  const { incident, steps } = detail;
  const investigating = incident.status === "investigating";
  const live = incident.status !== "resolved" && incident.status !== "failed";
  const failureReason = extractFailureReason(incident.report);

  return (
    <>
      <MetricTiles incidentId={incident.id} live={live} />

      <Timeline steps={steps} openedAtMs={incident.opened_at} investigating={investigating} />

      {incident.status === "failed" && failureReason && (
        <section className="mt-6 rounded-lg border border-status-red/30 bg-status-red/5 px-4 py-3">
          <h4 className="font-mono text-[11px] uppercase tracking-wide text-status-red">Investigation failed</h4>
          <p className="mt-1 text-sm text-ink">{failureReason}</p>
        </section>
      )}

      {isFullReport(incident.report) && (
        <div className="mt-6 border-t border-hairline pt-5">
          <ReportView
            report={incident.report}
            onOpenEvidence={setEvidenceEntry}
            action={incident.status === "reported" ? <RemediateAction incidentId={incident.id} onApplied={onRemediated} /> : undefined}
          />
        </div>
      )}

      <DigDeeper incidentId={incident.id} />

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
