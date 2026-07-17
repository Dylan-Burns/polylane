/**
 * The desktop side rail (lg+): one item per view, collapsible to an icon-only strip. Collapse is
 * rail-internal state — nothing else in the app changes with it — persisted via lib/storage, the
 * same pattern as the theme toggle and the Galaxy/Grid toggle. The Incidents item carries a
 * live-count badge (a bare dot when collapsed).
 */

import { useState } from "react";
import { NAV_ITEMS, type View } from "../lib/nav";
import { storageGet, storageSet } from "../lib/storage";

const COLLAPSED_KEY = "wt-nav-collapsed";

export function NavRail({
  view,
  onNavigate,
  liveIncidents,
}: {
  view: View;
  onNavigate: (view: View) => void;
  liveIncidents: number;
}) {
  const [collapsed, setCollapsed] = useState(() => storageGet(COLLAPSED_KEY) === "1");

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    storageSet(COLLAPSED_KEY, next ? "1" : "0");
  }

  return (
    <nav
      aria-label="Sections"
      className={`sticky top-0 hidden h-screen shrink-0 flex-col gap-1 border-r border-hairline bg-panel py-4 lg:flex ${
        collapsed ? "w-16 items-center px-2" : "w-56 px-3"
      }`}
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
            aria-label={collapsed ? item.label : undefined}
            title={collapsed ? item.label : undefined}
            className={`relative flex items-center gap-2.5 rounded-xl py-2 font-sans text-[13px] font-medium transition-colors ${
              collapsed ? "w-10 justify-center px-0" : "w-full px-3"
            } ${
              active
                ? "border border-hairline bg-panel-raised text-ink shadow-sm"
                : "border border-transparent text-ink-dim hover:text-ink"
            }`}
          >
            <span className="shrink-0">{item.icon}</span>
            {!collapsed && <span className="truncate">{item.label}</span>}
            {badge &&
              (collapsed ? (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-status-red" aria-hidden="true" />
              ) : (
                <span className="ml-auto rounded-full border border-status-red/30 bg-status-red/5 px-1.5 font-mono text-[10px] text-status-red">
                  {liveIncidents}
                </span>
              ))}
          </button>
        );
      })}

      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        title={collapsed ? "Expand" : "Collapse"}
        className={`mt-auto flex h-8 w-10 items-center justify-center rounded-xl text-ink-faint transition-colors hover:text-ink ${
          collapsed ? "" : "self-start"
        }`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="m15 6-6 6 6 6" />}
        </svg>
      </button>
    </nav>
  );
}
