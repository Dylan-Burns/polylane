import { relativeTime } from "../../lib/format";
import { INCIDENT_STATUS_META } from "../../lib/status";
import type { IncidentView, WorldStatus } from "../../lib/types";
import { incidentSummaryLine } from "./normalize";

function EmptyState({ worldStatus }: { worldStatus: WorldStatus }) {
  if (worldStatus !== "running") {
    return (
      <p className="rounded-xl border border-dashed border-hairline px-4 py-6 text-center text-xs text-ink-dim">
        {worldStatus === "unseeded"
          ? "The world hasn't been seeded yet — the historical incident will appear here once it has."
          : "The world is still seeding — the historical incident will appear here in a moment."}
      </p>
    );
  }
  return (
    <p className="rounded-xl border border-dashed border-hairline px-4 py-6 text-center text-xs text-ink-dim">
      No incidents yet. Trigger a scenario from the chaos panel to see the watchdog notice one.
    </p>
  );
}

function IncidentRow({ incident, onSelect }: { incident: IncidentView; onSelect: (id: string) => void }) {
  const meta = INCIDENT_STATUS_META[incident.status];
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(incident.id)}
        className="flex w-full flex-col gap-1.5 rounded-xl border border-hairline bg-panel px-4 py-3 text-left transition-colors hover:border-hairline-bright hover:bg-panel-raised"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-panel-raised px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide"
            style={{ color: meta.color }}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${meta.pulse ? "animate-scan-pulse" : ""}`} style={{ backgroundColor: meta.color }} aria-hidden="true" />
            {meta.label}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{incident.severity}</span>
          <span className="ml-auto font-mono text-[10px] text-ink-faint">{relativeTime(incident.opened_at)}</span>
        </div>
        <p className="text-sm text-ink">{incidentSummaryLine(incident.report, incident.trigger)}</p>
        {incident.fingerprints.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {incident.fingerprints.map((fp) => (
              <span key={fp} className="rounded-full bg-panel-raised px-2 py-0.5 font-mono text-[10px] text-ink-faint">
                {fp}
              </span>
            ))}
          </div>
        )}
      </button>
    </li>
  );
}

export function IncidentsFeed({
  incidents,
  worldStatus,
  onSelect,
}: {
  incidents: IncidentView[];
  worldStatus: WorldStatus;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-hairline bg-panel/40 p-5">
      <header>
        <h2 className="font-display text-lg font-semibold tracking-tight text-ink">Incidents</h2>
        <p className="mt-1 text-xs text-ink-dim">Recent first. Open one to watch the investigation.</p>
      </header>
      {incidents.length === 0 ? (
        <EmptyState worldStatus={worldStatus} />
      ) : (
        <ol className="flex flex-col gap-2.5">
          {incidents.map((incident) => (
            <IncidentRow key={incident.id} incident={incident} onSelect={onSelect} />
          ))}
        </ol>
      )}
    </section>
  );
}
