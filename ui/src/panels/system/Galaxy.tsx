/**
 * The "Galaxy" topology view — Watchtower's take on polylane.com's homepage Topology component
 * (the living constellation of resource dots). Hand-rolled on a 2D canvas per spec §11's "no chart
 * or graph libraries" rule, same as `components/Sparkline.tsx`.
 *
 * What the pixels mean (every encoding is load-bearing, not decoration):
 * - Each service is a **cluster of orbiting particles** anchored at a fixed position; particle
 *   count tracks the service's live request rate (req/min), so a traffic surge visibly swells its
 *   cluster and a quiet service shrinks to a wisp.
 * - **Hue = service identity**, one fixed assignment per service (never cycled), light/dark
 *   variants validated with the dataviz palette checker. Blue↔violet is the one CVD-weak pair, so
 *   they're pinned to opposite ends of the canvas (gateway far-left, payments-db far-right) and
 *   every cluster carries a permanent mono label — identity never rides on hue alone.
 * - A slice of each cluster's particles turns **status-red in proportion to its error rate** —
 *   errors literally circulate inside the service.
 * - **Pulses travel along dependency edges** in the downstream service's hue at a tempo tied to
 *   its request rate: the call graph reads as flowing traffic, not static wiring.
 * - Degraded/incident services get a **pulsing hotspot ring** in the health color (Polylane's
 *   "issue hotspot" ring), keeping the red/amber/green health vocabulary on rings — never on
 *   identity fills.
 * - The external dependency renders as a dashed neutral ghost: it's watched, not measured.
 *
 * Canvas can't read CSS custom properties, so this file holds parallel light/dark hex palettes
 * (mirroring index.css's tokens) and re-reads `document.documentElement.dataset.theme` each frame
 * — flipping the header ThemeToggle re-colors the galaxy on the very next frame.
 *
 * `prefers-reduced-motion` renders a single static frame (no rAF loop) and re-draws only when
 * data, size, or theme change — the same honesty rule as index.css's animation kill-switch.
 */

import { useEffect, useRef, useState } from "react";
import { HEALTH_LABEL } from "../../lib/status";
import type { HealthStatus, TopologyServiceNode } from "../../lib/types";

export interface GalaxyServiceStat {
  rate: number | null;
  errPct: number | null;
  p95: number | null;
}

interface GalaxyProps {
  services: TopologyServiceNode[];
  edges: [string, string][];
  health: Record<string, string>;
  stats: Record<string, GalaxyServiceStat>;
}

/** Anchor positions as canvas fractions — same three-tier story as the Grid view (gateway fans
 * out left→right), loosened into an organic cloud. Unknown future services fall back to a
 * golden-angle ring so a topology change degrades gracefully instead of stacking at 0,0. */
const ANCHORS: Record<string, { x: number; y: number }> = {
  gateway: { x: 0.12, y: 0.48 },
  checkout: { x: 0.37, y: 0.3 },
  catalog: { x: 0.4, y: 0.74 },
  payments: { x: 0.62, y: 0.24 },
  notifications: { x: 0.65, y: 0.72 },
  "payments-db": { x: 0.87, y: 0.34 },
  "email-provider": { x: 0.88, y: 0.76 },
};

/** Fixed per-service hue assignment (categorical, never cycled). Light steps validated on white,
 * dark steps on #141414 with `scripts/validate_palette.js` — see the file header for the one
 * documented weak pair and its mitigation. */
const SERVICE_HUE: Record<string, { light: string; dark: string }> = {
  gateway: { light: "#2a78d6", dark: "#4c94ea" },
  checkout: { light: "#eb6834", dark: "#e0713d" },
  payments: { light: "#1baf7a", dark: "#1f9e6e" },
  "payments-db": { light: "#4a3aa7", dark: "#a493f2" },
  catalog: { light: "#eda100", dark: "#d9a217" },
  notifications: { light: "#e87ba4", dark: "#ea86ad" },
};
const HUE_FALLBACKS = Object.values(SERVICE_HUE);

/** Mirrors index.css's tokens — canvas needs resolved hex, not var() strings. */
const CHROME = {
  light: { ink: "#0a0a0a", inkFaint: "#a3a3a3", edge: "#c9c9c9", neutral: "#737373", red: "#dc2626", amber: "#b45309" },
  dark: { ink: "#ededed", inkFaint: "#676767", edge: "#3d3d3d", neutral: "#8a8a8a", red: "#f26b6b", amber: "#e5a441" },
};

type ThemeKey = keyof typeof CHROME;

function currentTheme(): ThemeKey {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function hueFor(name: string, index: number): { light: string; dark: string } {
  return SERVICE_HUE[name] ?? HUE_FALLBACKS[index % HUE_FALLBACKS.length] ?? { light: "#737373", dark: "#8a8a8a" };
}

/** Deterministic PRNG seeded from the service name, so every mount (and every poll-driven
 * re-render) grows the same galaxy rather than reshuffling it. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Particle {
  angle: number;
  radiusFrac: number; // 0..1 of cluster radius (sqrt-distributed toward the core)
  speed: number; // radians/sec, inner particles orbit faster
  size: number;
  alpha: number;
  wobblePhase: number;
}

interface Cluster {
  rand: () => number;
  particles: Particle[];
  driftPhase: number;
}

interface Pulse {
  t: number; // 0..1 along the edge
  speed: number; // fraction/sec
  isError: boolean;
}

interface EdgeFlow {
  pulses: Pulse[];
  accumulator: number;
}

function makeParticle(rand: () => number): Particle {
  return {
    angle: rand() * Math.PI * 2,
    radiusFrac: Math.sqrt(rand()),
    speed: (0.12 + rand() * 0.38) * (rand() < 0.5 ? 1 : -1),
    size: 0.9 + rand() * 1.7 + (rand() < 0.08 ? 1.6 : 0),
    alpha: 0.35 + rand() * 0.55,
    wobblePhase: rand() * Math.PI * 2,
  };
}

/** Cluster visual radius grows with population — sqrt so a 5x traffic surge reads clearly without
 * swallowing the canvas. */
function clusterRadius(count: number): number {
  return 22 + Math.sqrt(count) * 3.1;
}

function targetCount(rate: number | null): number {
  if (rate === null) return 10;
  return Math.max(10, Math.min(110, Math.round(6 + rate * 0.9)));
}

interface TooltipState {
  name: string;
  x: number;
  y: number;
}

const EXTERNAL_PARTICLES = 7;

export function GalaxyView({ services, edges, health, stats }: GalaxyProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clustersRef = useRef<Map<string, Cluster>>(new Map());
  const flowsRef = useRef<Map<string, EdgeFlow>>(new Map());
  const propsRef = useRef<GalaxyProps>({ services, edges, health, stats });
  const hoveredRef = useRef<string | null>(null);
  /** Set by the mount effect ONLY under reduced motion — the prop-driven effect below calls it so
   * a static frame still repaints when health/stats change (the rAF loop, when running, reads
   * live props every frame and needs no nudge). */
  const staticRedrawRef = useRef<(() => void) | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [hoveredRail, setHoveredRail] = useState<string | null>(null);

  propsRef.current = { services, edges, health, stats };
  hoveredRef.current = tooltip?.name ?? hoveredRail;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastTs = performance.now();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function anchorFor(name: string, index: number, w: number, h: number, t: number): { x: number; y: number } {
      const base = ANCHORS[name];
      let fx: number;
      let fy: number;
      if (base) {
        fx = base.x;
        fy = base.y;
      } else {
        // Golden-angle fallback ring for services this layout doesn't know about.
        const a = index * 2.399963;
        fx = 0.5 + Math.cos(a) * 0.33;
        fy = 0.5 + Math.sin(a) * 0.33;
      }
      const cluster = clustersRef.current.get(name);
      const phase = cluster?.driftPhase ?? 0;
      // The whole constellation breathes: anchors wander a few px on slow, phase-offset orbits.
      const dx = Math.sin(t * 0.11 + phase) * 7 + Math.sin(t * 0.023 + phase * 2) * 4;
      const dy = Math.cos(t * 0.13 + phase) * 6 + Math.cos(t * 0.031 + phase * 3) * 4;
      return { x: fx * w + dx, y: fy * h + dy };
    }

    function ensureCluster(name: string): Cluster {
      let cluster = clustersRef.current.get(name);
      if (!cluster) {
        const rand = mulberry32(hashString(name));
        cluster = { rand, particles: [], driftPhase: rand() * Math.PI * 2 };
        clustersRef.current.set(name, cluster);
      }
      return cluster;
    }

    function draw(now: number) {
      const { services: svc, edges: edg, health: hlth, stats: sts } = propsRef.current;
      const theme = currentTheme();
      const chrome = CHROME[theme];
      const hovered = hoveredRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = container!.clientWidth;
      const h = container!.clientHeight;
      if (canvas!.width !== Math.round(w * dpr) || canvas!.height !== Math.round(h * dpr)) {
        canvas!.width = Math.round(w * dpr);
        canvas!.height = Math.round(h * dpr);
      }
      const t = now / 1000;
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;

      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, w, h);

      const anchors = new Map<string, { x: number; y: number; r: number; hue: string; count: number }>();

      // --- grow/shrink clusters toward their rate-driven population, then place anchors
      svc.forEach((node, i) => {
        const cluster = ensureCluster(node.name);
        const stat = sts[node.name];
        const target = node.external ? EXTERNAL_PARTICLES : targetCount(stat?.rate ?? null);
        // Ease population toward target a couple of particles per frame — a surge swells the
        // cluster over ~a second instead of popping.
        if (cluster.particles.length < target) {
          for (let k = 0; k < 2 && cluster.particles.length < target; k++) cluster.particles.push(makeParticle(cluster.rand));
        } else if (cluster.particles.length > target) {
          cluster.particles.length = Math.max(target, cluster.particles.length - 2);
        }
        const pos = anchorFor(node.name, i, w, h, t);
        const hue = hueFor(node.name, i)[theme];
        anchors.set(node.name, { ...pos, r: clusterRadius(cluster.particles.length), hue, count: cluster.particles.length });
      });

      const anyHover = hovered !== null;
      const dimAlpha = 0.22;

      // --- dependency edges: faint arcs + traffic pulses in the downstream service's hue
      for (const [from, to] of edg) {
        const a = anchors.get(from);
        const b = anchors.get(to);
        if (!a || !b) continue;
        const key = `${from}->${to}`;
        let flow = flowsRef.current.get(key);
        if (!flow) {
          flow = { pulses: [], accumulator: 0 };
          flowsRef.current.set(key, flow);
        }
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // Perpendicular bow so parallel edges don't overlap; deterministic per edge.
        const bow = ((hashString(key) % 100) / 100 - 0.5) * 60;
        const nx = -(b.y - a.y);
        const ny = b.x - a.x;
        const nlen = Math.hypot(nx, ny) || 1;
        const cx = mx + (nx / nlen) * bow;
        const cy = my + (ny / nlen) * bow;

        const edgeInvolvesHover = hovered === from || hovered === to;
        ctx!.globalAlpha = anyHover && !edgeInvolvesHover ? 0.15 : 0.85;
        ctx!.strokeStyle = chrome.edge;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.quadraticCurveTo(cx, cy, b.x, b.y);
        ctx!.stroke();

        // Pulse spawn tempo follows the downstream service's request rate.
        const toStat = sts[to];
        const rate = toStat?.rate ?? 0;
        const errPct = toStat?.errPct ?? 0;
        if (!reducedMotion) {
          flow.accumulator += dt * Math.min(2.6, 0.5 + rate / 40);
          while (flow.accumulator >= 1 && flow.pulses.length < 8) {
            flow.accumulator -= 1;
            flow.pulses.push({ t: 0, speed: 0.45 + Math.random() * 0.25, isError: errPct > 1 && Math.random() < Math.min(0.35, errPct / 100 + 0.08) });
          }
          flow.accumulator = Math.min(flow.accumulator, 1);
        }
        for (let i = flow.pulses.length - 1; i >= 0; i--) {
          const p = flow.pulses[i];
          if (!p) continue;
          p.t += dt * p.speed;
          if (p.t >= 1) {
            flow.pulses.splice(i, 1);
            continue;
          }
          const it = 1 - p.t;
          const px = it * it * a.x + 2 * it * p.t * cx + p.t * p.t * b.x;
          const py = it * it * a.y + 2 * it * p.t * cy + p.t * p.t * b.y;
          const color = p.isError ? chrome.red : b.hue;
          ctx!.globalAlpha = (anyHover && !edgeInvolvesHover ? 0.15 : 0.9) * Math.sin(p.t * Math.PI);
          ctx!.fillStyle = color;
          ctx!.beginPath();
          ctx!.arc(px, py, 1.7, 0, Math.PI * 2);
          ctx!.fill();
          // Soft halo behind each pulse.
          ctx!.globalAlpha *= 0.3;
          ctx!.beginPath();
          ctx!.arc(px, py, 4, 0, Math.PI * 2);
          ctx!.fill();
        }
      }

      // --- clusters
      svc.forEach((node) => {
        const anchor = anchors.get(node.name);
        const cluster = clustersRef.current.get(node.name);
        if (!anchor || !cluster) return;
        const isHovered = hovered === node.name;
        const clusterAlpha = anyHover && !isHovered ? dimAlpha : 1;
        const stat = sts[node.name];
        const errFrac = node.external ? 0 : Math.min(0.25, (stat?.errPct ?? 0) / 100);

        // Nebula wash behind the cluster — the soft glow that makes it read "galaxy".
        if (!node.external) {
          const grad = ctx!.createRadialGradient(anchor.x, anchor.y, 0, anchor.x, anchor.y, anchor.r * 1.8);
          grad.addColorStop(0, anchor.hue);
          grad.addColorStop(1, "transparent");
          ctx!.globalAlpha = (theme === "dark" ? 0.14 : 0.08) * clusterAlpha;
          ctx!.fillStyle = grad;
          ctx!.beginPath();
          ctx!.arc(anchor.x, anchor.y, anchor.r * 1.8, 0, Math.PI * 2);
          ctx!.fill();
        }

        cluster.particles.forEach((p, idx) => {
          const angle = p.angle + t * p.speed * (reducedMotion ? 0 : 1.6 - p.radiusFrac * 0.9);
          const wobble = reducedMotion ? 0 : Math.sin(t * 0.9 + p.wobblePhase) * 2;
          const r = p.radiusFrac * anchor.r + wobble;
          const px = anchor.x + Math.cos(angle) * r * 1.12; // slightly elliptical, like the reference
          const py = anchor.y + Math.sin(angle) * r * 0.92;
          const isErr = !node.external && idx < cluster.particles.length * errFrac;
          const color = node.external ? chrome.neutral : isErr ? chrome.red : anchor.hue;
          const twinkle = reducedMotion ? 1 : 0.82 + 0.18 * Math.sin(t * 1.7 + p.wobblePhase * 3);

          ctx!.fillStyle = color;
          // Halo pass then core — two arcs beat canvas shadowBlur by an order of magnitude.
          ctx!.globalAlpha = p.alpha * 0.18 * clusterAlpha * twinkle;
          ctx!.beginPath();
          ctx!.arc(px, py, p.size * 2.6, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.globalAlpha = p.alpha * clusterAlpha * twinkle * (isErr ? 1 : 0.95);
          ctx!.beginPath();
          ctx!.arc(px, py, p.size * (isErr ? 1.25 : 1), 0, Math.PI * 2);
          ctx!.fill();
        });

        // Hotspot ring for degraded/incident services (health lives on rings, never fills).
        const status = (hlth[node.name] as HealthStatus | undefined) ?? "green";
        if (!node.external && status !== "green") {
          const ringColor = status === "red" ? chrome.red : chrome.amber;
          const pulse = reducedMotion ? 0.7 : 0.45 + 0.4 * Math.sin(t * 2.6 + cluster.driftPhase);
          ctx!.strokeStyle = ringColor;
          ctx!.lineWidth = 1.5;
          ctx!.globalAlpha = pulse * clusterAlpha;
          ctx!.beginPath();
          ctx!.arc(anchor.x, anchor.y, anchor.r + 7, 0, Math.PI * 2);
          ctx!.stroke();
          ctx!.globalAlpha = 0.25 * clusterAlpha;
          ctx!.lineWidth = 1;
          ctx!.beginPath();
          ctx!.arc(anchor.x, anchor.y, anchor.r + 12 + (reducedMotion ? 0 : Math.sin(t * 2.6 + cluster.driftPhase) * 2), 0, Math.PI * 2);
          ctx!.stroke();
        }

        // External dependency: a dashed neutral ghost — watched, not measured.
        if (node.external) {
          ctx!.strokeStyle = chrome.neutral;
          ctx!.globalAlpha = 0.5 * clusterAlpha;
          ctx!.lineWidth = 1;
          ctx!.setLineDash([4, 4]);
          ctx!.beginPath();
          ctx!.arc(anchor.x, anchor.y, anchor.r + 4, 0, Math.PI * 2);
          ctx!.stroke();
          ctx!.setLineDash([]);
        }

        // Permanent labels — the relief that keeps identity off hue alone. The x is clamped so
        // edge-anchored clusters (payments-db lives at the far right by design — CVD separation)
        // keep their full label inside the canvas on narrow phones instead of clipping. The
        // external ghost's label sits ABOVE its ring: it shares the bottom-row corridor with
        // notifications, and on a phone-width canvas their below-labels must collide.
        ctx!.globalAlpha = clusterAlpha;
        ctx!.textAlign = "center";
        ctx!.fillStyle = chrome.ink;
        ctx!.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
        const nameHalf = ctx!.measureText(node.name).width / 2;
        const labelX = Math.min(Math.max(anchor.x, nameHalf + 4), w - nameHalf - 4);
        const nameY = node.external ? anchor.y - anchor.r - 24 : anchor.y + anchor.r + 20;
        const subY = node.external ? anchor.y - anchor.r - 12 : anchor.y + anchor.r + 32;
        ctx!.fillText(node.name, labelX, nameY);
        ctx!.fillStyle = chrome.inkFaint;
        ctx!.font = '400 9px "JetBrains Mono", ui-monospace, monospace';
        const sub = node.external ? "external" : stat?.rate !== null && stat?.rate !== undefined ? `${stat.rate.toFixed(0)}/m` : "—";
        ctx!.fillText(sub, labelX, subY);
      });

      ctx!.globalAlpha = 1;
    }

    function loop(now: number) {
      draw(now);
      raf = requestAnimationFrame(loop);
    }

    const resizeObserver = new ResizeObserver(() => {
      if (reducedMotion) draw(performance.now());
    });
    resizeObserver.observe(container);

    let themeObserver: MutationObserver | undefined;
    if (reducedMotion) {
      draw(performance.now());
      staticRedrawRef.current = () => draw(performance.now());
      themeObserver = new MutationObserver(() => draw(performance.now()));
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      themeObserver?.disconnect();
      staticRedrawRef.current = null;
    };
    // The rAF loop reads live data through propsRef — mounting once is deliberate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Static-frame repaint on data change under reduced motion: the observers above only cover
  // resize and theme flips, so without this a health transition (green → incident red) would stay
  // invisible until one of those happened. No-op on the animated path (staticRedrawRef is null —
  // the loop picks new props up on the next frame).
  useEffect(() => {
    staticRedrawRef.current?.();
  }, [services, edges, health, stats]);

  function hitTest(clientX: number, clientY: number): TooltipState | null {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: { name: string; d: number } | null = null;
    for (const node of propsRef.current.services) {
      const base = ANCHORS[node.name];
      if (!base) continue;
      const cluster = clustersRef.current.get(node.name);
      const r = clusterRadius(cluster?.particles.length ?? 10) + 16;
      const d = Math.hypot(x - base.x * rect.width, y - base.y * rect.height);
      if (d <= r && (best === null || d < best.d)) best = { name: node.name, d };
    }
    if (!best) return null;
    return { name: best.name, x, y };
  }

  const tooltipNode = tooltip ? propsRef.current.services.find((s) => s.name === tooltip.name) : undefined;
  const tooltipStat = tooltip ? stats[tooltip.name] : undefined;
  const tooltipStatus = tooltip ? ((health[tooltip.name] as HealthStatus | undefined) ?? "green") : "green";
  const theme = currentTheme();

  const internalServices = services.filter((s) => !s.external);
  const hotspots = internalServices.filter((s) => (health[s.name] ?? "green") !== "green").length;

  return (
    <div className="flex overflow-hidden rounded-xl border border-hairline bg-panel">
      <div
        ref={containerRef}
        className="relative h-[380px] min-w-0 flex-1"
        onPointerMove={(e) => {
          const hit = hitTest(e.clientX, e.clientY);
          // Functional update with an identity bail-out: pointer events arrive at ~60/s, and a
          // fresh {name,x,y} per event would re-render the whole view (rail, aria recompute) even
          // while hovering one cluster — or empty space — continuously.
          setTooltip((prev) => {
            if (prev === hit) return prev;
            if (prev && hit && prev.name === hit.name && prev.x === hit.x && prev.y === hit.y) return prev;
            return hit;
          });
        }}
        onPointerLeave={() => setTooltip(null)}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" role="img" aria-label={galaxyAriaLabel(services, health, stats)} />
        {tooltip && tooltipNode && (
          <div
            className="pointer-events-none absolute z-10 w-56 rounded-xl border border-hairline bg-panel p-3 shadow-lg shadow-black/10"
            style={{
              left: Math.min(tooltip.x + 14, (containerRef.current?.clientWidth ?? 300) - 232),
              top: Math.max(8, tooltip.y - 20),
            }}
          >
            <p className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">acme-shop · {tooltipNode.external ? "external dependency" : "service"}</p>
            <p className="mt-1 flex items-center gap-1.5 font-mono text-xs font-medium text-ink">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: tooltipNode.external ? CHROME[theme].neutral : hueFor(tooltip.name, 0)[theme] }}
                aria-hidden="true"
              />
              {tooltip.name}
            </p>
            {!tooltipNode.external && (
              <>
                <p
                  className="mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    color: tooltipStatus === "green" ? "var(--color-status-green)" : tooltipStatus === "amber" ? "var(--color-status-amber)" : "var(--color-status-red)",
                    backgroundColor: "color-mix(in srgb, currentColor 10%, transparent)",
                  }}
                >
                  {HEALTH_LABEL[tooltipStatus]}
                </p>
                <div className="mt-2 flex flex-col gap-0.5 font-mono text-[10px] text-ink-dim">
                  <span>rate  {tooltipStat?.rate !== null && tooltipStat?.rate !== undefined ? `${tooltipStat.rate.toFixed(0)}/m` : "—"}</span>
                  <span>err   {tooltipStat?.errPct !== null && tooltipStat?.errPct !== undefined ? `${tooltipStat.errPct.toFixed(1)}%` : "—"}</span>
                  <span>p95   {tooltipStat?.p95 !== null && tooltipStat?.p95 !== undefined ? `${tooltipStat.p95.toFixed(0)}ms` : "—"}</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Right rail — Polylane's legend sidebar: identity mapping plus the hotspot tally.
          Hovering a row spotlights that cluster on the canvas. */}
      <div className="hidden w-44 shrink-0 flex-col border-l border-hairline md:flex">
        <ul className="flex flex-col gap-0.5 p-2">
          {services.map((s, i) => {
            const stat = stats[s.name];
            return (
              <li key={s.name}>
                <button
                  type="button"
                  onMouseEnter={() => setHoveredRail(s.name)}
                  onMouseLeave={() => setHoveredRail(null)}
                  onFocus={() => setHoveredRail(s.name)}
                  onBlur={() => setHoveredRail(null)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-panel-raised"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: s.external ? CHROME[theme].neutral : hueFor(s.name, i)[theme] }}
                    aria-hidden="true"
                  />
                  <span className="truncate font-mono text-[10px] text-ink-dim">{s.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-ink-faint">
                    {s.external ? "ext" : stat?.rate !== null && stat?.rate !== undefined ? `${stat.rate.toFixed(0)}` : "—"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-auto flex flex-col gap-1 border-t border-hairline p-3">
          <p className="flex items-center gap-1.5 font-mono text-[10px] text-ink-dim">
            <span
              className={`h-2 w-2 rounded-full border ${hotspots > 0 ? "border-status-red" : "border-hairline-bright"}`}
              aria-hidden="true"
            />
            Issue hotspots
            <span className="ml-auto text-ink-faint">{hotspots}</span>
          </p>
          <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
            {internalServices.length - hotspots} of {internalServices.length} services healthy
          </p>
        </div>
      </div>
    </div>
  );
}

function galaxyAriaLabel(services: TopologyServiceNode[], health: Record<string, string>, stats: Record<string, GalaxyServiceStat>): string {
  const parts = services
    .filter((s) => !s.external)
    .map((s) => {
      const stat = stats[s.name];
      const rate = stat?.rate !== null && stat?.rate !== undefined ? `${stat.rate.toFixed(0)} requests per minute` : "no recent traffic";
      return `${s.name}: ${HEALTH_LABEL[(health[s.name] as HealthStatus | undefined) ?? "green"]}, ${rate}`;
    });
  return `Live service topology galaxy. ${parts.join("; ")}.`;
}
