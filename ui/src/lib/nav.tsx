/**
 * The navigation registry: the six views, their labels/icons, and the hash <-> view mapping.
 * The URL hash is the single source of truth for the active view — App reads it on load and on
 * `hashchange` — so deep links (#/systems) and back/forward work without a router dependency.
 */

import type { ReactNode } from "react";

export type View = "overview" | "systems" | "chaos" | "deploys" | "incidents" | "chat";

export const DEFAULT_VIEW: View = "overview";

export interface NavItem {
  id: View;
  label: string;
  icon: ReactNode;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "overview",
    label: "Overview",
    icon: (
      <Icon>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </Icon>
    ),
  },
  {
    id: "systems",
    label: "Systems",
    icon: (
      <Icon>
        <circle cx="5" cy="12" r="2.5" />
        <circle cx="19" cy="5" r="2.5" />
        <circle cx="19" cy="19" r="2.5" />
        <path d="M7.4 10.9 16.6 6.1M7.4 13.1l9.2 4.8" />
      </Icon>
    ),
  },
  {
    id: "chaos",
    label: "Chaos",
    icon: (
      <Icon>
        <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
      </Icon>
    ),
  },
  {
    id: "deploys",
    label: "Deploys",
    icon: (
      <Icon>
        <path d="M12 15V4m0 0 4 4m-4-4L8 8" />
        <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      </Icon>
    ),
  },
  {
    id: "incidents",
    label: "Incidents",
    icon: (
      <Icon>
        <path d="m12 3 10 18H2L12 3Z" />
        <path d="M12 10v5" />
        <path d="M12 18h.01" />
      </Icon>
    ),
  },
  {
    id: "chat",
    label: "Chat",
    icon: (
      <Icon>
        <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 1 1 16.1-3.8Z" />
      </Icon>
    ),
  },
];

const VIEW_IDS = new Set<string>(NAV_ITEMS.map((item) => item.id));

/** "#/systems" -> "systems"; unknown, empty, or malformed -> DEFAULT_VIEW. */
export function viewFromHash(hash: string): View {
  const candidate = hash.replace(/^#\/?/, "");
  return VIEW_IDS.has(candidate) ? (candidate as View) : DEFAULT_VIEW;
}

export function hashForView(view: View): string {
  return `#/${view}`;
}
