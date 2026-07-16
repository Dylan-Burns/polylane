import type { ReactNode } from "react";

interface PillProps {
  color: string;
  children: ReactNode;
  pulse?: boolean;
  className?: string;
}

/** A small colored status pill (dot + label) reused for health, incident status, and confidence —
 * the one recurring "badge" shape in the app. `pulse` reuses the `scan-pulse` animation so "this is
 * live right now" always looks the same, wherever it appears. */
export function Pill({ color, children, pulse, className = "" }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-hairline bg-panel px-2.5 py-1 font-sans text-xs font-medium capitalize text-ink-dim ${className}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${pulse ? "animate-scan-pulse" : ""}`}
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}
