# Sidenav Shell + Dedicated Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-tab Watchtower UI shell with six dedicated views behind a collapsible desktop side rail and a mobile bottom tab bar, per `docs/specs/2026-07-17-sidenav-whitespace-design.md`.

**Architecture:** A nav registry (`ui/src/lib/nav.tsx`) defines the six views, their icons, and hash↔view mapping; the URL hash is the single source of truth for the active view. `App.tsx` renders one shell (rail · header+main · tab bar) and conditionally renders the active view — except Chat, which stays mounted-but-hidden so an in-flight SSE stream survives navigation. Panels are reused as-is with two small opt-in props for the dedicated views' wider layouts.

**Tech Stack:** React 19, Tailwind v4 (CSS-first `@theme` tokens in `ui/src/index.css`), Vite. No new dependencies — no router library.

## Global Constraints

- UI only: nothing under `src/` (worker) changes except nothing — every file touched lives in `ui/src/`. No API, schema, or worker changes.
- No UI test infrastructure exists and none is added (spec "Out of scope"). The per-task verify cycle is: `pnpm build:ui` (runs `tsc -b && vite build` for the UI package — the root `pnpm typecheck` does NOT cover `ui/`), and the final task is a browser verification pass at ~1440px and ~390px in both themes.
- Style tokens only from `index.css`'s `@theme` (`bg-panel`, `text-ink-dim`, `border-hairline`, `text-status-red`, …). Never introduce raw hex colors.
- Icons are hand-rolled inline SVG, `16px`, `stroke="currentColor" strokeWidth="2"`, `fill="none"` — the same language as `ThemeToggle`'s sun/moon in `App.tsx`.
- localStorage only via `storageGet`/`storageSet` from `ui/src/lib/storage.ts` (bare `localStorage` can throw and unmount the tree).
- Modal/drawer layers use `z-[60]`/`z-[70]`/`z-[80]`; the fixed tab bar must sit BELOW them (`z-50`).
- Conventional-commit messages; commit at the end of every task; never commit failing builds.

---

### Task 1: Nav registry (`ui/src/lib/nav.tsx`)

**Files:**
- Create: `ui/src/lib/nav.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2–4):
  - `type View = "overview" | "systems" | "chaos" | "deploys" | "incidents" | "chat"`
  - `const DEFAULT_VIEW: View`
  - `interface NavItem { id: View; label: string; icon: ReactNode }`
  - `const NAV_ITEMS: NavItem[]` (ordered: overview, systems, chaos, deploys, incidents, chat)
  - `function viewFromHash(hash: string): View`
  - `function hashForView(view: View): string`

- [ ] **Step 1: Write the file**

```tsx
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
```

- [ ] **Step 2: Verify it builds**

Run: `pnpm build:ui`
Expected: exits 0 (the file is not imported yet — this catches syntax/TS errors only).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/nav.tsx
git commit -m "feat(ui): nav registry — six views, icons, hash mapping"
```

---

### Task 2: Shared live-status set + desktop NavRail

**Files:**
- Modify: `ui/src/lib/status.ts` (append export)
- Modify: `ui/src/panels/Deploys.tsx:27` (replace private `LIVE_STATUSES` with the shared export)
- Create: `ui/src/components/NavRail.tsx`

**Interfaces:**
- Consumes: `NAV_ITEMS`, `View` from `../lib/nav` (Task 1); `storageGet`/`storageSet` from `../lib/storage`.
- Produces (used by Task 4):
  - `LIVE_INCIDENT_STATUSES: ReadonlySet<IncidentStatus>` exported from `ui/src/lib/status.ts`
  - `function NavRail({ view, onNavigate, liveIncidents }: { view: View; onNavigate: (view: View) => void; liveIncidents: number })`

- [ ] **Step 1: Add the shared set to `ui/src/lib/status.ts`** (append after `INCIDENT_STATUS_META`)

```ts
/** Lifecycle statuses that count as "live" — the investigation is running or its report is still
 * the operative document. Shared by the deploys correlation chips and the nav's incident badge so
 * "live" can never mean two different things. */
export const LIVE_INCIDENT_STATUSES: ReadonlySet<IncidentStatus> = new Set(["open", "investigating", "reported"]);
```

- [ ] **Step 2: Use it in `ui/src/panels/Deploys.tsx`**

Delete line 27 (`const LIVE_STATUSES = new Set(["open", "investigating", "reported"]);`) and add to the imports:

```ts
import { LIVE_INCIDENT_STATUSES } from "../lib/status";
```

Replace both usages inside `correlate` (lines 72 and 74): `LIVE_STATUSES.has(e.incident.status)` → `LIVE_INCIDENT_STATUSES.has(e.incident.status)`.

- [ ] **Step 3: Create `ui/src/components/NavRail.tsx`**

```tsx
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
```

- [ ] **Step 4: Verify it builds**

Run: `pnpm build:ui`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/status.ts ui/src/panels/Deploys.tsx ui/src/components/NavRail.tsx
git commit -m "feat(ui): desktop nav rail with collapse + live-incident badge"
```

---

### Task 3: Mobile bottom TabBar

**Files:**
- Create: `ui/src/components/TabBar.tsx`

**Interfaces:**
- Consumes: `NAV_ITEMS`, `View` from `../lib/nav` (Task 1).
- Produces (used by Task 4): `function TabBar({ view, onNavigate, liveIncidents }: { view: View; onNavigate: (view: View) => void; liveIncidents: number })` — same prop shape as `NavRail`.

- [ ] **Step 1: Create `ui/src/components/TabBar.tsx`**

```tsx
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
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            aria-current={active ? "page" : undefined}
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
```

- [ ] **Step 2: Verify it builds**

Run: `pnpm build:ui`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/TabBar.tsx
git commit -m "feat(ui): mobile bottom tab bar"
```

---

### Task 4: App shell rewrite — hash routing, six views, slim header

**Files:**
- Modify: `ui/src/App.tsx` (full-file rewrite below)

**Interfaces:**
- Consumes: `NavRail` (Task 2), `TabBar` (Task 3), `viewFromHash`/`hashForView`/`View` (Task 1), `LIVE_INCIDENT_STATUSES` (Task 2). All panel imports keep their existing signatures — `ChaosPanel` and `DeploysCard` are called WITHOUT the new layout props here; Task 5 adds those props and updates the two dedicated-view call sites.
- Produces: the shell. Nothing downstream consumes App.

- [ ] **Step 1: Rewrite `ui/src/App.tsx` with exactly this content**

(`NavTab` and the local `View` type are deliberately gone — the nav registry replaces them. `ThemeToggle`, `WorldStatusPill`, and `LoadingCard` are carried over unchanged.)

```tsx
import { useEffect, useState } from "react";
import { NavRail } from "./components/NavRail";
import { Pill } from "./components/Pill";
import { TabBar } from "./components/TabBar";
import { Wordmark } from "./components/Wordmark";
import { getIncidents, getState } from "./lib/api";
import { hashForView, viewFromHash, type View } from "./lib/nav";
import { usePoll } from "./lib/poll";
import { LIVE_INCIDENT_STATUSES } from "./lib/status";
import { storageSet } from "./lib/storage";
import { ToastProvider } from "./lib/toast";
import type { StateResponse } from "./lib/types";
import { AnalyticsRow } from "./panels/Analytics";
import { ChatPanel } from "./panels/Chat";
import { ChaosPanel } from "./panels/Chaos";
import { DeploysCard } from "./panels/Deploys";
import { IncidentsPanel } from "./panels/Incidents";
import { SystemView, WorldStatusBanner } from "./panels/System";

const STATE_POLL_MS = 5000;
const INCIDENTS_POLL_MS = 10_000;

type Theme = "light" | "dark";

/** polylane.com's header theme switch: a quiet circular icon button, sun in dark mode / moon in
 * light mode. The `data-theme` attribute is the single switch — index.css's dark token block does
 * the rest — and index.html stamps it pre-paint from the same localStorage key. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    storageSet("wt-theme", theme);
  }, [theme]);

  return (
    <button
      type="button"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Light theme" : "Dark theme"}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-panel text-ink-dim transition-colors hover:border-hairline-bright hover:text-ink"
    >
      {theme === "dark" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
    </button>
  );
}

function WorldStatusPill({ state, error }: { state: StateResponse | undefined; error: unknown }) {
  if (state === undefined) {
    if (error !== undefined) return <Pill color="var(--color-status-red)">offline</Pill>;
    return <Pill color="var(--color-ink-faint)">connecting…</Pill>;
  }
  const ws = state.worldStatus.worldStatus;
  const color =
    ws === "running" ? "var(--color-status-green)" : ws === "unseeded" ? "var(--color-status-amber)" : "var(--color-signal)";
  return (
    <Pill color={color} pulse={ws !== "running"}>
      {ws}
    </Pill>
  );
}

function LoadingCard({ label }: { label: string }) {
  return (
    <section className="flex min-h-[220px] items-center justify-center rounded-2xl border border-hairline bg-panel/40 p-5">
      <p className="text-xs text-ink-dim">{label}</p>
    </section>
  );
}

/** The active view lives in the URL hash (#/systems) — deep-linkable, back/forward works, no
 * router. The hash is the single writer: `navigate` only assigns `location.hash`, and the
 * `hashchange` listener is the only place state updates, so the two can never disagree. An empty
 * hash means Overview without writing "#/overview" into the address bar on load. */
function useHashView(): [View, (next: View) => void] {
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function navigate(next: View) {
    if (viewFromHash(window.location.hash) === next) return;
    window.location.hash = hashForView(next);
  }

  return [view, navigate];
}

function Shell() {
  const [view, navigate] = useHashView();
  const onChat = view === "chat";
  // Polling pauses (intervalMs null) while the Chat view is active — nothing on screen consumes
  // the results, and a chat turn is already competing for the same worker. `usePoll` re-fetches
  // immediately when the interval flips back on. The five non-chat views all consume these two
  // polls (directly or via the badge), so they poll whenever any of them is up.
  const state = usePoll(getState, onChat ? null : STATE_POLL_MS);
  const incidentsPoll = usePoll(getIncidents, onChat ? null : INCIDENTS_POLL_MS);
  const incidents = incidentsPoll.data?.incidents ?? [];
  const liveIncidents = incidents.filter((i) => LIVE_INCIDENT_STATUSES.has(i.status)).length;

  const systemView = state.data ? (
    <SystemView state={state.data} incidents={incidents} />
  ) : (
    <LoadingCard label={state.error !== undefined ? "Couldn't reach Watchtower's API." : "Loading system view…"} />
  );

  return (
    <div className="min-h-screen bg-void text-ink lg:flex">
      <NavRail view={view} onNavigate={navigate} liveIncidents={liveIncidents} />

      <div className="min-w-0 flex-1">
        <header className="flex items-center gap-3 border-b border-hairline px-4 py-4 sm:px-6 lg:px-8">
          <Wordmark />
          <div className="ml-auto flex items-center gap-2.5">
            <ThemeToggle />
            <WorldStatusPill state={state.data} error={state.error} />
          </div>
        </header>

        {/* pb-24 below lg clears the fixed bottom tab bar; on lg+ the rail replaces it. */}
        <main className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:pb-6">
          {!onChat && state.data && <WorldStatusBanner worldStatus={state.data.worldStatus} />}

          {view === "overview" && (
            <>
              <AnalyticsRow active />
              {/* The compact everything-at-once grid — composition unchanged from the pre-sidenav
                  dashboard (see the spec's "Out of scope"). */}
              <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
                {systemView}
                <div className="flex flex-col gap-6 xl:col-start-2 xl:row-span-2 xl:row-start-1">
                  {state.data ? (
                    <ChaosPanel worldStatus={state.data.worldStatus} onActionSettled={state.refresh} />
                  ) : (
                    <LoadingCard label="Loading chaos panel…" />
                  )}
                  <DeploysCard incidents={incidents} active />
                </div>
                <div className="min-w-0 xl:col-start-1 xl:row-start-2">
                  <IncidentsPanel incidents={incidents} worldStatus={state.data?.worldStatus.worldStatus ?? "unseeded"} />
                </div>
              </div>
            </>
          )}

          {view === "systems" && systemView}

          {view === "chaos" && (
            <div className="mx-auto w-full max-w-[880px]">
              {state.data ? (
                <ChaosPanel worldStatus={state.data.worldStatus} onActionSettled={state.refresh} />
              ) : (
                <LoadingCard label="Loading chaos panel…" />
              )}
            </div>
          )}

          {view === "deploys" && (
            <div className="mx-auto w-full max-w-[880px]">
              <DeploysCard incidents={incidents} active />
            </div>
          )}

          {view === "incidents" && (
            <IncidentsPanel incidents={incidents} worldStatus={state.data?.worldStatus.worldStatus ?? "unseeded"} />
          )}

          {/* Chat stays mounted-but-hidden: unmounting would kill an in-flight SSE chat stream.
              The other five views are safe to unmount — usePoll refetches on mount. */}
          <div className={onChat ? "flex flex-col" : "hidden"}>
            <ChatPanel />
          </div>
        </main>
      </div>

      <TabBar view={view} onNavigate={navigate} liveIncidents={liveIncidents} />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
```

Note on `active`: `AnalyticsRow` and `DeploysCard` keep their `active`-gated polls, but conditional rendering now IS the gate — they only exist while their view is up, so they receive a constant `active`. The prop is kept (not removed) because it still expresses "poll only while shown" at the component's seam.

- [ ] **Step 2: Verify it builds**

Run: `pnpm build:ui`
Expected: exits 0, no unused-variable errors (the old `NavTab` and `View` type are gone with the rewrite).

- [ ] **Step 3: Smoke-check in the browser**

Run: `pnpm dev`, open the UI dev URL (vite prints it; API is proxied to wrangler).
Expected: rail visible ≥1024px wide with Overview active; clicking Systems changes the hash to `#/systems` and swaps the view; browser Back returns to Overview; below 1024px the rail disappears and the bottom tab bar appears.

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): sidenav shell — six hash-routed views, slim header, bottom tab bar"
```

---

### Task 5: Dedicated-view layout props + Chat height

**Files:**
- Modify: `ui/src/panels/Chaos.tsx:110,163` (add `wide` prop; scenario list becomes a 2-col grid when wide)
- Modify: `ui/src/panels/Deploys.tsx:119-146` (add `maxRows` prop)
- Modify: `ui/src/panels/Chat.tsx:358` (height accounts for slimmer chrome + mobile tab bar)
- Modify: `ui/src/App.tsx` (pass the new props at the two dedicated-view call sites)

**Interfaces:**
- Consumes: the Task 4 call sites.
- Produces:
  - `ChaosPanel({ worldStatus, onActionSettled, wide? })` — `wide?: boolean`, default `false`
  - `DeploysCard({ incidents, active, maxRows? })` — `maxRows?: number`, default `8`

- [ ] **Step 1: Add `wide` to `ChaosPanel`**

In `ui/src/panels/Chaos.tsx`, change the signature (line 110):

```tsx
export function ChaosPanel({
  worldStatus,
  onActionSettled,
  wide = false,
}: {
  worldStatus: WorldStatusView;
  onActionSettled: () => void;
  wide?: boolean;
}) {
```

and the scenario list container (line 163) from `<div className="flex flex-col gap-3">` to:

```tsx
      {/* In the dedicated Chaos view the four scenarios sit two-up — the rail's stacked list
          reads as a queue; the wide grid reads as a menu of equals. */}
      <div className={wide ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "flex flex-col gap-3"}>
```

- [ ] **Step 2: Add `maxRows` to `DeploysCard`**

In `ui/src/panels/Deploys.tsx`, change the signature (line 119):

```tsx
export function DeploysCard({
  incidents,
  active,
  maxRows = MAX_ROWS,
}: {
  incidents: IncidentView[];
  active: boolean;
  maxRows?: number;
}) {
```

then inside the body replace `deploys.slice(0, MAX_ROWS)` with `deploys.slice(0, maxRows)` and the footer condition `deploys.length > MAX_ROWS` / `deploys.length - MAX_ROWS` with `deploys.length > maxRows` / `deploys.length - maxRows`. (`MAX_ROWS` stays defined — it's the default.)

- [ ] **Step 3: Pass the props in `ui/src/App.tsx`**

In the `view === "chaos"` branch add `wide`:

```tsx
<ChaosPanel worldStatus={state.data.worldStatus} onActionSettled={state.refresh} wide />
```

In the `view === "deploys"` branch add `maxRows`:

```tsx
<DeploysCard incidents={incidents} active maxRows={Number.POSITIVE_INFINITY} />
```

(`slice(0, Infinity)` legitimately means "all rows"; the "+N more" footer can then never render.)

- [ ] **Step 4: Chat height**

In `ui/src/panels/Chat.tsx` line 358, replace the section's `h-[calc(100vh-11rem)]` with:

```
h-[calc(100dvh-12rem)] min-h-[420px] lg:h-[calc(100dvh-8rem)]
```

(`12rem` ≈ header + main padding + the mobile tab bar; `8rem` ≈ header + padding on desktop where the bar is gone. `dvh` tracks mobile browser chrome; exact values are re-checked visually in Task 6.)

- [ ] **Step 5: Verify it builds**

Run: `pnpm build:ui`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add ui/src/panels/Chaos.tsx ui/src/panels/Deploys.tsx ui/src/panels/Chat.tsx ui/src/App.tsx
git commit -m "feat(ui): dedicated-view layouts — chaos grid, full deploy list, taller chat"
```

---

### Task 6: Browser verification pass

**Files:**
- Modify: none planned — only visual-nit fixes discovered here (each gets its own small commit).

**Interfaces:** none — this is the spec's verification section executed.

- [ ] **Step 1: Start the app**

Run: `pnpm dev` (worker + vite together). Open the vite URL.

- [ ] **Step 2: Desktop pass (~1440px), light theme**

Check, in order:
1. Rail shows all six items; Overview active; active style matches the old pill (hairline border, raised panel).
2. Collapse chevron → 64px icon rail; labels appear as tooltips; reload → still collapsed (persistence); expand → reload → still expanded.
3. Each view renders at its spec width: Systems full-container, Chaos centered 2-col grid, Deploys centered full list, Incidents full-width feed, Chat fills the viewport height without page scroll.
4. Hash updates per view; deep-load `#/chaos` directly → Chaos view; Back/Forward walk the view history; an unknown hash (`#/nope`) lands on Overview.
5. With a live incident (trigger a chaos scenario or use seeded data): red count badge on the rail's Incidents item.
6. `WorldStatusBanner` visible on every non-chat view while the world is seeding/unseeded; absent on Chat.

- [ ] **Step 3: Mobile pass (~390px), light theme**

1. Header is one row (wordmark left, toggle + pill right); no rail.
2. Bottom tab bar: six items fit, active item inked, incident dot renders.
3. Scroll each view to the bottom — content clears the bar (pb-24).
4. Chat: composer visible above the tab bar, no double scrollbar.
5. Open an incident's detail modal — it layers ABOVE the tab bar (modal is z-[60]+).

- [ ] **Step 4: Dark theme spot-check**

Toggle dark at both widths: rail/tab bar surfaces use `bg-panel` + `border-hairline` (auto-retheme), badge legible, active item legible.

- [ ] **Step 5: Chat-stream survival**

Start a chat turn, switch to Systems mid-stream, return to Chat: the stream is still rendering (mounted-but-hidden held it).

- [ ] **Step 6: Full test suite (worker untouched — confirm)**

Run: `pnpm test && pnpm typecheck`
Expected: both pass (no worker file changed; this is the regression floor).

- [ ] **Step 7: Commit any nit fixes**

```bash
git add -A ui/src
git commit -m "fix(ui): visual nits from sidenav verification pass"
```

(Skip if nothing changed.)
