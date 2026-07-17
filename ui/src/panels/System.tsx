/**
 * Area 1 (spec §11): the six-node service topology with live health coloring and per-service
 * sparklines, the "watchdog scanning…" indicator, and the world-status banner. Fixed-layout SVG —
 * node positions are hand-placed to match `sim/topology.ts`'s own diagram (edge-gateway ->
 * checkout-edge -> payments-api -> ledger-db; checkout-edge -> notify -> email-api; edge-gateway ->
 * catalog-kv), not force-directed — and every edge actually drawn comes from `state.topology.edges`,
 * never hardcoded, so this stays correct if the topology ever changes.
 */

import { useState, type ReactNode } from "react";
import { SCENARIOS } from "../../../src/sim/scenarios";
import { Sparkline } from "../components/Sparkline";
import { relativeTime } from "../lib/format";
import { KIND_META } from "../lib/kinds";
import { HEALTH_COLOR, HEALTH_LABEL } from "../lib/status";
import { storageGet, storageSet } from "../lib/storage";
import type { IncidentView, OpsHealth, SparklinePoint, StateResponse, TopologyServiceNode, WorldStatusView } from "../lib/types";
import { GalaxyView, type GalaxyServiceStat } from "./system/Galaxy";

interface NodePos {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Hand-placed positions mirroring `sim/topology.ts`'s own ASCII diagram — three tiers,
 * edge-gateway on the left fanning out to its two branches. */
/** Card heights are +20 over the pre-typed-grid baseline to fit the new kind-sublabel row (added
 * uniformly so `edgePath`'s vertical-center math — which derives straight from these positions —
 * keeps every curve landing on the right edge). */
const NODE_POSITIONS: Record<string, NodePos> = {
  "edge-gateway": { x: 20, y: 115, w: 150, h: 128 },
  "checkout-edge": { x: 224, y: 16, w: 150, h: 128 },
  "catalog-kv": { x: 224, y: 216, w: 150, h: 128 },
  "payments-api": { x: 428, y: 16, w: 150, h: 128 },
  notify: { x: 428, y: 216, w: 150, h: 128 },
  "ledger-db": { x: 632, y: 16, w: 150, h: 128 },
  "email-api": { x: 632, y: 232, w: 150, h: 96 },
};
const VIEWBOX_W = 802;
const VIEWBOX_H = 360;

const SPARKLINE_SLOTS = 30;
const MINUTE_MS = 60_000;

function alignSlots(points: SparklinePoint[] | undefined, latestMinuteTs: number): (SparklinePoint | null)[] {
  const byMinute = new Map((points ?? []).map((p) => [p.minute_ts, p]));
  const slots: (SparklinePoint | null)[] = [];
  for (let i = SPARKLINE_SLOTS - 1; i >= 0; i--) {
    slots.push(byMinute.get(latestMinuteTs - i * MINUTE_MS) ?? null);
  }
  return slots;
}

function latestMinuteFromSparklines(sparklines: Record<string, SparklinePoint[]>): number {
  let max = -Infinity;
  for (const points of Object.values(sparklines)) {
    for (const p of points) if (p.minute_ts > max) max = p.minute_ts;
  }
  return max === -Infinity ? Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS : max;
}

function lastKnown(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null) return v;
  }
  return null;
}

/** A smooth flow-diagram curve (horizontal tangents at both ends) between two node boxes' facing
 * edges — a small aesthetic investment over a straight line, in keeping with "hand-rolled SVG". */
function edgePath(from: NodePos, to: NodePos): string {
  const sx = from.x + from.w;
  const sy = from.y + from.h / 2;
  const tx = to.x;
  const ty = to.y + to.h / 2;
  const midX = (sx + tx) / 2;
  return `M ${sx},${sy} C ${midX},${sy} ${midX},${ty} ${tx},${ty}`;
}

function SparkRow({
  label,
  color,
  values,
  format,
}: {
  label: string;
  color: string;
  values: (number | null)[];
  format: (v: number) => string;
}) {
  const last = lastKnown(values);
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-6 shrink-0 font-mono text-[9px] uppercase tracking-wide text-ink-faint">{label}</span>
      <Sparkline values={values} width={60} height={15} color={color} ariaLabel={`${label} sparkline`} />
      <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-dim">{last !== null ? format(last) : "—"}</span>
    </div>
  );
}

function NodeCard({
  node,
  health,
  sparklines,
  latestMinuteTs,
}: {
  node: TopologyServiceNode;
  health: Record<string, string>;
  sparklines: Record<string, SparklinePoint[]>;
  latestMinuteTs: number;
}) {
  const pos = NODE_POSITIONS[node.name];
  if (!pos) return null;

  if (node.external) {
    return (
      <foreignObject x={pos.x} y={pos.y} width={pos.w} height={pos.h}>
        <div className="flex h-full flex-col justify-center gap-1 rounded-xl border border-dashed border-hairline-bright bg-panel/50 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-ink-dim">{KIND_META[node.kind].icon}</span>
            <span className="truncate font-mono text-xs text-ink-dim">{node.name}</span>
          </div>
          <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">{KIND_META[node.kind].label}</span>
        </div>
      </foreignObject>
    );
  }

  const status = (health[node.name] as "red" | "amber" | "green" | undefined) ?? "green";
  const series = sparklines[node.name];
  const slots = alignSlots(series, latestMinuteTs);
  const rateSlots = slots.map((p) => (p ? p.count : null));
  const errSlots = slots.map((p) => (p ? p.error_rate * 100 : null));
  const p95Slots = slots.map((p) => (p ? p.p95 : null));

  return (
    <foreignObject x={pos.x} y={pos.y} width={pos.w} height={pos.h}>
      <div
        className="flex h-full flex-col gap-1.5 rounded-xl border bg-panel px-3 py-2 shadow-lg shadow-black/10"
        style={{ borderColor: status === "green" ? "var(--color-hairline)" : HEALTH_COLOR[status] }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-ink-dim">{KIND_META[node.kind].icon}</span>
            <span className="truncate font-mono text-xs font-medium text-ink">{node.name}</span>
          </div>
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${status !== "green" ? "animate-scan-pulse" : ""}`}
            style={{ backgroundColor: HEALTH_COLOR[status] }}
            title={HEALTH_LABEL[status]}
          />
        </div>
        <span className="-mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-faint">{KIND_META[node.kind].label}</span>
        <SparkRow label="rate" color="var(--color-signal)" values={rateSlots} format={(v) => `${v.toFixed(0)}/m`} />
        <SparkRow label="err" color="var(--color-status-red)" values={errSlots} format={(v) => `${v.toFixed(1)}%`} />
        <SparkRow label="p95" color="var(--color-status-amber)" values={p95Slots} format={(v) => `${v.toFixed(0)}ms`} />
      </div>
    </foreignObject>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-hairline pt-3 font-mono text-[11px] text-ink-dim">
      {(["green", "amber", "red"] as const).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: HEALTH_COLOR[s] }} aria-hidden="true" />
          {HEALTH_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

function OpsHealthNote({ opsHealth }: { opsHealth: OpsHealth }) {
  if (opsHealth.lastSweepOkMs === undefined) return null;
  return (
    <span className="font-mono text-[11px] text-ink-faint" title="Time since the last completed detection sweep">
      sweep {relativeTime(opsHealth.lastSweepOkMs)}
    </span>
  );
}

/** A fault is active but no incident has opened for it yet — the detector's next scheduled sweep
 * hasn't run, or ran and didn't cross threshold yet. Clears the instant any incident opens after
 * the fault started (the story moves to the Incidents panel from there). */
function isScanning(worldStatus: WorldStatusView, incidents: IncidentView[]): boolean {
  const fault = worldStatus.fault;
  if (fault === null) return false;
  return !incidents.some((inc) => inc.opened_at >= fault.startedMs);
}

function ScanningIndicator({ worldStatus }: { worldStatus: WorldStatusView }) {
  const fault = worldStatus.fault;
  if (fault === null) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-signal/30 bg-signal/5 px-3 py-2 font-mono text-xs text-signal-glow">
      <span className="h-2 w-2 shrink-0 animate-scan-pulse rounded-full bg-signal" aria-hidden="true" />
      Watchdog scanning… {SCENARIOS[fault.scenario].label.toLowerCase()} triggered {relativeTime(fault.startedMs)},
      waiting for the next detection sweep.
    </div>
  );
}

function BannerShell({ tone, children }: { tone: "amber" | "signal"; children: ReactNode }) {
  const toneClass = tone === "amber" ? "border-status-amber/30 bg-status-amber/5" : "border-signal/30 bg-signal/5";
  return <div className={`rounded-xl border px-4 py-3 font-sans text-sm text-ink ${toneClass}`}>{children}</div>;
}

/** Rendered by `App.tsx` full-width above the dashboard grid — world-wide state, not scoped to the
 * topology card itself, but specified as part of "System view" (spec §11 item 1). */
export function WorldStatusBanner({ worldStatus }: { worldStatus: WorldStatusView }) {
  const { worldStatus: status, seedProgress } = worldStatus;

  if (status === "running") return null;

  if (status === "unseeded") {
    return (
      <BannerShell tone="amber">
        <strong className="font-medium text-ink">World not seeded yet.</strong> Trigger{" "}
        <span className="font-mono text-ink-dim">Reset &amp; reseed</span> in the chaos panel to generate three
        hours of backfilled telemetry and the historical incident below.
      </BannerShell>
    );
  }

  if (status === "seeding") {
    const pct = seedProgress !== undefined ? Math.round(seedProgress * 100) : null;
    return (
      <BannerShell tone="signal">
        <div className="flex items-center justify-between gap-3">
          <span>Seeding the world — generating three hours of backfilled telemetry…</span>
          {pct !== null && <span className="shrink-0 font-mono text-xs text-ink-dim">{pct}%</span>}
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-panel-raised">
          <div className="h-full rounded-full bg-signal transition-[width] duration-500" style={{ width: `${pct ?? 4}%` }} />
        </div>
      </BannerShell>
    );
  }

  return (
    <BannerShell tone="signal">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 animate-scan-pulse rounded-full bg-signal" aria-hidden="true" />
        Resetting the world — clearing telemetry and reseeding…
      </div>
    </BannerShell>
  );
}

/** The pre-Galaxy card topology, kept as the "Grid" segment of the view toggle — the same
 * Galaxy/Graph/Table pattern polylane.com's Topology panel uses. */
function TopologyGrid({ state, latestMinuteTs }: { state: StateResponse; latestMinuteTs: number }) {
  const { edges } = state.topology;
  return (
    <div className="mx-auto w-full max-w-[980px] overflow-x-auto">
      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        width="100%"
        style={{ minWidth: 680 }}
        role="img"
        aria-label="Service topology graph"
      >
        <defs>
          <marker id="topology-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--color-hairline-bright)" />
          </marker>
        </defs>
        <g fill="none" stroke="var(--color-hairline-bright)" strokeWidth={1.5}>
          {edges.map(([from, to]) => {
            const fromPos = NODE_POSITIONS[from];
            const toPos = NODE_POSITIONS[to];
            if (!fromPos || !toPos) return null;
            return <path key={`${from}->${to}`} d={edgePath(fromPos, toPos)} markerEnd="url(#topology-arrow)" />;
          })}
        </g>
        {state.topology.services.map((node) => (
          <NodeCard key={node.name} node={node} health={state.health} sparklines={state.sparklines} latestMinuteTs={latestMinuteTs} />
        ))}
      </svg>
    </div>
  );
}

type TopologyViewMode = "galaxy" | "grid";

const VIEW_MODE_KEY = "wt-system-view";

function initialViewMode(): TopologyViewMode {
  return storageGet(VIEW_MODE_KEY) === "grid" ? "grid" : "galaxy";
}

/** The Galaxy|Grid segmented control — the same soft pill track as the header's Dashboard|Chat
 * tabs, sized down to toolbar scale. */
function ViewToggle({ mode, onChange }: { mode: TopologyViewMode; onChange: (mode: TopologyViewMode) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-panel-raised p-0.5" role="tablist" aria-label="Topology view">
      {(["galaxy", "grid"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => onChange(m)}
          className={`rounded-full px-2.5 py-1 font-sans text-[11px] font-medium capitalize transition-colors ${
            mode === m ? "border border-hairline bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

/** Last-known rate/err/p95 per service, for the Galaxy's clusters, tooltip, and rail. */
function galaxyStats(state: StateResponse, latestMinuteTs: number): Record<string, GalaxyServiceStat> {
  const stats: Record<string, GalaxyServiceStat> = {};
  for (const node of state.topology.services) {
    const slots = alignSlots(state.sparklines[node.name], latestMinuteTs);
    stats[node.name] = {
      rate: lastKnown(slots.map((p) => (p ? p.count : null))),
      errPct: lastKnown(slots.map((p) => (p ? p.error_rate * 100 : null))),
      p95: lastKnown(slots.map((p) => (p ? p.p95 : null))),
    };
  }
  return stats;
}

export function SystemView({ state, incidents }: { state: StateResponse; incidents: IncidentView[] }) {
  const scanning = isScanning(state.worldStatus, incidents);
  const latestMinuteTs = latestMinuteFromSparklines(state.sparklines);
  const [viewMode, setViewMode] = useState<TopologyViewMode>(initialViewMode);

  function changeViewMode(mode: TopologyViewMode) {
    setViewMode(mode);
    storageSet(VIEW_MODE_KEY, mode);
  }

  const stats = galaxyStats(state, latestMinuteTs);
  const internal = state.topology.services.filter((s) => !s.external);
  const totalRate = internal.reduce((sum, s) => sum + (stats[s.name]?.rate ?? 0), 0);

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-hairline bg-panel/40 p-5">
      <header className="flex items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold tracking-tight text-ink">System</h2>
        <OpsHealthNote opsHealth={state.opsHealth} />
      </header>

      {scanning && <ScanningIndicator worldStatus={state.worldStatus} />}

      {/* Toolbar row, following polylane.com's Topology panel: the resource tally on the left,
          the view switcher on the right. */}
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-ink-faint">
          {internal.length} services · {totalRate.toFixed(0)} req/min
        </span>
        <ViewToggle mode={viewMode} onChange={changeViewMode} />
      </div>

      {viewMode === "galaxy" ? (
        <GalaxyView services={state.topology.services} edges={state.topology.edges} health={state.health} stats={stats} />
      ) : (
        <TopologyGrid state={state} latestMinuteTs={latestMinuteTs} />
      )}

      <Legend />
    </section>
  );
}
