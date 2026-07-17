/**
 * The investigator's system prompt + initial user turn (spec §9: "role, topology, investigation
 * protocol ... tool guidance, investigation-open timestamp, report rubric"). Both builders here
 * are pure functions of their inputs — no `Date.now()`, no D1/storage reads — because the whole
 * point (Global Constraints: "system prompt byte-stable per investigation; timestamp set once at
 * open") is that `InvestigatorDO` can call `buildInvestigatorSystemPrompt` again, byte-for-byte
 * identically, when it rebuilds a `LoopConfig` to resume after a crash: same `incidentId`,
 * `statement`, and the ORIGINAL `openedAtMs` (persisted once at `/start`, never recomputed) always
 * yield the exact same string, which is what keeps the prompt-cache breakpoint (`loop.ts`'s
 * `cache_control` on the last system block) actually hitting across the resume boundary instead of
 * silently missing.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { SystemBlock } from "./llm";
import { FLOWS, type Step } from "../sim/topology";

/** Renders the service topology as `parent -> child` edges, walked from `topology.ts`'s own
 * `FLOWS` data (never hand-copied) so the prompt can never silently drift from the simulated
 * world it's actually describing. Deduped/sorted since several flows share the same sub-trees
 * (e.g. every flow enters through `gateway`, both payments operations hit the same payments-db
 * steps). Exported so `chat-prompt.ts` (Task 6.1) renders the identical topology summary rather
 * than hand-copying a second version that could silently drift from this one. */
export function renderTopology(): string {
  const edges = new Set<string>();
  const visit = (step: Step): void => {
    for (const child of step.children) {
      edges.add(`${step.service} -> ${child.service}`);
      visit(child);
    }
  };
  for (const flow of FLOWS) visit(flow.entry);
  return [...edges].sort().join("\n");
}

export interface SystemPromptParams {
  incidentId: string;
  /** The anomaly statement the detector opened this investigation with. */
  statement: string;
  /** Stamped ONCE at `/start` and persisted — never recomputed on resume (see the file doc
   * comment's byte-stability rationale). */
  openedAtMs: number;
}

/**
 * Builds the investigator's system prompt (spec §9 protocol: verify -> scope blast radius ->
 * drill down -> check changes -> conclude). Returns a single-block `SystemBlock[]` — `loop.ts`
 * attaches the `cache_control` breakpoint to the last (only) block on every request.
 */
export function buildInvestigatorSystemPrompt(params: SystemPromptParams): SystemBlock[] {
  const openedAtIso = new Date(params.openedAtMs).toISOString();

  const text = [
    "You are Watchtower's investigator agent. You investigate a single production incident in a " +
      "simulated e-commerce system, using only the read-only tools below, and end the investigation " +
      "by calling submit_report exactly once.",
    "",
    "## Service topology",
    renderTopology(),
    "",
    "email-provider is an external dependency notifications calls; it emits no internal spans of " +
      "its own, only a latency/error outcome folded into the calling step.",
    "",
    "## Investigation protocol",
    "Work through these in order, adapting to what you find rather than following it mechanically:",
    "1. Verify — confirm the anomaly is real and still active with query_metrics before anything else.",
    "2. Scope blast radius — which services/operations are affected, and how severely (compare the " +
      "delta overlay against baseline, not just the raw numbers).",
    "3. Drill down — use search_logs / find_traces / get_trace to find concrete failing or slow " +
      "requests and trace the causal chain: which service failed first, and which services merely " +
      "observed the failure downstream.",
    "4. Check changes — use list_deploys to see whether a recent deploy correlates with onset timing.",
    "5. Conclude — call submit_report once you can state a root cause with a defensible confidence " +
      "level. Do not stop at the first anomalous signal; do not keep gathering evidence once the " +
      "story is clear either.",
    "",
    "## Tool guidance",
    "query_metrics, search_logs, find_traces, get_trace, list_deploys, and get_incidents are your " +
      "entire window into this world. Check get_incidents early for whether this fingerprint pattern " +
      "has fired before and what the prior investigation concluded — a recurrence is strong evidence.",
    "Every tool result is capped and shape-aware: a result with truncated: true and a note means " +
      "there is more than shown — narrow your window or add a filter rather than trusting a partial " +
      "view as the whole picture.",
    "An identical tool call repeated with no new information will be rejected with a nudge toward " +
      "concluding — if you have enough evidence, submit the report instead of repeating a query.",
    "",
    "## Report rubric",
    "submit_report ends the investigation. It must contain: a plain-language summary; a " +
      "chronological timeline of the key events; root_cause as a hypothesis plus the mechanism by " +
      "which it produced the observed symptoms; evidence citing the concrete metric deltas, " +
      "trace_ids, and log excerpts that actually support root_cause (not a restatement of the " +
      "trigger); blast_radius naming the affected services and a plain-language customer-impact " +
      "judgment; confidence (calibrated per the guide below); and a concrete suggested_action.",
    "",
    "## Confidence calibration",
    "Set confidence to how directly your evidence supports the proposed mechanism — never to how " +
      "severe or urgent the incident is. Use these anchors:",
    "- high: you traced the causal chain to its origin (a trace or logs showing which service " +
      "failed first and why) AND an independent signal corroborates it — a deploy correlated to " +
      "onset, a matching log signature, or a prior incident with the same fingerprint and cause. " +
      "A trace-confirmed, corroborated mechanism is high confidence even though you cannot read " +
      "the code or config diff: your tools never expose source, so \"the diff wasn't inspected\" is " +
      "not a reason to withhold confidence when the operational evidence is conclusive.",
    "- medium: the mechanism is well-supported, but one link in the chain is inferred rather than " +
      "directly observed, or a plausible alternative cause has not been fully ruled out.",
    "- low: the hypothesis is plausible but a central piece of evidence is missing, the causal " +
      "chain is unconfirmed, or you had to conclude before confirming it.",
    "A recurrence you verified in get_incidents (same fingerprint, same prior cause) is corroborating " +
      "evidence that raises confidence, not a caveat that lowers it. State in confidence.why which " +
      "anchor applies and the single piece of evidence that would raise it.",
    "",
    `Investigation opened at ${openedAtIso} for incident ${params.incidentId}.`,
  ].join("\n");

  return [{ type: "text", text }];
}

/**
 * The investigation's initial user turn: the detector's anomaly statement plus an explicit nudge
 * to check prior-incident context before treating anything as novel (spec §9's loop mechanics:
 * "gives the investigator prior-incident context"). Kept separate from the system prompt (which
 * only carries protocol/rubric, not this specific incident's opening evidence) so the two can be
 * reasoned about independently, matching the task brief's own split.
 */
export function buildInitialMessages(statement: string): MessageParam[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Anomaly detected: ${statement}\n\n` +
            "Before concluding, check get_incidents for whether this fingerprint pattern has occurred " +
            "before and what the prior investigation found — a recurrence with a known cause is strong " +
            "evidence, not something to re-derive from scratch.",
        },
      ],
    },
  ];
}
