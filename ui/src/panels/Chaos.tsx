/**
 * Area 2 (spec §11): the four fault-scenario buttons plus Restore and Reset & reseed. Labels,
 * one-line descriptions, and expected-detection timescales all come from `sim/scenarios.ts`'s
 * `SCENARIOS` — the single source of truth the task brief calls for, not re-typed copy that could
 * drift from what the simulator actually does.
 */

import { useState } from "react";
import { SCENARIOS, type ScenarioId } from "../../../src/sim/scenarios";
import { resetWorld, restoreWorld, triggerScenario, type ChaosResult, type ResetResult } from "../lib/api";
import { useToast } from "../lib/toast";
import type { WorldStatusView } from "../lib/types";

const SCENARIO_ORDER: ScenarioId[] = ["bad-deploy", "dependency-outage", "latency-creep", "traffic-spike"];

function scenarioDisabledReason(worldStatus: WorldStatusView): string | null {
  switch (worldStatus.worldStatus) {
    case "unseeded":
      return "The world hasn't been seeded yet — use Reset & reseed below first.";
    case "seeding":
      return "The world is seeding — wait until it's running.";
    case "resetting":
      return "The world is resetting — wait until it's running.";
    case "running":
      if (worldStatus.fault !== null) {
        return `${SCENARIOS[worldStatus.fault.scenario].label} is already running — restore first.`;
      }
      return null;
  }
}

function describeChaosOutcome(result: ChaosResult, actionLabel: string): { tone: "info" | "warning" | "error"; message: string } {
  switch (result.kind) {
    case "ok":
      return { tone: "info", message: `${actionLabel} — the topology will update within a few seconds.` };
    case "scenario_active":
      return { tone: "warning", message: "A scenario is already running — restore it before starting another." };
    case "world_not_ready":
      return { tone: "warning", message: "The world isn't running yet — wait for seeding to finish, then try again." };
    case "cooldown":
      return {
        tone: "warning",
        message: `Chaos actions are on a cooldown — try again in ${Math.ceil(result.retryAfterMs / 1000)}s.`,
      };
    case "error":
      return { tone: "error", message: `Couldn't complete that action (${result.message}).` };
  }
}

function describeResetOutcome(result: ResetResult): { tone: "info" | "warning" | "error"; message: string } {
  switch (result.kind) {
    case "accepted":
      return { tone: "info", message: "Reset accepted — wiping telemetry and reseeding. Incidents are preserved." };
    case "cooldown":
      return {
        tone: "warning",
        message: `Reset is on a cooldown — try again in ${Math.ceil(result.retryAfterMs / 1000)}s.`,
      };
    case "error":
      return { tone: "error", message: `Reset didn't go through (${result.message}).` };
  }
}

function ScenarioCard({
  id,
  disabledReason,
  pending,
  onTrigger,
}: {
  id: ScenarioId;
  disabledReason: string | null;
  pending: boolean;
  onTrigger: (id: ScenarioId) => void;
}) {
  const meta = SCENARIOS[id];
  const isBadDeploy = id === "bad-deploy";
  const disabled = disabledReason !== null || pending;

  return (
    <div
      className={`relative flex flex-col gap-2 rounded-xl border bg-panel px-4 py-3 ${
        isBadDeploy ? "border-signal/40" : "border-hairline"
      }`}
    >
      {isBadDeploy && (
        <span className="absolute -top-2.5 right-3 rounded-full border border-signal/50 bg-void px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-signal-glow">
          Start here → ship a bad deploy and watch
        </span>
      )}
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-semibold text-ink">{meta.label}</h3>
      </div>
      <p className="text-xs leading-relaxed text-ink-dim">{meta.description}</p>
      <p className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
        Detection: <span className="normal-case text-ink-dim">{meta.expectedDetection}</span>
      </p>
      <button
        type="button"
        disabled={disabled}
        title={disabledReason ?? undefined}
        onClick={() => onTrigger(id)}
        className="mt-1 rounded-full border border-hairline bg-panel px-3.5 py-1.5 font-sans text-xs font-medium text-ink transition-colors hover:border-hairline-bright hover:bg-panel-raised disabled:cursor-not-allowed disabled:border-hairline disabled:bg-transparent disabled:text-ink-faint disabled:hover:bg-transparent"
      >
        {pending ? "Starting…" : "Trigger"}
      </button>
    </div>
  );
}

export function ChaosPanel({ worldStatus, onActionSettled }: { worldStatus: WorldStatusView; onActionSettled: () => void }) {
  const toast = useToast();
  const [pendingId, setPendingId] = useState<ScenarioId | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const disabledReason = scenarioDisabledReason(worldStatus);
  const hasFault = worldStatus.fault !== null;

  async function handleTrigger(id: ScenarioId) {
    setPendingId(id);
    const result = await triggerScenario(id);
    setPendingId(null);
    const { tone, message } = describeChaosOutcome(result, `${SCENARIOS[id].label} triggered`);
    toast.push(tone, message);
    if (result.kind === "ok") onActionSettled();
  }

  async function handleRestore() {
    setRestorePending(true);
    const result = await restoreWorld();
    setRestorePending(false);
    const { tone, message } = describeChaosOutcome(result, "World restored");
    toast.push(tone, message);
    if (result.kind === "ok") onActionSettled();
  }

  async function handleReset() {
    if (!confirmingReset) {
      setConfirmingReset(true);
      return;
    }
    setConfirmingReset(false);
    setResetPending(true);
    const result = await resetWorld();
    setResetPending(false);
    const { tone, message } = describeResetOutcome(result);
    toast.push(tone, message);
    if (result.kind === "accepted") onActionSettled();
  }

  const resettingBusy = worldStatus.worldStatus === "seeding" || worldStatus.worldStatus === "resetting";

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-hairline bg-panel/40 p-5">
      <header>
        <h2 className="font-display text-lg font-semibold tracking-tight text-ink">Chaos</h2>
        <p className="mt-1 text-xs text-ink-dim">Inject a fault, watch the watchdog notice, then restore.</p>
      </header>

      {disabledReason && <p className="rounded-lg border border-status-amber/30 bg-status-amber/5 px-3 py-2 text-xs text-status-amber">{disabledReason}</p>}

      <div className="flex flex-col gap-3">
        {SCENARIO_ORDER.map((id) => (
          <ScenarioCard key={id} id={id} disabledReason={disabledReason} pending={pendingId === id} onTrigger={handleTrigger} />
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t border-hairline pt-4">
        <button
          type="button"
          disabled={!hasFault || restorePending}
          title={!hasFault ? "No active scenario to restore." : undefined}
          onClick={handleRestore}
          className="rounded-full border border-hairline bg-panel-raised px-3 py-2 font-sans text-xs font-medium text-ink transition-colors hover:border-hairline-bright disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:border-hairline"
        >
          {restorePending ? "Restoring…" : "Restore"}
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={resettingBusy || resetPending}
            onClick={handleReset}
            onBlur={() => setConfirmingReset(false)}
            className={`flex-1 rounded-lg border px-3 py-2 font-sans text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:text-ink-faint ${
              confirmingReset
                ? "border-status-red/50 bg-status-red/10 text-status-red hover:bg-status-red/20"
                : "border-hairline bg-panel-raised text-ink hover:border-hairline-bright"
            }`}
          >
            {resetPending ? "Resetting…" : confirmingReset ? "Confirm — wipe telemetry?" : "Reset & reseed"}
          </button>
          {confirmingReset && (
            <button
              type="button"
              onClick={() => setConfirmingReset(false)}
              className="rounded-full border border-hairline px-3 py-2 font-sans text-xs text-ink-dim hover:border-hairline-bright"
            >
              Cancel
            </button>
          )}
        </div>
        <p className="text-[11px] text-ink-faint">Wipes telemetry and re-seeds three hours of history. Incidents are preserved.</p>
      </div>
    </section>
  );
}
