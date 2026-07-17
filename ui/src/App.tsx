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
                <ChaosPanel worldStatus={state.data.worldStatus} onActionSettled={state.refresh} wide />
              ) : (
                <LoadingCard label="Loading chaos panel…" />
              )}
            </div>
          )}

          {view === "deploys" && (
            <div className="mx-auto w-full max-w-[880px]">
              <DeploysCard incidents={incidents} active maxRows={Number.POSITIVE_INFINITY} />
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
