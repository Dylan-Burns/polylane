/**
 * A hand-rolled SVG sparkline (spec §11: "no chart or graph libraries"). Takes one value per
 * minute across a fixed window, with `null` for minutes that had no `rollups` row (a service quiet
 * for a whole minute — see `telemetry/state.ts`'s `sparklineSeries` doc comment: gaps are expected,
 * not a bug). Rather than interpolate across a gap, this draws a separate `<polyline>` per
 * contiguous run of known values, so a quiet stretch reads as an honest visual break, not a
 * straight-line guess.
 */

interface SparklineProps {
  values: (number | null)[];
  width?: number;
  height?: number;
  color: string;
  ariaLabel: string;
  /** True when the last entry of `values` is a live (in-progress, not-yet-closed-minute) point
   * rather than a normal rollup — drawn as a small pulsing dot in the signal color on top of the
   * line, so "this one point is still moving" reads at a glance (spec: live metrics, Canonical
   * Table 7). No effect if that last value is `null`. */
  live?: boolean;
}

export function Sparkline({ values, width = 96, height = 22, color, ariaLabel, live = false }: SparklineProps) {
  const known = values.filter((v): v is number => v !== null);

  if (known.length === 0) {
    return (
      <svg width={width} height={height} role="img" aria-label={`${ariaLabel}: no data`}>
        <line
          x1={0}
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const max = Math.max(...known);
  const min = Math.min(...known);
  const range = max - min || 1;
  const padding = 2;
  const drawableH = height - padding * 2;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;

  const segments: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      continue;
    }
    const x = i * stepX;
    const y = padding + drawableH - ((v - min) / range) * drawableH;
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(" "));

  const last = known[known.length - 1] as number;

  const lastIdx = values.length - 1;
  const lastRawValue = values[lastIdx];
  const liveDot =
    live && lastRawValue !== null
      ? { x: lastIdx * stepX, y: padding + drawableH - ((lastRawValue - min) / range) * drawableH }
      : null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${ariaLabel}: latest ${last.toFixed(2)}${live ? " (live)" : ""}`}
      className="overflow-visible"
    >
      {segments.map((points, i) => (
        <polyline
          key={i}
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {liveDot && (
        <circle
          cx={liveDot.x}
          cy={liveDot.y}
          r={2.5}
          fill="var(--color-signal)"
          className="animate-scan-pulse"
          aria-hidden="true"
        />
      )}
    </svg>
  );
}
