import { elapsedSince, formatTokens, prettyJson } from "../../lib/format";
import type { StepView } from "../../lib/types";
import {
  normalizeError,
  normalizeNote,
  normalizeToolCall,
  normalizeToolResult,
  reportStepSummary,
  summarizeToolOutput,
} from "./normalize";

const KIND_META: Record<StepView["kind"], { label: string; accent: string; dot: string }> = {
  tool_call: { label: "tool call", accent: "text-signal-glow", dot: "var(--color-signal)" },
  tool_result: { label: "tool result", accent: "text-ink-dim", dot: "var(--color-signal)" },
  note: { label: "note", accent: "text-ink-faint", dot: "var(--color-ink-faint)" },
  report: { label: "report", accent: "text-status-amber", dot: "var(--color-status-amber)" },
  error: { label: "error", accent: "text-status-red", dot: "var(--color-status-red)" },
};

function TokenBadge({ tokensIn, tokensOut }: { tokensIn: number; tokensOut: number }) {
  if (tokensIn === 0 && tokensOut === 0) return null;
  return (
    <span className="ml-auto shrink-0 font-mono text-[10px] normal-case text-ink-faint">
      {tokensIn > 0 && `${formatTokens(tokensIn)} in`}
      {tokensIn > 0 && tokensOut > 0 && " · "}
      {tokensOut > 0 && `${formatTokens(tokensOut)} out`}
    </span>
  );
}

function RawDisclosure({ value }: { value: unknown }) {
  if (value === undefined) return null;
  return (
    <details className="mt-1 text-[11px]">
      <summary className="cursor-pointer select-none text-ink-faint hover:text-ink-dim">show full result</summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-void/60 p-2 font-mono text-[11px] leading-relaxed text-ink-dim">
        {prettyJson(value)}
      </pre>
    </details>
  );
}

function StepBody({ step }: { step: StepView }) {
  switch (step.kind) {
    case "tool_call": {
      const { name, input } = normalizeToolCall(step.content);
      return (
        <div>
          <p className="font-mono text-xs text-signal-glow">→ {name}</p>
          {input !== undefined && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-void/60 p-2 font-mono text-[11px] leading-relaxed text-ink-dim">
              {prettyJson(input)}
            </pre>
          )}
        </div>
      );
    }
    case "tool_result": {
      const { name, output, isError } = normalizeToolResult(step.content);
      return (
        <div>
          <p className={`font-mono text-xs ${isError ? "text-status-red" : "text-ink-dim"}`}>
            ← {name}
            {isError ? " failed" : ""}
          </p>
          <p className="mt-0.5 text-xs text-ink-dim">{summarizeToolOutput(output)}</p>
          <RawDisclosure value={output} />
        </div>
      );
    }
    case "note":
      return <p className="text-xs italic text-ink-dim">{normalizeNote(step.content)}</p>;
    case "report": {
      const summary = reportStepSummary(step.content);
      return (
        <p className="text-xs text-ink-dim">
          Report submitted{summary ? ` — ${summary}` : ""}.{" "}
          <a href="#incident-report" className="text-signal-glow underline underline-offset-2">
            See the full report below
          </a>
        </p>
      );
    }
    case "error": {
      const { message, stopReason } = normalizeError(step.content);
      return (
        <div>
          <p className="text-xs text-status-red">{message}</p>
          {stopReason && <p className="mt-0.5 font-mono text-[10px] text-ink-faint">stop_reason: {stopReason}</p>}
        </div>
      );
    }
  }
}

export function StepCard({ step, openedAtMs }: { step: StepView; openedAtMs: number }) {
  const meta = KIND_META[step.kind];
  return (
    <li className="animate-step-in relative pl-7">
      <span
        className="absolute left-0 top-2 h-2 w-2 rounded-full ring-2 ring-panel"
        style={{ backgroundColor: meta.dot }}
        aria-hidden="true"
      />
      <div className="rounded-lg border border-hairline bg-panel px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
          <span>#{String(step.step_no).padStart(2, "0")}</span>
          <span className={meta.accent}>{meta.label}</span>
          <span>{elapsedSince(step.ts_ms, openedAtMs)}</span>
          <TokenBadge tokensIn={step.tokens_in} tokensOut={step.tokens_out} />
        </div>
        <div className="mt-1.5">
          <StepBody step={step} />
        </div>
      </div>
    </li>
  );
}
