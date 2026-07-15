import { Wordmark } from "./components/Wordmark";
import { Pill } from "./components/Pill";
import { getIncidents, getState } from "./lib/api";
import { usePoll } from "./lib/poll";
import { ToastProvider } from "./lib/toast";
import type { StateResponse } from "./lib/types";
import { ChaosPanel } from "./panels/Chaos";
import { ChatTab } from "./panels/Chat";
import { IncidentsPanel } from "./panels/Incidents";
import { SystemView, WorldStatusBanner } from "./panels/System";

const STATE_POLL_MS = 5000;
const INCIDENTS_POLL_MS = 10_000;

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
  const state = usePoll(getState, STATE_POLL_MS);
  const incidentsPoll = usePoll(getIncidents, INCIDENTS_POLL_MS);
  const incidents = incidentsPoll.data?.incidents ?? [];

  return (
    <div className="min-h-screen bg-void text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-3 sm:gap-6">
          <Wordmark />
          <nav className="flex items-center gap-1 rounded-lg border border-hairline bg-panel p-1">
            <span className="whitespace-nowrap rounded-md bg-panel-raised px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-ink">Dashboard</span>
            <ChatTab />
          </nav>
        </div>
        <WorldStatusPill state={state.data} error={state.error} />
      </header>

      <main className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
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
