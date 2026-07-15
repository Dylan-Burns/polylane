/**
 * The seam that makes the agent loop (`loop.ts`) testable without the network — spec §9's
 * "honesty boundary" pattern, mirrored for the model itself rather than for telemetry: `LLM` is
 * the *only* way `runLoop` talks to Claude. `realLLM` wraps the actual Anthropic SDK client;
 * `scriptedLLM` is a deterministic test double that plays back a fixed script of responses. Swap
 * one for the other and `loop.ts` is unchanged — exactly the same seam `read.ts` is for the query
 * layer.
 *
 * Nothing in this module is called anywhere yet: the network is down for this task, `realLLM` is
 * written to the Global Constraints' letter (client construction only — no request is issued by
 * merely constructing it) and gets wired live in Task 4.3.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { Env } from "../env";

/** The `system` array shape `LoopConfig` takes — a plain alias, since the SDK has no type named
 * `SystemBlock` of its own (`MessageCreateParamsBase.system` is `string | Array<TextBlockParam>`;
 * this project always uses the array form so a cache_control breakpoint can be attached to the
 * last block — see loop.ts's prompt-caching doc comment). */
export type SystemBlock = TextBlockParam;

/**
 * `create`'s second, optional argument is a per-call timeout override in milliseconds. The Global
 * Constraints fix the *client's* default at 60s (`new Anthropic({ maxRetries: 3, timeout: 60_000
 * })`), but a single call must never wait longer than the loop's own remaining wall-clock budget —
 * otherwise one hung request could burn an entire 4-minute investigation cap instead of degrading
 * into the salvage path (spec §9). `loop.ts` computes `remaining = maxWallMs - elapsed` every
 * iteration via its injected `nowFn` (never `Date.now()` — see loop.ts's purity note) and passes
 * it here; `realLLM` clamps it to `[0, 60_000]` before handing it to the SDK as a per-request
 * timeout override. Omitting the argument — every literal `create(params)` call the brief's
 * interface sketch shows — just falls back to the client's own 60s default: the two-argument form
 * is additive to, not a break from, the one-argument interface sketch.
 */
export interface LLM {
  create(params: MessageCreateParamsNonStreaming, timeoutMs?: number): Promise<Message>;
}

/** The client's own default per-call timeout (Global Constraints) and the ceiling `realLLM`
 * clamps every per-call override to — a caller can ask for less (a tighter remaining budget) but
 * never more. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The real Anthropic-backed `LLM`. The SDK does the retrying (`maxRetries: 3`) — no hand-rolled
 * backoff (Global Constraints). `thinking`/`output_config`/`cache_control`/`tool_choice` are NOT
 * set here: those depend on per-call, per-iteration state (which message is "most recent", is
 * this a salvage call, chat-mode override, ...) that only `loop.ts` has — this module's only job
 * is turning a fully-formed `MessageCreateParams` into a network call with the right retry/timeout
 * policy, identically for every caller.
 */
export function realLLM(env: Pick<Env, "ANTHROPIC_API_KEY">): LLM {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: DEFAULT_TIMEOUT_MS });
  return {
    create(params, timeoutMs) {
      const timeout = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Math.max(0, Math.min(DEFAULT_TIMEOUT_MS, timeoutMs));
      return client.messages.create(params, { timeout });
    },
  };
}

/** `scriptedLLM`'s own interface: everything `LLM` has, plus the captured call history tests
 * assert against. `requests`/`timeouts` are parallel arrays (same index = same call) rather than
 * an array of pairs, so tests can `expect(llm.requests[1].messages)...` without destructuring. */
export interface ScriptedLLM extends LLM {
  /** Every `params` object passed to `create`, in call order. */
  readonly requests: MessageCreateParamsNonStreaming[];
  /** Every `timeoutMs` passed to `create`, in call order (`undefined` when the caller omitted
   * it) — lets tests assert the remaining-wall-budget deadline plumbing without a real clock. */
  readonly timeouts: (number | undefined)[];
}

/**
 * Deterministic test double for `LLM`: plays back `script` in order, one `Message` per `create`
 * call, and throws if the loop calls `create` more times than the script provides. A script
 * running dry means the loop kept going (or failed to salvage/terminate) when the test expected
 * it to stop — a bug worth failing loudly on, not a silent `undefined` or a hang.
 */
export function scriptedLLM(script: readonly Message[]): ScriptedLLM {
  const requests: MessageCreateParamsNonStreaming[] = [];
  const timeouts: (number | undefined)[] = [];
  let next = 0;
  return {
    requests,
    timeouts,
    async create(params, timeoutMs) {
      requests.push(params);
      timeouts.push(timeoutMs);
      if (next >= script.length) {
        throw new Error(
          `scriptedLLM: create() called ${next + 1} time(s) but the script only has ${script.length} response(s) — ` +
            "the loop kept going (or didn't terminate/salvage) past what the test scripted",
        );
      }
      const response = script[next] as Message;
      next += 1;
      return response;
    },
  };
}
