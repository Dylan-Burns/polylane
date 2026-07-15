/**
 * The agent loop core (spec §9's "Loop mechanics") — the heart of the investigator (and, later,
 * chat via `thinkingOverride` + omitting `submitReportTool`). Domain-agnostic: it knows nothing
 * about telemetry, incidents, or D1 — only `LLM`, `ToolDef`s, an `executeTool` callback, and a
 * budget. Everything below is mock-LLM tested (`scriptedLLM`); nothing here does network I/O or
 * reads a wall clock directly (`nowFn` is injected — see the purity note above `runLoop`).
 *
 * Iteration order per spec §9: check for an undelivered detector update (inject as a user
 * message) → model call → execute any tool calls → append capped results → repeat. Termination is
 * normally the model calling `submit_report` (investigator) or ending its turn with text (chat,
 * no `submitReportTool`). Every other path — `end_turn` without a report, a tripped cap, or a
 * loop-guard nudge that got ignored — funnels through a single one-shot `salvage()` call with
 * `tool_choice` forced to `submit_report`; if that also comes back without a report, the outcome
 * is `'failed'`. The loop never throws: any unexpected condition (a malformed scripted response,
 * an `llm.create` rejection, a bug in this file) is caught at the top level and turned into
 * `{outcome: 'failed', steps: [...,  {kind: 'error', ...}]}` instead of propagating.
 */

import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  OutputConfig,
  TextBlock,
  ThinkingConfigParam,
  Tool,
  ToolChoice,
  ToolResultBlockParam,
  ToolUnion,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { ToolDef } from "./tools";
import type { LLM, SystemBlock } from "./llm";
import { parseWindow, type WindowInput } from "./window";

// --- Public types -------------------------------------------------------------------------

export interface StepRecord {
  step_no: number;
  kind: "tool_call" | "tool_result" | "note" | "report" | "error";
  /** JSON-serializable — this is persisted verbatim (Task 4.2: `investigation_steps` row shape). */
  content: unknown;
  ts_ms: number;
  tokens_in: number;
  tokens_out: number;
}

export interface LoopCaps {
  maxSteps: number;
  maxWallMs: number;
  maxTokensIn: number;
  maxTokensOut: number;
}

/** The investigator's default thinking/effort policy (Global Constraints, spec §9): bounded
 * adaptive thinking at medium effort. Chat mode (Task 6.1) supplies its own via
 * `cfg.thinkingOverride` (`{type: "adaptive", display: "summarized"}`, no `output_config`) rather
 * than this module special-casing "chat" — the seam the task brief asks for. */
export interface ThinkingPolicy {
  thinking: ThinkingConfigParam;
  outputConfig?: OutputConfig;
}

const DEFAULT_THINKING_POLICY: ThinkingPolicy = {
  thinking: { type: "adaptive" },
  outputConfig: { effort: "medium" },
};

export interface LoopConfig {
  llm: LLM;
  model: string;
  /** Byte-stable per investigation (caller's responsibility — spec §9: the open-time timestamp is
   * stamped once, not per call). `runLoop` never mutates this array or its blocks; it only reads
   * from it when building each request's `system` (see `systemForRequest`). */
  system: SystemBlock[];
  tools: ToolDef[];
  executeTool: (name: string, input: unknown) => Promise<object>;
  caps: LoopCaps;
  /** Present for the investigator (ends the investigation); absent for chat (final text is the
   * answer — behavioral contract test 7). */
  submitReportTool?: ToolDef;
  /** Persistence hook — awaited BEFORE the next model call (behavioral contract test 8), so a
   * caller (Task 4.2's `InvestigatorDO`) can guarantee a step is durable before any further model
   * spend happens. */
  onStep?: (step: StepRecord) => Promise<void>;
  /** Undelivered detector updates, checked once per iteration; a non-null return is injected as a
   * user message (prefixed `"detector update: "`) immediately before the next model call. */
  checkUpdates?: () => Promise<string | null>;
  /** No `Date.now()` anywhere in this module — every timestamp and every wall-clock comparison
   * goes through this. */
  nowFn: () => number;
  /** Seam for chat mode (Task 6.1) to swap in its own thinking/effort policy without this module
   * needing an `isChat` flag. */
  thinkingOverride?: ThinkingPolicy;
}

export interface LoopResult {
  outcome: "report" | "text" | "failed";
  report?: unknown;
  text?: string;
  steps: StepRecord[];
  usage: { in: number; out: number };
}

// --- Constants -----------------------------------------------------------------------------

/** `max_tokens` for every call. Sized generously above the per-investigation output budget's
 * rough per-step share (spec §9: ~16k out across ~15 steps ≈ 1.1k/step) so adaptive thinking —
 * which bills as output against this same ceiling (Global Constraints) — and a full
 * `submit_report` payload on the salvage call both have headroom. This is a per-call generation
 * ceiling, not the spend control: the real budget is `caps.maxTokensOut`, enforced across the
 * whole loop by the cap check below, not by squeezing this constant. */
const MAX_TOKENS_PER_CALL = 8192;

/** The instruction appended as a user message for the one-shot salvage call (spec §9, verbatim). */
const SALVAGE_INSTRUCTION = "conclude with what you have; state low confidence";

/** Loop-guard thresholds (spec §9): the *third* consecutive identical tool call gets a synthetic
 * error result nudging toward `submit_report`; a *fourth* (the nudge ignored) forces salvage
 * instead of nudging again or looping forever. */
const NUDGE_AT_COUNT = 3;
const FORCE_SALVAGE_AT_COUNT = 4;

// --- Request building ------------------------------------------------------------------------

/** Adapts `tools.ts`'s internal `ToolDef` (deliberately decoupled from the SDK, graded on its own
 * strict-schema correctness — Task 2.2) to the wire shape `MessageCreateParams.tools` expects. The
 * cast is narrow and documented rather than a blanket `as unknown as ToolUnion[]` over the whole
 * array: `ToolDef.input_schema.type` is typed `string | readonly string[]` (nullable-field unions
 * like `["string", "null"]`) where the SDK wants the literal `"object"` plus a permissive
 * `[k: string]: unknown` bag — both true in practice for every schema `tools.ts` builds, just not
 * expressible identically in both places. */
function toApiTool(def: ToolDef): ToolUnion {
  return {
    name: def.name,
    description: def.description,
    input_schema: def.input_schema as unknown as Tool.InputSchema,
    strict: def.strict,
  };
}

/** Returns a NEW array with a `cache_control` breakpoint added to the last block only — never
 * mutates `system` itself (byte-stability across an investigation is the caller's job; this
 * module must not be the thing that breaks it). */
function systemForRequest(system: readonly SystemBlock[]): SystemBlock[] {
  if (system.length === 0) return [];
  const lastIdx = system.length - 1;
  return system.map((block, i) => (i === lastIdx ? { ...block, cache_control: { type: "ephemeral" } } : block));
}

/** Returns a NEW message with a `cache_control` breakpoint added to its last content block. A
 * plain-string `content` is normalized to a one-block array first (the breakpoint target must be
 * a content block, and a string message has no other legitimate representation for this purpose).
 * Never mutates the input message or its blocks. */
function withCacheOnLastBlock(message: MessageParam): MessageParam {
  const content: ContentBlockParam[] =
    typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
  if (content.length === 0) return message;
  const lastIdx = content.length - 1;
  // `ContentBlockParam` is a union and not every member (e.g. thinking/redacted_thinking blocks)
  // declares `cache_control` — but those never legitimately reach this function as the LAST block
  // of the LAST message (that position is always a text/tool_result block in every call site this
  // loop actually builds; see the doc comment above). The `unknown` hop is a deliberate, narrow
  // escape from the union's per-member excess-property check, not a blanket type-safety opt-out.
  content[lastIdx] = { ...content[lastIdx], cache_control: { type: "ephemeral" } } as unknown as ContentBlockParam;
  return { ...message, content };
}

/**
 * Builds the `messages` array for ONE request: a shallow copy of `messages` with a
 * `cache_control` breakpoint added to a fresh copy of the last message only. Critically, this
 * never mutates any message already in `messages` — every prior message keeps the exact object
 * identity it has always had, so (a) a message that was "most recent" in an earlier iteration
 * never carries a stale/duplicated breakpoint once a later message supersedes it as "most
 * recent" (there is nothing to remove — it was never added to the stored object in the first
 * place), and (b) the verbatim-echo requirement for assistant turns (thinking-block signatures)
 * holds exactly, since this function is the only place cache_control is ever attached and it
 * always operates on a copy scoped to a single outgoing request.
 */
function messagesForRequest(messages: readonly MessageParam[]): MessageParam[] {
  if (messages.length === 0) return [];
  const copy = [...messages];
  const lastIdx = copy.length - 1;
  copy[lastIdx] = withCacheOnLastBlock(copy[lastIdx] as MessageParam);
  return copy;
}

function buildParams(cfg: LoopConfig, messages: readonly MessageParam[], toolChoice?: ToolChoice): MessageCreateParamsNonStreaming {
  const policy = cfg.thinkingOverride ?? DEFAULT_THINKING_POLICY;
  const tools = cfg.submitReportTool ? [...cfg.tools, cfg.submitReportTool] : cfg.tools;
  return {
    model: cfg.model,
    max_tokens: MAX_TOKENS_PER_CALL,
    system: systemForRequest(cfg.system),
    messages: messagesForRequest(messages),
    tools: tools.map(toApiTool),
    thinking: policy.thinking,
    output_config: policy.outputConfig,
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

// --- Loop-guard: duplicate tool-call detection ------------------------------------------------

/** Deep-clones `value` with every object's keys sorted, so `JSON.stringify` of the result is
 * insensitive to key order — two structurally-identical tool inputs built with keys in a
 * different order must compare equal. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Normalizes a tool call's `input` so the loop guard compares *absolute* time windows, not raw
 * relative-offset strings (spec §9: "time-advancing re-checks of the same query are legitimate
 * investigation, not a stuck loop"). Two calls with `window: {from: "-30m", to: null}` issued
 * minutes apart resolve to different absolute `[fromMs, toMs)` bounds and are correctly NOT
 * flagged as duplicates; two calls that resolve to the exact same bounds are. Reuses `parseWindow`
 * (the same resolution `tools.ts`/`read.ts` apply) rather than re-implementing offset parsing —
 * best-effort: a `window` that fails to parse just falls back to raw comparison (the real error
 * surfaces from `executeTool` itself, not from the loop guard).
 */
function normalizeToolInput(input: unknown, nowMs: number): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const rec = input as Record<string, unknown>;
  if (!("window" in rec)) return rec;
  const windowVal = rec.window;
  if (windowVal === null || typeof windowVal !== "object" || Array.isArray(windowVal)) return rec;
  try {
    const resolved = parseWindow(windowVal as WindowInput, nowMs);
    return { ...rec, window: resolved };
  } catch {
    return rec;
  }
}

function callSignature(name: string, input: unknown, nowMs: number): string {
  return `${name}::${JSON.stringify(sortKeysDeep(normalizeToolInput(input, nowMs)))}`;
}

function nudgeText(submitReportTool: ToolDef | undefined): string {
  return submitReportTool
    ? `This exact tool call has been repeated ${NUDGE_AT_COUNT} times in a row with no new information. If you have enough evidence, call ${submitReportTool.name} now; otherwise try a materially different query.`
    : `This exact tool call has been repeated ${NUDGE_AT_COUNT} times in a row with no new information. Try a materially different query.`;
}

// --- runLoop -----------------------------------------------------------------------------------

function extractText(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Drives the agent loop to termination. Never throws — see this file's top-of-file doc comment
 * for the "never throws" contract and the salvage/nudge/cap semantics (spec §9). Purity: the only
 * I/O is through `cfg.llm`, `cfg.executeTool`, `cfg.onStep`, `cfg.checkUpdates`; the only notion of
 * "now" is `cfg.nowFn()` — no `Date.now()` anywhere in this module.
 */
export async function runLoop(cfg: LoopConfig, initialMessages: MessageParam[]): Promise<LoopResult> {
  const steps: StepRecord[] = [];
  let stepNo = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const messages: MessageParam[] = [...initialMessages];
  const startMs = cfg.nowFn();
  let iterations = 0;
  let lastSignature: string | null = null;
  let consecutiveCount = 0;

  const usage = () => ({ in: tokensIn, out: tokensOut });

  async function record(kind: StepRecord["kind"], content: unknown, tokensInDelta = 0, tokensOutDelta = 0): Promise<void> {
    stepNo += 1;
    const step: StepRecord = { step_no: stepNo, kind, content, ts_ms: cfg.nowFn(), tokens_in: tokensInDelta, tokens_out: tokensOutDelta };
    steps.push(step);
    if (cfg.onStep) await cfg.onStep(step);
  }

  /** One model call: builds params, calls `cfg.llm.create` with a per-call timeout clamped to the
   * remaining wall-clock budget (`llm.ts`'s deadline contract), and folds `response.usage` into
   * the running totals. Rejections are NOT caught here — they propagate to `runLoop`'s top-level
   * catch, which is exactly the "llm.create rejection -> outcome 'failed'" contract. */
  async function callModel(toolChoice?: ToolChoice): Promise<Message> {
    const remainingMs = Math.max(0, cfg.caps.maxWallMs - (cfg.nowFn() - startMs));
    const params = buildParams(cfg, messages, toolChoice);
    const response = await cfg.llm.create(params, remainingMs);
    tokensIn += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
    tokensOut += response.usage.output_tokens;
    return response;
  }

  /** The one-shot salvage path (spec §9): append the salvage instruction as a user message, force
   * `tool_choice` to `submit_report`, and accept exactly whatever comes back — a report, or
   * `'failed'`. Called at most once per investigation, from three sites: an `end_turn` without a
   * report, a tripped cap, or an ignored loop-guard nudge. */
  async function salvage(): Promise<LoopResult> {
    if (!cfg.submitReportTool) {
      await record("error", { message: "budget exhausted with no submit_report tool to salvage into (chat mode)" });
      return { outcome: "failed", steps, usage: usage() };
    }
    const submitReportTool = cfg.submitReportTool;
    messages.push({ role: "user", content: [{ type: "text", text: SALVAGE_INSTRUCTION }] });
    const response = await callModel({ type: "tool", name: submitReportTool.name });
    // Verbatim echo — see the top-of-file contract; this is the exact array the model returned.
    messages.push({ role: "assistant", content: response.content as unknown as ContentBlockParam[] });

    const reportBlock = response.content.find((b): b is ToolUseBlock => b.type === "tool_use" && b.name === submitReportTool.name);
    if (reportBlock) {
      await record("report", reportBlock.input, response.usage.input_tokens, response.usage.output_tokens);
      return { outcome: "report", report: reportBlock.input, steps, usage: usage() };
    }
    await record("error", { message: "salvage call did not return a submit_report tool call", stop_reason: response.stop_reason });
    return { outcome: "failed", steps, usage: usage() };
  }

  try {
    while (true) {
      // --- Cap check, before doing anything else this iteration ---------------------------
      const elapsedMs = cfg.nowFn() - startMs;
      if (
        iterations >= cfg.caps.maxSteps ||
        elapsedMs >= cfg.caps.maxWallMs ||
        tokensIn >= cfg.caps.maxTokensIn ||
        tokensOut >= cfg.caps.maxTokensOut
      ) {
        return await salvage();
      }

      // --- Undelivered detector updates -----------------------------------------------------
      if (cfg.checkUpdates) {
        const update = await cfg.checkUpdates();
        if (update !== null) {
          const text = `detector update: ${update}`;
          messages.push({ role: "user", content: [{ type: "text", text }] });
          await record("note", { update });
        }
      }

      // --- Model call -------------------------------------------------------------------------
      const response = await callModel();
      // Verbatim echo (spec §9): the exact content array, including signed thinking blocks,
      // becomes the next assistant turn unchanged.
      messages.push({ role: "assistant", content: response.content as unknown as ContentBlockParam[] });

      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

      if (toolUses.length === 0) {
        if (cfg.submitReportTool) {
          return await salvage();
        }
        if (response.stop_reason === "end_turn") {
          return { outcome: "text", text: extractText(response.content), steps, usage: usage() };
        }
        await record("error", { message: `unexpected stop_reason with no tool calls: ${String(response.stop_reason)}` });
        return { outcome: "failed", steps, usage: usage() };
      }

      // --- Process each tool call in order ----------------------------------------------------
      const results: ToolResultBlockParam[] = [];
      let forceSalvage = false;
      for (const toolUse of toolUses) {
        if (cfg.submitReportTool && toolUse.name === cfg.submitReportTool.name) {
          await record("report", toolUse.input, response.usage.input_tokens, response.usage.output_tokens);
          return { outcome: "report", report: toolUse.input, steps, usage: usage() };
        }

        await record("tool_call", { tool_use_id: toolUse.id, name: toolUse.name, input: toolUse.input }, response.usage.input_tokens, response.usage.output_tokens);

        const signature = callSignature(toolUse.name, toolUse.input, cfg.nowFn());
        if (signature === lastSignature) consecutiveCount += 1;
        else {
          lastSignature = signature;
          consecutiveCount = 1;
        }

        if (consecutiveCount >= FORCE_SALVAGE_AT_COUNT) {
          const output = { error: "repeated call ignored after the loop-guard nudge; concluding the investigation" };
          results.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(output), is_error: true });
          await record("tool_result", { tool_use_id: toolUse.id, name: toolUse.name, output, is_error: true });
          forceSalvage = true;
          continue;
        }

        if (consecutiveCount === NUDGE_AT_COUNT) {
          const output = { error: nudgeText(cfg.submitReportTool) };
          results.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(output), is_error: true });
          await record("tool_result", { tool_use_id: toolUse.id, name: toolUse.name, output, is_error: true });
          continue;
        }

        let output: object;
        let isError = false;
        try {
          output = await cfg.executeTool(toolUse.name, toolUse.input);
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
          isError = true;
        }
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(output), is_error: isError });
        await record("tool_result", { tool_use_id: toolUse.id, name: toolUse.name, output, is_error: isError });
      }

      messages.push({ role: "user", content: results });
      iterations += 1;

      if (forceSalvage) {
        return await salvage();
      }
    }
  } catch (err) {
    try {
      await record("error", { message: err instanceof Error ? err.message : String(err) });
    } catch {
      // A broken onStep must not defeat the "loop never throws" guarantee.
    }
    return { outcome: "failed", steps, usage: usage() };
  }
}
