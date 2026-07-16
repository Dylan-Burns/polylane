/**
 * The ops stat row — four at-a-glance tiles (incident volume, median time-to-diagnosis, median
 * time-to-resolve, live traffic) above the dashboard grid, polling `GET /api/analytics` (mirrored
 * in `lib/types.ts`'s `AnalyticsResponse`). This is the "is the watchdog earning its keep" strip:
 * MTTD/MTTR are THE numbers an incident tool exists to shrink, so they get the same billing the
 * topology does.
 *
 * Stat tiles are deliberately plain (label / big number / one sub-line, no delta chips): the
 * medians have no comparison period to be honest about yet, and a fabricated up/down arrow would
 * be decoration pretending to be information. `null` from the API (no incidents yet, empty
 * rollups) renders as an em dash — absent data reads as absent, never as zero.
 */

import { getAnalytics } from "../lib/api";
import { formatDurationMs } from "../lib/format";
import { usePoll } from "../lib/poll";
import type { AnalyticsResponse } from "../lib/types";

const ANALYTICS_POLL_MS = 15_000;

interface TileProps {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  /** Tints the sub-line with the status vocabulary (e.g. a non-zero open-incident count). */
  subTone?: "red" | "amber";
}

function StatTile({ label, value, unit, sub, subTone }: TileProps) {
  const subColor = subTone === "red" ? "text-status-red" : subTone === "amber" ? "text-status-amber" : "text-ink-faint";
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-hairline bg-panel px-4 py-3">
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{label}</span>
      <span className="font-display text-2xl font-semibold tracking-tight text-ink">
        {value}
        {unit !== undefined && <span className="ml-1 text-sm font-normal text-ink-dim">{unit}</span>}
      </span>
      {sub !== undefined && <span className={`font-mono text-[11px] ${subColor}`}>{sub}</span>}
    </div>
  );
}

function duration(ms: number | null): string {
  return ms === null ? "—" : formatDurationMs(ms);
}

function tiles(data: AnalyticsResponse | undefined): TileProps[] {
  return [
    {
      label: "Incidents · 24h",
      value: data ? String(data.incidents24h) : "—",
      sub: data === undefined ? undefined : data.openNow > 0 ? `${data.openNow} open now` : "none open",
      subTone: data !== undefined && data.openNow > 0 ? "red" : undefined,
    },
    {
      label: "Time to diagnosis",
      value: duration(data?.timeToReportP50Ms ?? null),
      sub: "median · opened → reported · 7d",
    },
    {
      label: "Time to resolve",
      value: duration(data?.timeToResolveP50Ms ?? null),
      sub: "median · opened → resolved · 7d",
    },
    {
      label: "Traffic",
      value: data?.reqPerMin !== null && data?.reqPerMin !== undefined ? data.reqPerMin.toFixed(0) : "—",
      unit: "req/min",
      sub: data?.errorRatePct !== null && data?.errorRatePct !== undefined ? `err ${data.errorRatePct.toFixed(1)}%` : undefined,
      subTone: data?.errorRatePct !== null && data?.errorRatePct !== undefined && data.errorRatePct > 1 ? "red" : undefined,
    },
  ];
}

/** `active` gates polling exactly like the dashboard's own state/incidents polls — no requests
 * while the Chat view has the screen (see `App.tsx`'s polling comment). */
export function AnalyticsRow({ active }: { active: boolean }) {
  const { data } = usePoll(getAnalytics, active ? ANALYTICS_POLL_MS : null);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles(data).map((tile) => (
        <StatTile key={tile.label} {...tile} />
      ))}
    </div>
  );
}
