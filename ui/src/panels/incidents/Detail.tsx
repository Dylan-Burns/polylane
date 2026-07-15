/**
 * The incident detail modal: live timeline while `investigating`, the rich report once one exists.
 * Polls `GET /api/incidents/:id` at 2s while `status === "investigating"` (spec: "poll at 2s during
 * investigation") and stops once it isn't — new steps only ever land during that window, so there's
 * nothing left to catch by continuing to poll once it's reported/resolved/failed.
 */

import { useEffect, useState } from "react";
import { getIncidentDetail } from "../../lib/api";
import { clockTime, relativeTime } from "../../lib/format";
import { usePoll } from "../../lib/poll";
import { INCIDENT_STATUS_META } from "../../lib/status";
import type { IncidentDetailResponse, ReportEvidenceEntry } from "../../lib/types";
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

function DetailBody({ detail }: { detail: IncidentDetailResponse }) {
  const [evidenceEntry, setEvidenceEntry] = useState<ReportEvidenceEntry | null>(null);
  const { incident, steps } = detail;
  const investigating = incident.status === "investigating";
  const failureReason = extractFailureReason(incident.report);

  return (
    <>
      <Timeline steps={steps} openedAtMs={incident.opened_at} investigating={investigating} />

      {incident.status === "failed" && failureReason && (
        <section className="mt-6 rounded-lg border border-status-red/30 bg-status-red/5 px-4 py-3">
          <h4 className="font-mono text-[11px] uppercase tracking-wide text-status-red">Investigation failed</h4>
          <p className="mt-1 text-sm text-ink">{failureReason}</p>
        </section>
      )}

      {isFullReport(incident.report) && (
        <div className="mt-6 border-t border-hairline pt-5">
          <ReportView report={incident.report} onOpenEvidence={setEvidenceEntry} />
        </div>
      )}

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
  const { data, error } = usePoll(() => getIncidentDetail(incidentId), interval);

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
            className="shrink-0 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-ink-dim hover:border-hairline-bright"
          >
            Close
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {error !== undefined && data === undefined && (
            <p className="text-sm text-status-red">Couldn't load this incident. It may have been reset — try closing and reopening it.</p>
          )}
          {data === undefined && error === undefined && <p className="text-sm text-ink-dim">Loading incident…</p>}
          {data && <DetailBody detail={data} />}
        </div>
      </div>
    </div>
  );
}
