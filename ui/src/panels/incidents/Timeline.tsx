/**
 * The hero element (per the task's design brief): the live investigation log. Steps thread onto a
 * continuous vertical spine (the `<ol>`'s left border); while the incident is `investigating`, a
 * pulsing cursor at the tail communicates that this list is still growing on its own — the "wow
 * moment" of watching it advance without any user action.
 */

import type { StepView } from "../../lib/types";
import { StepCard } from "./StepCard";

export function Timeline({
  steps,
  openedAtMs,
  investigating,
}: {
  steps: StepView[];
  openedAtMs: number;
  investigating: boolean;
}) {
  return (
    <div>
      <h3 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Investigation</h3>
      {steps.length === 0 ? (
        <p className="mt-2 text-xs text-ink-dim">
          {investigating ? "The investigator hasn't recorded a step yet — check back in a moment." : "No steps were recorded."}
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2.5 border-l border-hairline pl-0">
          {steps.map((step) => (
            <StepCard key={step.step_no} step={step} openedAtMs={openedAtMs} />
          ))}
        </ol>
      )}
      {investigating && (
        <div className="mt-2.5 flex items-center gap-2 pl-7 font-mono text-[11px] text-ink-faint">
          <span className="h-1.5 w-1.5 animate-scan-pulse rounded-full bg-signal" aria-hidden="true" />
          watching for the next step…
        </div>
      )}
    </div>
  );
}
