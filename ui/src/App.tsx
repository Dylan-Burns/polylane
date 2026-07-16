import { useEffect, useState } from "react";
import { Wordmark } from "./components/Wordmark";
import { Pill } from "./components/Pill";
import { getIncidents, getState } from "./lib/api";
import { usePoll } from "./lib/poll";
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

type View = "dashboard" | "chat";

/** One nav tab (Dashboard | Chat). Both tabs share this one styling so switching views never reads
 * as anything but a plain in-place toggle. */
function NavTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`whitespace-nowrap rounded-full px-3.5 py-1.5 font-sans text-[13px] font-medium transition-colors ${
        active ? "border border-hairline bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

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

function Dashboard() {
  const [view, setView] = useState<View>("dashboard");
  // Polling pauses (intervalMs null) while the Chat view is active — nothing on screen consumes
  // the results, and a chat turn is already competing for the same worker. `usePoll` re-fetches
  // immediately when the interval flips back on, so returning to the dashboard never shows a
  // stale-then-jump frame beyond the first paint.
  const onDashboard = view === "dashboard";
  const state = usePoll(getState, onDashboard ? STATE_POLL_MS : null);
  const incidentsPoll = usePoll(getIncidents, onDashboard ? INCIDENTS_POLL_MS : null);
  const incidents = incidentsPoll.data?.incidents ?? [];

  return (
    <div className="min-h-screen bg-void text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-3 sm:gap-6">
          <Wordmark />
          {/* Polylane's segmented-control pattern: a soft gray pill track, the active segment a
              white pill lifted off it with a hairline and whisper of shadow. */}
          <nav className="flex items-center gap-1 rounded-full bg-panel-raised p-1">
            <NavTab label="Dashboard" active={view === "dashboard"} onClick={() => setView("dashboard")} />
            <NavTab label="Chat" active={view === "chat"} onClick={() => setView("chat")} />
          </nav>
        </div>
        <div className="flex items-center gap-2.5">
          <ThemeToggle />
          <WorldStatusPill state={state.data} error={state.error} />
        </div>
      </header>

      <main className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        {/* Both views stay mounted and are toggled with `hidden` rather than conditionally
            rendered — switching to Chat and back must never interrupt an in-flight chat stream or
            drop the polling cadence the dashboard already relies on. */}
        <div className={view === "dashboard" ? "flex flex-col gap-6" : "hidden"}>
          {state.data && <WorldStatusBanner worldStatus={state.data.worldStatus} />}

          <AnalyticsRow active={onDashboard} />

          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            {state.data ? (
              <SystemView state={state.data} incidents={incidents} />
            ) : (
              <LoadingCard label={state.error !== undefined ? "Couldn't reach Watchtower's API." : "Loading system view…"} />
            )}
            <div className="flex flex-col gap-6">
              {state.data ? (
                <ChaosPanel worldStatus={state.data.worldStatus} onActionSettled={state.refresh} />
              ) : (
                <LoadingCard label="Loading chaos panel…" />
              )}
              <DeploysCard incidents={incidents} active={onDashboard} />
            </div>
          </div>

          <IncidentsPanel incidents={incidents} worldStatus={state.data?.worldStatus.worldStatus ?? "unseeded"} />
        </div>

        <div className={view === "chat" ? "flex flex-col" : "hidden"}>
          <ChatPanel />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}
