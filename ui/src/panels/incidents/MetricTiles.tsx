/**
 * Metric evidence tiles for the incident modal — one tile per triggering anomaly (capped at 3
 * server-side), each showing the metric's worst value in the incident window, how many × its
 * MAD baseline that is, and a small area chart of the whole window. Data comes from
 * `GET /api/incidents/:id/metrics` (mirrored as `lib/types.ts`'s `IncidentMetricsResponse`),
 * which derives everything from the same rollups + baselines the detector alerted on — the tiles
 * are the detection math made visible, not a second opinion.
 *
 * The delta chip reads "×N baseline" (a ratio) rather than a σ z-score because ratios ARE this
 * system's detection vocabulary (spec §8's rules: "req_rate >= 4x baseline"); showing σ would
 * invent a statistic no other part of the pipeline uses.
 *
 * Charts are hand-rolled SVG (spec §11: no chart libraries), area-filled in the status color the
 * metric class belongs to: error rate wears status-red and p95 status-amber (bad-news metrics in
 * the health vocabulary), request rate wears the neutral signal ink — traffic volume isn't a
 * health judgement.
 */

import { getIncidentMetrics } from "../../lib/api";
import { usePoll } from "../../lib/poll";
import type { IncidentMetricTile } from "../../lib/types";

/** Refresh while the incident is still live (the window end tracks `now` until resolve); a single
 * fetch suffices once it's closed — `usePoll(fn, null)` is exactly that one-shot. */
const LIVE_METRICS_POLL_MS = 10_000;

const METRIC_LABEL: Record<IncidentMetricTile["metricClass"], string> = {
  req_rate: "request rate",
  error_rate: "error rate",
  p95: "p95 latency",
};

const METRIC_COLOR: Record<IncidentMetricTile["metricClass"], string> = {
  req_rate: "var(--color-signal)",
  error_rate: "var(--color-status-red)",
  p95: "var(--color-status-amber)",
};

function formatValue(value: number, unit: IncidentMetricTile["unit"]): { value: string; unit: string } {
  switch (unit) {
    case "per_min":
      return { value: value.toFixed(0), unit: "/min" };
    case "pct":
      return { value: value.toFixed(1), unit: "%" };
    case "ms":
      return { value: value.toFixed(0), unit: "ms" };
  }
}

/** The area chart: normalized to the tile's own [0, max] range (zero-anchored so a flat healthy
 * baseline reads as flat, not as dramatic noise), drawn with `preserveAspectRatio="none"` so one
 * viewBox stretches to the tile width. A single point degrades to a dot. */
function AreaChart({ tile }: { tile: IncidentMetricTile }) {
  const W = 100;
  const H = 32;
  const points = tile.points;
  const color = METRIC_COLOR[tile.metricClass];

  if (points.length === 0) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-10 w-full" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1={H - 1} x2={W} y2={H - 1} stroke="var(--color-hairline-bright)" strokeWidth="1" strokeDasharray="2 3" />
      </svg>
    );
  }

  const max = Math.max(...points.map((p) => p.value), 1e-9);
  const stepX = points.length > 1 ? W / (points.length - 1) : 0;
  const xy = points.map((p, i) => {
    const x = points.length > 1 ? i * stepX : W / 2;
    const y = H - 2 - (p.value / max) * (H - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  if (points.length === 1) {
    const [only] = xy;
    const [cx = "50", cy = "16"] = (only ?? "").split(",");
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-10 w-full" preserveAspectRatio="none" aria-hidden="true">
        <circle cx={cx} cy={cy} r="1.8" fill={color} />
      </svg>
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-10 w-full" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,${H} ${xy.join(" ")} ${W},${H}`} fill={color} opacity="0.12" />
      <polyline points={xy.join(" ")} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Tile({ tile }: { tile: IncidentMetricTile }) {
  const peak = formatValue(tile.peak, tile.unit);
  const showRatio = tile.ratio !== null && tile.ratio >= 1.05; // a ~1× ratio is noise, not evidence
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-hairline bg-panel px-3 py-2.5">
      <span className="truncate font-mono text-[10px] uppercase tracking-wider text-ink-faint">
        {tile.service} · {METRIC_LABEL[tile.metricClass]}
      </span>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-xl font-semibold tracking-tight text-ink">
          {peak.value}
          <span className="ml-0.5 text-xs font-normal text-ink-dim">{peak.unit}</span>
        </span>
        {showRatio && (
          <span
            className="inline-flex items-center rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium"
            style={{ color: METRIC_COLOR[tile.metricClass], backgroundColor: "color-mix(in srgb, currentColor 10%, transparent)" }}
          >
            ▲ ×{tile.ratio !== null && tile.ratio >= 10 ? tile.ratio.toFixed(0) : (tile.ratio ?? 0).toFixed(1)} baseline
          </span>
        )}
      </div>
      <AreaChart tile={tile} />
    </div>
  );
}

/** Renders nothing (no header, no empty frame) when the incident produced no usable tiles — a
 * malformed trigger degrades to the modal simply not having this section, per the "degrade
 * honestly, never render silence" convention. */
export function MetricTiles({ incidentId, live }: { incidentId: string; live: boolean }) {
  const { data } = usePoll(() => getIncidentMetrics(incidentId), live ? LIVE_METRICS_POLL_MS : null);
  if (data === undefined || data.tiles.length === 0) return null;

  return (
    <section className="mb-5">
      <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Metrics at incident time</h4>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {data.tiles.map((tile) => (
          <Tile key={`${tile.service}:${tile.metricClass}`} tile={tile} />
        ))}
      </div>
    </section>
  );
}
