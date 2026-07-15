import { useEffect, useState } from "react";

type HealthResponse = {
  ok: boolean;
  worldStatus: string;
};

type HealthState =
  | { status: "loading" }
  | { status: "ok"; data: HealthResponse }
  | { status: "error"; message: string };

function StatusBadge({ health }: { health: HealthState }) {
  if (health.status === "loading") {
    return (
      <span className="rounded-full border border-neutral-700 px-3 py-1 text-sm text-neutral-400">
        checking…
      </span>
    );
  }

  if (health.status === "error") {
    return (
      <span className="rounded-full border border-red-800 bg-red-950 px-3 py-1 text-sm text-red-400">
        offline
      </span>
    );
  }

  const isOk = health.data.ok;
  return (
    <span
      className={
        isOk
          ? "rounded-full border border-emerald-800 bg-emerald-950 px-3 py-1 text-sm text-emerald-400"
          : "rounded-full border border-red-800 bg-red-950 px-3 py-1 text-sm text-red-400"
      }
    >
      {isOk ? `OK · ${health.data.worldStatus}` : "unhealthy"}
    </span>
  );
}

export default function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/health")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as HealthResponse;
        if (!cancelled) setHealth({ status: "ok", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHealth({
            status: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">Watchtower</h1>
        <StatusBadge health={health} />
      </header>
      <main className="px-6 py-8 text-neutral-400">
        <p>Production-watchdog agent. Panels land in later tasks.</p>
      </main>
    </div>
  );
}
