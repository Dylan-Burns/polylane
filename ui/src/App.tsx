import { useState } from "react";
import { Wordmark } from "./components/Wordmark";
import { Pill } from "./components/Pill";
import { getIncidents, getState } from "./lib/api";
import { usePoll } from "./lib/poll";
import { ToastProvider } from "./lib/toast";
import type { StateResponse } from "./lib/types";
import { ChatPanel } from "./panels/Chat";
import { ChaosPanel } from "./panels/Chaos";
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
      className={`whitespace-nowrap rounded-md px-3 py-1.5 font-mono text-xs uppercase tracking-wide transition-colors ${
        active ? "bg-panel-raised text-ink" : "text-ink-faint hover:text-ink-dim"
      }`}
    >
      {label}
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
          <nav className="flex items-center gap-1 rounded-lg border border-hairline bg-panel p-1">
            <NavTab label="Dashboard" active={view === "dashboard"} onClick={() => setView("dashboard")} />
            <NavTab label="Chat" active={view === "chat"} onClick={() => setView("chat")} />
          </nav>
        </div>
        <WorldStatusPill state={state.data} error={state.error} />
      </header>

      <main className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        {/* Both views stay mounted and are toggled with `hidden` rather than conditionally
            rendered — switching to Chat and back must never interrupt an in-flight chat stream or
            drop the polling cadence the dashboard already relies on. */}
        <div className={view === "dashboard" ? "flex flex-col gap-6" : "hidden"}>
          {state.data && <WorldStatusBanner worldStatus={state.data.worldStatus} />}

          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            {state.data ? (
              <SystemView state={state.data} incidents={incidents} />
            ) : (
              <LoadingCard label={state.error !== undefined ? "Couldn't reach Watchtower's API." : "Loading system view…"} />
            )}
            {state.data ? (
              <ChaosPanel worldStatus={state.data.worldStatus} onActionSettled={state.refresh} />
            ) : (
              <LoadingCard label="Loading chaos panel…" />
            )}
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
