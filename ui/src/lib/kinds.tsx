/**
 * The Cloudflare-product identity of each service kind — one icon + sublabel per `ServiceKind`,
 * consumed by the typed grid cards (System view), the Galaxy labels, and the incident detail's
 * typed resource headers. Kept as the single UI-side map so a kind can never render two different
 * ways. Icons follow the app's icon language (16px, stroke=currentColor, strokeWidth 2, no fill)
 * established by `lib/nav.tsx`.
 */

import type { ReactNode } from "react";
import type { ServiceKind } from "./types";

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

export const KIND_META: Readonly<Record<ServiceKind, { label: string; icon: ReactNode }>> = {
  worker: {
    label: "Cloudflare Worker",
    icon: (
      <Icon>
        <rect x="3" y="3" width="18" height="18" rx="4" />
        <path d="m9.5 9-3 3 3 3M14.5 9l3 3-3 3" />
      </Icon>
    ),
  },
  d1: {
    label: "D1 database",
    icon: (
      <Icon>
        <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
        <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" />
        <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
      </Icon>
    ),
  },
  kv: {
    label: "Worker + KV",
    icon: (
      <Icon>
        <circle cx="8.5" cy="8.5" r="4.5" />
        <path d="m11.8 11.8 8.2 8.2M17 17l-2 2M19.5 14.5l-2 2" />
      </Icon>
    ),
  },
  queue: {
    label: "Queue consumer",
    icon: (
      <Icon>
        <path d="M4 7h16M4 12h16M4 17h9" />
        <path d="m17.5 15 3 2-3 2" />
      </Icon>
    ),
  },
  external: {
    label: "External API",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="8.5" strokeDasharray="3.2 3.2" />
        <path d="M3.5 12h17M12 3.5c2.6 2.8 2.6 14.2 0 17-2.6-2.8-2.6-14.2 0-17Z" />
      </Icon>
    ),
  },
};
