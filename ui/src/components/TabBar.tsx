/**
 * The mobile bottom tab bar (below lg): all six views, icon + tiny label, fixed to the viewport
 * bottom with safe-area padding. The matching content clearance is App's `<main>` bottom padding
 * (pb-24 below lg). z-50 keeps it under the modal/drawer/toast layers (z-[60]+).
 */

import { NAV_ITEMS, type View } from "../lib/nav";

export function TabBar({
  view,
  onNavigate,
  liveIncidents,
}: {
  view: View;
  onNavigate: (view: View) => void;
  liveIncidents: number;
}) {
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-6 border-t border-hairline bg-panel pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {NAV_ITEMS.map((item) => {
        const active = item.id === view;
        const badge = item.id === "incidents" && liveIncidents > 0;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            aria-current={active ? "page" : undefined}
            // The badge is an aria-hidden dot, so the count only reaches assistive tech through the
            // accessible name — mirror NavRail and fold it in.
            aria-label={badge ? `${item.label}, ${liveIncidents} live` : undefined}
            className={`relative flex flex-col items-center gap-0.5 py-2 transition-colors ${
              active ? "text-ink" : "text-ink-faint hover:text-ink-dim"
            }`}
          >
            {item.id === "incidents" && liveIncidents > 0 && (
              <span
                className="absolute right-1/2 top-1.5 h-1.5 w-1.5 translate-x-3 rounded-full bg-status-red"
                aria-hidden="true"
              />
            )}
            {item.icon}
            <span className="font-sans text-[10px] font-medium">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
