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
        <path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5Z" />
        <path d="m12.8 7.5-3.3 4.7h2.6l-1 4.3 3.4-4.8h-2.6l.9-4.2Z" strokeWidth="1.6" />
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
        <circle cx="7.5" cy="15.5" r="4" />
        <path d="m10.4 12.6 9.1-9.1M16 7l3 3M13 10l2 2" />
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
