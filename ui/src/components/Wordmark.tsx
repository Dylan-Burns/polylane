/** The one signature mark in the app: a tower silhouette with a beacon light at its tip and two
 * arcs sweeping outward — "a watchtower scanning a dark field," reused nowhere else so it stays
 * legible as the app's identity rather than decoration. */
export function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3 L19 20 H5 Z" stroke="var(--color-signal)" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="12" cy="3" r="1.4" fill="var(--color-signal)" />
        <path d="M15.2 8.2a5 5 0 0 1 0 7.4" stroke="var(--color-signal-glow)" strokeWidth="1.3" strokeLinecap="round" opacity="0.8" />
        <path d="M17.4 6a8.2 8.2 0 0 1 0 11.8" stroke="var(--color-signal-glow)" strokeWidth="1.1" strokeLinecap="round" opacity="0.45" />
      </svg>
      <span className="font-display text-[15px] font-semibold uppercase tracking-[0.18em] text-ink">Watchtower</span>
    </div>
  );
}
