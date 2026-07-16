/**
 * The deploys rail — recent change events from `GET /api/deploys` (newest first), each correlated
 * against the incident list the dashboard already polls: a deploy whose version or id appears
 * inside an incident's report is flagged, red while that incident is still live ("suspected
 * cause") and quiet gray once it resolved ("named in report"). The match is a plain substring
 * check over the report JSON — exactly as strong as the evidence actually is (the investigator
 * names culprit deploys by version string in its root-cause text), and honestly no stronger:
 * there is no fabricated causality score behind the chip.
 *
 * Sits under the Chaos panel: chaos scenarios write real deploy rows (bad-deploy's regression
 * ships as `payments vN`), so triggering a fault visibly lands here seconds later — the rail is
 * how the "red-herring catalog deploy vs. actual culprit" detection story becomes visible.
 */

import { getDeploys } from "../lib/api";
import { relativeTime } from "../lib/format";
import { usePoll } from "../lib/poll";
import type { Deploy, IncidentView } from "../lib/types";

const DEPLOYS_POLL_MS = 30_000;

/** Show at most this many rows — the card is a rail, not a log browser; the mono footer says how
 * many more the window actually held. */
const MAX_ROWS = 8;

const LIVE_STATUSES = new Set(["open", "investigating", "reported"]);

type Correlation = { kind: "live"; incidentId: string } | { kind: "closed"; incidentId: string } | null;

/** A deploy can only plausibly relate to incidents it PRECEDED (within this lead window) or that
 * were still open when it shipped — without the time scope, "v1.8.3" in yesterday's report would
 * flag today's unrelated re-deploy of the same version (adversarial-review finding). */
const CORRELATION_LEAD_MS = 2 * 60 * 60_000;

/** First time-plausible incident whose report mentions this deploy (by version, then id) — live
 * incidents are checked before closed ones so an ongoing incident always wins the stronger chip.
 * Deliberately a plain substring check over the report JSON, labeled as exactly that ("named
 * in"): the chip claims the report *names* this deploy, not that the deploy was the cause — a
 * report exonerating a red-herring deploy by name still legitimately lights it up. */
function correlate(deploy: Deploy, incidents: IncidentView[]): Correlation {
  const mentions = (incident: IncidentView): boolean => {
    // Time-plausibility first: deploy shipped within the lead window before the incident opened,
    // or while the incident was still unresolved.
    const windowStart = incident.opened_at - CORRELATION_LEAD_MS;
    const windowEnd = incident.resolved_at ?? Number.POSITIVE_INFINITY;
    if (deploy.ts_ms < windowStart || deploy.ts_ms > windowEnd) return false;
    if (incident.report === null) return false;
    let json: string;
    try {
      json = JSON.stringify(incident.report);
    } catch {
      return false;
    }
    return json.includes(deploy.version) || json.includes(deploy.id);
  };
  const live = incidents.find((i) => LIVE_STATUSES.has(i.status) && mentions(i));
  if (live) return { kind: "live", incidentId: live.id };
  const closed = incidents.find((i) => !LIVE_STATUSES.has(i.status) && mentions(i));
  if (closed) return { kind: "closed", incidentId: closed.id };
  return null;
}

function CorrelationChip({ correlation }: { correlation: Correlation }) {
  if (correlation === null) return null;
  const title = `This deploy is named in incident ${correlation.incidentId}'s report`;
  if (correlation.kind === "live") {
    return (
      <span
        title={title}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-red/30 bg-status-red/5 px-2 py-0.5 font-mono text-[10px] text-status-red"
      >
        <span className="h-1 w-1 rounded-full bg-status-red" aria-hidden="true" />
        named in live incident
      </span>
    );
  }
  return (
    <span title={title} className="inline-flex shrink-0 items-center rounded-full border border-hairline px-2 py-0.5 font-mono text-[10px] text-ink-faint">
      named in report
    </span>
  );
}

function DeployRow({ deploy, correlation }: { deploy: Deploy; correlation: Correlation }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-hairline bg-panel px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-ink">
          {deploy.service} <span className="text-ink-dim">{deploy.version}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">{relativeTime(deploy.ts_ms)}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-ink-dim">{deploy.note}</span>
        <CorrelationChip correlation={correlation} />
      </div>
    </li>
  );
}

/** `incidents` comes from the dashboard's existing poll (no second fetch of the same data);
 * `active` gates this card's own deploys poll the same way every dashboard poll is gated. */
export function DeploysCard({ incidents, active }: { incidents: IncidentView[]; active: boolean }) {
  const { data, error } = usePoll(getDeploys, active ? DEPLOYS_POLL_MS : null);
  const deploys = data?.deploys ?? [];
  const shown = deploys.slice(0, MAX_ROWS);

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-hairline bg-panel/40 p-5">
      <header>
        <h2 className="font-display text-lg font-semibold tracking-tight text-ink">Deploys</h2>
        <p className="mt-1 text-xs text-ink-dim">Change events from the last day — the investigator's prime suspects.</p>
      </header>

      {error !== undefined && deploys.length === 0 && <p className="text-xs text-ink-dim">Couldn't load deploys.</p>}
      {error === undefined && data !== undefined && deploys.length === 0 && (
        <p className="text-xs text-ink-dim">No deploys in the last 24h — trigger a chaos scenario to ship one.</p>
      )}

      <ul className="flex flex-col gap-2">
        {shown.map((d) => (
          <DeployRow key={d.id} deploy={d} correlation={correlate(d, incidents)} />
        ))}
      </ul>

      {deploys.length > MAX_ROWS && (
        <p className="font-mono text-[10px] text-ink-faint">+{deploys.length - MAX_ROWS} more in the last 24h</p>
      )}
    </section>
  );
}
