/**
 * The Cloudflare-product identity of each service kind — brand mark, sublabel, and brand color,
 * consumed by the typed grid cards (System view), the Galaxy labels, and the incident detail's
 * typed resource headers. Kept as the single UI-side map so a kind can never render two ways.
 *
 * The `worker` glyph is the official Cloudflare Workers brand mark (path from simple-icons, CC0);
 * d1/kv/queue are drawn in the same filled, geometric 24-viewBox language so the set reads as one
 * family. CF products carry Cloudflare's brand orange; the external kind stays deliberately
 * neutral — it is the one node that is NOT a Cloudflare product, and the color coding is the
 * fastest way the eye learns that.
 */

import type { ReactNode } from "react";
import type { ServiceKind } from "./types";

/** Cloudflare brand orange (the product-mark color across CF's own surfaces). */
export const CF_BRAND = "#f6821f";

function Mark({ children, viewBox = "0 0 24 24" }: { children: ReactNode; viewBox?: string }) {
  return (
    <svg width="14" height="14" viewBox={viewBox} fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

export interface KindMeta {
  label: string;
  /** Filled brand mark, rendered at currentColor — color comes from the chip. */
  icon: ReactNode;
  /** Brand color for the mark; chips tint their background from it at low alpha. */
  color: string;
}

export const KIND_META: Readonly<Record<ServiceKind, KindMeta>> = {
  worker: {
    label: "Cloudflare Worker",
    color: CF_BRAND,
    icon: (
      <Mark>
        {/* Official Cloudflare Workers mark (simple-icons, CC0). */}
        <path d="m8.213.063 8.879 12.136-8.67 11.739h2.476l8.665-11.735-8.89-12.14Zm4.728 0 9.02 11.992-9.018 11.883h2.496L24 12.656v-1.199L15.434.063ZM7.178 2.02.01 11.398l-.01 1.2 7.203 9.644 1.238-1.676-6.396-8.556 6.361-8.313Z" />
      </Mark>
    ),
  },
  d1: {
    label: "D1 database",
    color: CF_BRAND,
    icon: (
      <Mark>
        <path d="M12 2.4c-4.6 0-8.2 1.5-8.2 3.4v12.4c0 1.9 3.6 3.4 8.2 3.4s8.2-1.5 8.2-3.4V5.8c0-1.9-3.6-3.4-8.2-3.4Zm0 2c3.8 0 6.2 1 6.2 1.4S15.8 7.2 12 7.2 5.8 6.2 5.8 5.8 8.2 4.4 12 4.4Zm6.2 13.7c0 .4-2.4 1.4-6.2 1.4s-6.2-1-6.2-1.4v-3.2c1.5.7 3.7 1.1 6.2 1.1s4.7-.4 6.2-1.1Zm0-5.7c0 .4-2.4 1.4-6.2 1.4S5.8 12.8 5.8 12.4V9.2c1.5.7 3.7 1.1 6.2 1.1s4.7-.4 6.2-1.1Z" />
      </Mark>
    ),
  },
  kv: {
    label: "Worker + KV",
    color: CF_BRAND,
    icon: (
      <Mark>
        <path d="M8.2 3.2a5.6 5.6 0 1 0 3.9 9.6l1.2 1.2h1.9v1.9h1.9v1.9h1.9v1.9h2.8v-2.8l-8-8a5.6 5.6 0 0 0-5.6-5.7Zm-1.6 3.4a1.7 1.7 0 1 1-1.7 1.7 1.7 1.7 0 0 1 1.7-1.7Z" />
      </Mark>
    ),
  },
  queue: {
    label: "Queue consumer",
    color: CF_BRAND,
    icon: (
      <Mark>
        <path d="M3.2 5.2h13.2v2.6H3.2Zm0 5.5h13.2v2.6H3.2Zm0 5.5h8.4v2.6H3.2Zm11.4 0 6.2 1.3-6.2 1.3Zm3.8-9.4 2.4 2.4-2.4 2.4V13h-2.6v-2.6h2.6Z" />
      </Mark>
    ),
  },
  external: {
    label: "External API",
    color: "#737373",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" strokeDasharray="3.2 3.2" />
        <path d="M3.5 12h17M12 3.5c2.6 2.8 2.6 14.2 0 17-2.6-2.8-2.6-14.2 0-17Z" />
      </svg>
    ),
  },
};

/** The polylane-style typed icon chip: a small rounded tile, brand-tinted background, full-strength
 * brand mark. One component so grid cards, incident headers, and any future typed surface render
 * the identity identically. */
export function KindChip({ kind, size = 24 }: { kind: ServiceKind; size?: number }) {
  const meta = KIND_META[kind];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md border"
      style={{
        width: size,
        height: size,
        color: meta.color,
        backgroundColor: `color-mix(in srgb, ${meta.color} 9%, transparent)`,
        borderColor: `color-mix(in srgb, ${meta.color} 22%, transparent)`,
      }}
      aria-hidden="true"
    >
      {meta.icon}
    </span>
  );
}
