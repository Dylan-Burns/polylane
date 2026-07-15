/**
 * Chat backend (spec §9 "Chat mode", Task 6.1) — `POST /api/chat`, the primary abuse surface on
 * this project's unauthenticated URL (Global Constraints; the task brief's framing, verbatim: "the
 * hardening IS the deliverable"). Same loop core as the investigator (`agent/loop.ts`'s `runLoop`,
 * unchanged), same six read tools (`agent/tools.ts`'s `TOOLS`), but no `submitReportTool` — a chat
 * turn ends when the model produces plain text (`LoopResult.outcome === "text"`), never a report.
 *
 * **Streaming design decision** (documented per the task brief's request): token streaming is
 * achieved via `agent/llm.ts`'s `streamingLLM`, an `LLM` implementation that wraps
 * `client.messages.stream()` and fires `StreamHooks` as deltas arrive while still resolving the
 * same `Message` shape `runLoop` already expects — NOT a second, chat-specific loop, and NOT a new
 * field on `LoopConfig`/`LLM.create`. One `streamingLLM(env, hooks)` is constructed per turn, with
 * `hooks` closing over that turn's SSE writer; `runLoop` is used completely unmodified (see
 * `llm.ts`'s doc comment on `StreamHooks` for the full rationale).
 *
 * **Hardening, per spec §9 / the Global Constraints** (this is the actual point of this file):
 *  - `validateChatBody`: the client-held conversation is untrusted input. Oversized bodies,
 *    non-string content (the only way a `tool_use`/`tool_result` block could sneak in), broken
 *    user/assistant alternation, too many turns, and an over-long latest message are all rejected
 *    with 400 before a single token is spent.
 *  - The system prompt (`chat-prompt.ts`) is assembled server-side only; nothing in the validated
 *    history can add to, remove from, or override it.
 *  - Two cost guardrails, both backed by the `meta` key/value table: a global `chat_turns_hour`
 *    counter (<= 60/hour; the fixed-window pattern from `detect/sweep.ts`'s
 *    `tryConsumeInvestigationBudget`, with its documented accepted race) and <= 2 concurrent SSE
 *    slots held as expiring LEASES (`chat_sse_lease:<uuid>` rows; atomic count-gated acquisition —
 *    see `tryAcquireConcurrentSSESlot` for both the atomicity and the self-heal rationale). A
 *    lease is acquired right before a turn's stream opens and ALWAYS released in a `finally`
 *    around the whole pump — wrapped in `waitUntil` so a client that disconnects mid-turn (or any
 *    other in-request crash) can never leak it; for the crashes not even `waitUntil` survives
 *    (isolate hard-kill), the lease TTL reaps the slot at the next acquisition attempt, so
 *    capacity can never ratchet down permanently. Either cap being over budget — or the gate
 *    check itself failing on a D1 error — produces a graceful single SSE `error` event at HTTP
 *    200 (never a hard failure the UI has to special-case), per the task brief.
 *  - The loop itself is capped tighter than the investigator's (8 tool steps / 90s wall / 30k-in /
 *    4k-out budget thresholds — spec §9's cost-guardrail numbers; since the loop checks caps at
 *    each iteration TOP, the effective worst-case output is the ~4k threshold plus one final
 *    call's `MAX_TOKENS_PER_CALL` (8192) ≈ 12k tokens — still hard-bounded, just honestly stated)
 *    — a trip surfaces as a `budget_reached` SSE event (never a hang), classified via
 *    `LoopResult.failure`'s structural discriminant (`"budget"` | `"aborted"` | `"error"`), never
 *    by matching error-step prose.
 *  - A disconnected client stops the turn: `shouldAbort` polls the request's abort signal (and
 *    Hono's stream-level flag) every iteration, so a dropped tab burns at most one in-flight model
 *    call, not the full turn budget.
 *  - Failure detail never reaches the client: any non-budget failure is logged server-side and
 *    surfaced as one fixed generic message (`GENERIC_TURN_ERROR`) — raw SDK/provider error text is
 *    reconnaissance material on an unauthenticated URL.
 */

import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { Env } from "../env";
import { buildChatSystemPrompt } from "../agent/chat-prompt";
import { streamingLLM, type LLM, type StreamHooks } from "../agent/llm";
import { runLoop, type LoopCaps, type StepRecord } from "../agent/loop";
import { executeTool, TOOLS } from "../agent/tools";

// --- validateChatBody ------------------------------------------------------------------------

/** One validated conversation turn — string content only (Global Constraints: "text-only validated
 * turns"). Never a `tool_use`/`tool_result` block: those can only ever originate server-side,
 * within a turn, which is exactly what rejecting non-string `content` here guarantees. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// `status` is pinned to the literal `400` (every validation failure in this file is a 400 — see
// the task brief's own contract) rather than the generic `number` the interface sketch implies:
// Hono's `c.json(body, status)` overload requires a `ContentfulStatusCode` literal/union, and
// every real call site here only ever produces 400 anyway, so the narrower type costs nothing.
export type ValidateChatBodyResult = { ok: true; messages: ChatTurn[] } | { ok: false; status: 400; error: string };

/** Serialized-body cap (Global Constraints / spec §9): 32KB, checked BEFORE any structural
 * validation — an oversized body is rejected on size alone, without ever inspecting its shape. */
export const CHAT_MAX_BODY_BYTES = 32 * 1024;

/** History length cap (Global Constraints / spec §9): "history <= 20 turns". The task's own
 * `validateChatBody` contract and its mandated test ("21 turns... all rejected with 400") make
 * this a hard validation failure, not the Global Constraints summary's "(server-side truncation)"
 * — the task-specific contract is more precise here and is what this function (and its test) are
 * actually graded against. */
export const CHAT_MAX_TURNS = 20;

/** Per-message cap on the LATEST (last) message only — spec §9: "message <= 2k chars". Earlier
 * turns in the history are already bounded transitively by `CHAT_MAX_BODY_BYTES` across at most
 * `CHAT_MAX_TURNS` turns; this cap exists specifically for the fresh, still-unvalidated-by-anything-
 * else user input driving THIS request. */
export const CHAT_MAX_MESSAGE_CHARS = 2000;

/** Rejects anything that isn't a plain JSON object with a non-empty `messages` array of strict
 * user/assistant-alternating, string-only-content turns ending on a user turn, within size/length
 * caps — see the file doc comment. Every failure path returns a specific, distinguishable `error`
 * string (never a generic "invalid body") so a caller can tell the user what to fix, and so tests
 * can assert on which check actually fired. Never throws.
 */
export function validateChatBody(raw: unknown): ValidateChatBodyResult {
  // Size check first, on the RE-serialized form — works whether the caller already ran
  // `JSON.parse` (as `api/chat.ts`'s handler does) or hands this function a raw object directly
  // (as the unit tests do): both cases must be judged by the same "serialized body" yardstick the
  // brief specifies, not by some other proxy (e.g. `JSON.stringify(raw).length` alone would
  // undercount multi-byte UTF-8 content).
  const serialized = JSON.stringify(raw ?? null);
  const bodyBytes = new TextEncoder().encode(serialized).length;
  if (bodyBytes > CHAT_MAX_BODY_BYTES) {
    return { ok: false, status: 400, error: `request body exceeds the ${CHAT_MAX_BODY_BYTES}-byte limit` };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "request body must be a JSON object" };
  }
  const rec = raw as Record<string, unknown>;
  const messagesRaw = rec.messages;
  if (!Array.isArray(messagesRaw)) {
    return { ok: false, status: 400, error: "\"messages\" must be an array" };
  }
  if (messagesRaw.length === 0) {
    return { ok: false, status: 400, error: "\"messages\" must not be empty" };
  }
  if (messagesRaw.length > CHAT_MAX_TURNS) {
    return { ok: false, status: 400, error: `"messages" must not exceed ${CHAT_MAX_TURNS} turns` };
  }

  const messages: ChatTurn[] = [];
  for (let i = 0; i < messagesRaw.length; i++) {
    const item: unknown = messagesRaw[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, status: 400, error: `messages[${i}] must be an object` };
    }
    const itemRec = item as Record<string, unknown>;
    const role = itemRec.role;
    if (role !== "user" && role !== "assistant") {
      return { ok: false, status: 400, error: `messages[${i}].role must be "user" or "assistant"` };
    }
    const content = itemRec.content;
    // This is the check that rejects a fabricated `tool_use`/`tool_result` content ARRAY (or any
    // other object) — `content` must be a plain string, full stop. Tool activity only ever
    // originates server-side, within a turn (file doc comment); there is no legitimate way for a
    // client-supplied turn to carry one.
    if (typeof content !== "string") {
      return { ok: false, status: 400, error: `messages[${i}].content must be a string` };
    }
    messages.push({ role, content });
  }

  // Strict alternation ending on a user turn (Global Constraints / spec §9). Checked explicitly
  // against BOTH ends rather than solely "ends in user + alternates" (which alone would still
  // admit an even-length, assistant-first transcript like [assistant, user]) — the mandated test
  // matrix calls out "assistant-first" as its own rejected case.
  if (messages[0]?.role !== "user") {
    return { ok: false, status: 400, error: "messages[0] must have role \"user\" (conversation must start with the user)" };
  }
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === messages[i - 1]?.role) {
      return { ok: false, status: 400, error: `messages[${i}].role must differ from messages[${i - 1}]?.role (strict alternation)` };
    }
  }
  const last = messages[messages.length - 1];
  if (last?.role !== "user") {
    return { ok: false, status: 400, error: "the last message must have role \"user\"" };
  }
  if (last.content.length > CHAT_MAX_MESSAGE_CHARS) {
    return { ok: false, status: 400, error: `the last message must not exceed ${CHAT_MAX_MESSAGE_CHARS} characters` };
  }

  return { ok: true, messages };
}

// --- Cost guardrails: meta-backed counters ----------------------------------------------------

const CHAT_TURNS_META_KEY = "chat_turns_hour";
const CHAT_TURNS_LIMIT = 60;
const CHAT_TURNS_WINDOW_MS = 60 * 60_000;

/** Per-slot lease keys: `chat_sse_lease:<uuid>` -> expiry epoch-ms. See
 * `tryAcquireConcurrentSSESlot` for the lease design. */
const CHAT_SSE_LEASE_PREFIX = "chat_sse_lease:";
const CHAT_CONCURRENT_SSE_LIMIT = 2;

/** How long an acquired slot lease lives before any OTHER acquisition may reap it as leaked.
 * Chosen to strictly dominate a turn's worst-case real duration — the 90s wall cap is checked at
 * each iteration top, after which at most one more model call (per-call timeout <= 60s) plus tool
 * executions and SSE flush can run, so a legitimate turn is hard-bounded well under ~3 minutes.
 * 5 minutes of slack on top of that means an unexpired lease ALWAYS corresponds to a turn that
 * could still be live, and an expired one never does — which is why no per-iteration heartbeat
 * refresh is needed: a heartbeat would only matter if a turn could legitimately outlive the TTL,
 * and the wall cap precludes that by construction. */
const CHAT_SSE_LEASE_TTL_MS = 5 * 60_000;

interface ChatRateState {
  windowStartMs: number;
  count: number;
}

/** Mirrors `sweep.ts`'s `parseInvestigationRateState`: fails OPEN (a fresh window) on missing or
 * corrupt state rather than silently wedging the counter closed forever. */
function parseChatRateState(raw: string | undefined, nowMs: number): ChatRateState {
  if (raw === undefined) return { windowStartMs: nowMs, count: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<ChatRateState>;
    if (typeof parsed.windowStartMs === "number" && typeof parsed.count === "number") {
      return { windowStartMs: parsed.windowStartMs, count: parsed.count };
    }
    throw new Error("malformed chat_turns_hour meta value shape");
  } catch (err) {
    console.error("chat: chat_turns_hour meta value is corrupt; resetting the window", err);
    return { windowStartMs: nowMs, count: 0 };
  }
}

/** Fixed-window <= 60/hour guard on starting chat turns, persisted in `meta` under
 * `chat_turns_hour` — same shape and the same accepted non-atomicity as `sweep.ts`'s
 * `tryConsumeInvestigationBudget` (a plain read-then-write, not a SQL-level atomic increment;
 * unlike the plain-integer concurrency gauge, this state is a JSON blob with embedded
 * window-reset logic, which has no single-statement atomic form to reach for).
 *
 * **Known limitation (accepted, and tightly bounded)**: `sweep.ts`'s version of this race is
 * cron-only; this one guards an HTTP-reachable endpoint where truly concurrent requests are real.
 * But `tryEnterChatTurn` only calls this AFTER atomically acquiring a concurrent-SSE slot, so at
 * most `CHAT_CONCURRENT_SSE_LIMIT` (2) requests can ever race this read-then-write at once — the
 * worst case is an overrun of ~1 turn per racing pair, never an unbounded runaway. This is a cost
 * backstop (spec §9's "a few dollars/hour, now including chat"), not a security boundary. */
async function tryConsumeChatTurnBudget(db: D1Database, nowMs: number): Promise<boolean> {
  const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(CHAT_TURNS_META_KEY).first<{ value: string }>();
  let state = parseChatRateState(row?.value, nowMs);
  if (nowMs - state.windowStartMs >= CHAT_TURNS_WINDOW_MS) {
    state = { windowStartMs: nowMs, count: 0 };
  }
  if (state.count >= CHAT_TURNS_LIMIT) return false;

  state.count += 1;
  await db.prepare(`REPLACE INTO meta (key, value) VALUES (?, ?)`).bind(CHAT_TURNS_META_KEY, JSON.stringify(state)).run();
  return true;
}

/**
 * Acquires one of the `CHAT_CONCURRENT_SSE_LIMIT` slots as a LEASE — a `chat_sse_lease:<uuid>`
 * meta row whose value is an expiry timestamp — rather than a bare counter. Returns the lease key
 * on success (the caller must release it), `null` when both slots are held.
 *
 * **Why leases and not a counter** (review FIX 1): a counter has no self-heal — an isolate
 * hard-killed between the increment and the `finally`'s `waitUntil` release (eviction, crash
 * beyond the `waitUntil` guarantee) would leak a decrement FOREVER, ratcheting capacity
 * 2 -> 1 -> 0 until chat wedged shut permanently with no code path able to notice. A lease
 * carries its own expiry, so a leaked slot frees itself: every acquisition first reaps expired
 * leases, meaning the damage from any crash is bounded to one slot for at most
 * `CHAT_SSE_LEASE_TTL_MS` (5 min — see its doc comment for why no per-iteration heartbeat is
 * needed: the TTL strictly dominates a turn's wall-cap-bounded worst-case duration). Chosen over
 * the alternative backstop (a sweep-side clamp) because it is self-contained in this file and
 * heals exactly at the moment capacity is next needed, rather than depending on the cron sweep
 * running and a separate activity stamp aging out.
 *
 * **Atomicity**: the reap and a count-gated `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) <
 * limit` run inside one `db.batch` (a transaction; SQLite serializes writers), so two overlapping
 * requests can never both observe "1 slot held" and both take the last slot, and the count the
 * INSERT gates on already excludes anything the same transaction's reap just deleted. `GLOB`
 * (not `LIKE`) matches the prefix because `_` in `chat_sse_lease:` would be a LIKE wildcard.
 */
async function tryAcquireConcurrentSSESlot(db: D1Database, nowMs: number): Promise<string | null> {
  const leaseKey = `${CHAT_SSE_LEASE_PREFIX}${crypto.randomUUID()}`;
  const results = await db.batch([
    // Reap expired leases first — the self-heal: a slot leaked by a hard-killed isolate frees
    // itself here, at the next acquisition attempt after its TTL passes.
    db.prepare(`DELETE FROM meta WHERE key GLOB ? AND CAST(value AS INTEGER) <= ?`).bind(`${CHAT_SSE_LEASE_PREFIX}*`, nowMs),
    db
      .prepare(`INSERT INTO meta (key, value) SELECT ?, ? WHERE (SELECT COUNT(*) FROM meta WHERE key GLOB ?) < ?`)
      .bind(leaseKey, String(nowMs + CHAT_SSE_LEASE_TTL_MS), `${CHAT_SSE_LEASE_PREFIX}*`, CHAT_CONCURRENT_SSE_LIMIT),
  ]);
  return (results[1]?.meta.changes ?? 0) === 1 ? leaseKey : null;
}

/** Releases one held lease — a single atomic `DELETE` of exactly that lease row (idempotent: a
 * double release, or releasing a lease the reaper already collected, deletes nothing). Called
 * from the pump's `finally` via `waitUntil` so a client disconnect or any other in-request crash
 * can't leak the slot (the task brief's explicit requirement), and from `tryEnterChatTurn`'s own
 * unwind paths; the lease TTL is the backstop for the crashes no `finally` survives. Never throws
 * outward: a failure to release is logged, not propagated — the TTL will reap it. */
async function releaseConcurrentSSESlot(db: D1Database, leaseKey: string): Promise<void> {
  try {
    await db.prepare(`DELETE FROM meta WHERE key = ?`).bind(leaseKey).run();
  } catch (err) {
    console.error("chat: failed to release the concurrent-SSE lease (the TTL will reap it)", err);
  }
}

type ChatGate = { ok: true; leaseKey: string } | { ok: false; reason: string };

/** The combined over-cap gate. Order: the concurrency slot is acquired FIRST (it's the check that
 * must be atomic — see `tryAcquireConcurrentSSESlot`), then the hourly budget; an hourly rejection
 * (or a thrown D1 error mid-sequence) releases the just-acquired lease, so a rejected request is
 * always net-zero on the slots and never consumes an hourly slot it didn't use. A side benefit of
 * this order: the hourly counter's read-then-write race window only ever has at most
 * `CHAT_CONCURRENT_SSE_LIMIT` participants, since everyone racing it already holds a lease. */
async function tryEnterChatTurn(db: D1Database, nowMs: number): Promise<ChatGate> {
  const leaseKey = await tryAcquireConcurrentSSESlot(db, nowMs);
  if (leaseKey === null) {
    return { ok: false, reason: "too many people are chatting right now — please try again in a moment" };
  }
  let allowed: boolean;
  try {
    allowed = await tryConsumeChatTurnBudget(db, nowMs);
  } catch (err) {
    await releaseConcurrentSSESlot(db, leaseKey);
    throw err;
  }
  if (!allowed) {
    await releaseConcurrentSSESlot(db, leaseKey);
    return { ok: false, reason: "chat has hit its hourly limit — please try again later" };
  }
  return { ok: true, leaseKey };
}

// --- Loop wiring ---------------------------------------------------------------------------

/** Chat's own, tighter loop caps (spec §9's cost guardrails: "chat: <= 8 tool steps/turn" plus
 * "maxTokens sensible (~30k in/4k out per turn), 90s wall" from the task brief) — the
 * investigator's caps (`investigator-do.ts`'s `MAX_STEPS`/etc.) are an order of magnitude larger
 * and belong to a fundamentally different budget (one investigation vs. one chat turn).
 *
 * Honest reading of the token caps: these are the loop's TRIP THRESHOLDS, checked at each
 * iteration top (`loop.ts`'s cap check), so one final call can still land after the threshold is
 * crossed — the effective per-turn worst case is ~`maxTokensOut` + one call's
 * `MAX_TOKENS_PER_CALL` (8192) ≈ 12k out, and ~`maxTokensIn` + one call's full context on the
 * input side. Bounded either way; the thresholds are the spend control, not an exact ceiling. */
const CHAT_CAPS: LoopCaps = {
  maxSteps: 8,
  maxWallMs: 90_000,
  maxTokensIn: 30_000,
  maxTokensOut: 4_000,
};

/** Chat's thinking policy (Global Constraints / spec §9): adaptive thinking with summarized
 * display, no `output_config` override (chat never sets one — only the investigator's `effort:
 * "medium"` does) — plumbed via `runLoop`'s existing `thinkingOverride` seam, not a new one. */
const CHAT_THINKING_POLICY = { thinking: { type: "adaptive" as const, display: "summarized" as const } };

/** Every SSE event shape this endpoint ever emits (task brief, verbatim) — kept as one discriminated
 * union so `sendEvent` and every call site are exhaustively checked by the compiler. */
export type ChatSSEEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking" }
  | { type: "tool_call"; name: string; summary: string }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "budget_reached" }
  | { type: "done" }
  | { type: "error"; message: string };

/** Writes one protocol event as an SSE `data:` frame. NEVER rejects: a write failure means the
 * client is gone (or the stream is otherwise dead) — there is nobody to deliver to, the
 * disconnect guard (`shouldAbort` in `pumpChatTurn`) is what stops the loop, and swallowing here
 * is what makes every send site safe, including the fire-and-forget delta hooks (whose rejections
 * would otherwise surface as unhandled promise rejections in the isolate). */
async function sendEvent(stream: SSEStreamingApi, event: ChatSSEEvent): Promise<void> {
  try {
    await stream.writeSSE({ data: JSON.stringify(event) });
  } catch {
    // Client disconnected mid-stream — nothing to deliver to; see the doc comment.
  }
}

const SUMMARY_MAX_CHARS = 240;

function truncateSummary(text: string): string {
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text;
}

/** Turns a `tool_call` `StepRecord`'s `content` (`{tool_use_id, name, input}` — see `loop.ts`'s
 * `record` call sites) into the SSE event's short `summary` string. Best-effort: `content`'s exact
 * shape is `loop.ts`-internal, so this defensively falls back to a generic summary rather than
 * throwing on an unexpected shape. */
function summarizeToolCall(content: unknown): string {
  const input = (content as { input?: unknown } | null)?.input;
  if (input === undefined) return "(no input)";
  try {
    return truncateSummary(JSON.stringify(input));
  } catch {
    return "(unrenderable input)";
  }
}

/** Turns a `tool_result` `StepRecord`'s `content` (`{tool_use_id, name, output, is_error}`) into a
 * short `summary` — prefers the shape-aware `count`/`total`/`truncated` fields every capped tool
 * result already carries (`tools.ts`) over dumping the raw JSON, falling back to the error message
 * or a generic JSON summary otherwise. */
function summarizeToolResult(content: unknown): string {
  const rec = content as { output?: unknown; is_error?: boolean } | null;
  if (rec?.is_error) {
    const message = (rec.output as { error?: unknown } | null)?.error;
    return truncateSummary(typeof message === "string" ? message : "tool call failed");
  }
  const output = rec?.output as { count?: unknown; total?: unknown; truncated?: unknown } | null;
  if (output && typeof output === "object" && "count" in output) {
    const parts = [`${output.count} result${output.count === 1 ? "" : "s"}`];
    if (typeof output.total === "number" && output.total !== output.count) parts.push(`of ${output.total} total`);
    if (output.truncated) parts.push("(truncated)");
    return parts.join(" ");
  }
  try {
    return truncateSummary(JSON.stringify(output ?? {}));
  } catch {
    return "(unrenderable result)";
  }
}

/** Maps validated `ChatTurn`s onto the SDK's `MessageParam[]` shape `runLoop` requires — plain
 * single-text-block turns, since `validateChatBody` already guarantees string-only content. */
function toMessageParams(messages: readonly ChatTurn[]): MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: [{ type: "text" as const, text: m.content }] }));
}

/** Dependencies the chat handler needs beyond `c.env`/`c.req` — injectable so tests can substitute
 * a scripted, non-network `LLM` (see `agent/llm.ts`'s `scriptedStreamingLLM`) and a fixed clock,
 * mirroring `InvestigatorDO`'s own injectable `llmFactory` seam. Defaults to the real streaming
 * client and the real wall clock. */
export interface ChatDeps {
  llmFactory?: (env: Env, hooks: StreamHooks) => LLM;
  nowFn?: () => number;
}

/** The one client-visible message for any non-budget turn failure. Deliberately generic: the real
 * failure text (an SDK exception's detail, a stop_reason, an internal bug's message) is logged
 * server-side only — this is an unauthenticated endpoint, and raw provider/config error strings
 * are reconnaissance material, not something to hand to anonymous callers. */
const GENERIC_TURN_ERROR = "something went wrong handling this turn — please try again";

interface PumpArgs {
  env: Env;
  llmFactory: (env: Env, hooks: StreamHooks) => LLM;
  nowFn: () => number;
  messages: ChatTurn[];
  /** Polled by the loop's `shouldAbort` at every iteration top: a disconnected client means
   * further model spend has no audience, so the loop exits (`failure: "aborted"`) after at most
   * the one in-flight call — dropped tabs must not burn the full 8-step/90s turn budget. */
  isDisconnected: () => boolean;
}

/** Runs one chat turn end to end against an already-open SSE stream: builds the system prompt and
 * loop config, drives `runLoop`, and translates its `onStep`/text-delta/thinking activity plus its
 * final outcome into the SSE protocol. Never throws (`runLoop` never throws and `sendEvent` never
 * rejects). Does NOT own the concurrency-gauge release (the caller's `finally` does) — this
 * function's only job is the turn itself. */
async function pumpChatTurn(stream: SSEStreamingApi, args: PumpArgs): Promise<void> {
  const { env, llmFactory, nowFn, messages, isDisconnected } = args;
  const system = buildChatSystemPrompt({ nowMs: nowFn() });
  const initialMessages = toMessageParams(messages);

  // Fire-and-forget by design: `StreamHooks` callbacks are synchronous (they fire from inside the
  // SDK's stream-event dispatch), so per-delta writes can't be awaited here. The un-awaited
  // buffering this allows is bounded by the turn's own caps (effective worst case ~12k output
  // tokens — see CHAT_CAPS's doc comment — and the 90s wall), not by client behavior — and
  // `sendEvent` never rejects, so nothing here can become an unhandled rejection.
  const hooks: StreamHooks = {
    onTextDelta: (text) => {
      void sendEvent(stream, { type: "text_delta", text });
    },
    onThinking: () => {
      void sendEvent(stream, { type: "thinking" });
    },
  };

  const onStep = async (step: StepRecord): Promise<void> => {
    // Only tool activity has a per-step SSE event; 'note' (the salvage marker) and 'error' don't —
    // the final outcome mapping below owns the terminal budget_reached/error/done events.
    if (step.kind !== "tool_call" && step.kind !== "tool_result") return;
    const name = (step.content as { name?: unknown } | null)?.name;
    if (typeof name !== "string") return;
    const event: ChatSSEEvent =
      step.kind === "tool_call"
        ? { type: "tool_call", name, summary: summarizeToolCall(step.content) }
        : { type: "tool_result", name, summary: summarizeToolResult(step.content) };
    await sendEvent(stream, event);
  };

  const result = await runLoop(
    {
      llm: llmFactory(env, hooks),
      model: env.MODEL_ID,
      system,
      tools: TOOLS,
      executeTool: (name, input) => executeTool(name, input, { db: env.DB, nowMs: nowFn() }),
      caps: CHAT_CAPS,
      // submitReportTool omitted deliberately: chat mode never submits a report; a text `end_turn`
      // IS the answer (loop.ts's outcome 'text' contract).
      onStep,
      shouldAbort: async () => isDisconnected(),
      thinkingOverride: CHAT_THINKING_POLICY,
      nowFn,
    },
    initialMessages,
  );

  if (result.outcome === "text") {
    // Text was already streamed live via `hooks.onTextDelta` above — nothing further to send
    // besides the terminal marker.
    await sendEvent(stream, { type: "done" });
    return;
  }

  // outcome === "failed" (chat never yields "report"): branch on the loop's structural failure
  // discriminant (`LoopFailureKind`) — never on error-step prose.
  if (result.failure === "budget") {
    // A cap/loop-guard trip or a max_tokens truncation — the graceful "budget reached" ending the
    // spec demands (never a hang, never mislabeled as a hard failure).
    await sendEvent(stream, { type: "budget_reached" });
    await sendEvent(stream, { type: "done" });
    return;
  }
  if (result.failure === "aborted") {
    // The client disconnected (the only way chat's shouldAbort trips) — nobody is listening, so
    // there is nothing meaningful to send; the caller's finally still releases the gauge slot.
    return;
  }
  const lastError = [...result.steps].reverse().find((s) => s.kind === "error");
  const detail = (lastError?.content as { message?: unknown } | null)?.message;
  console.error("chat: turn failed", typeof detail === "string" ? detail : result);
  await sendEvent(stream, { type: "error", message: GENERIC_TURN_ERROR });
  await sendEvent(stream, { type: "done" });
}

// --- Hono wiring -----------------------------------------------------------------------------

/** Builds the `POST /api/chat` sub-app. Takes `deps` so tests can inject a scripted LLM/clock
 * (mirrors `InvestigatorDO`'s injectable `llmFactory` — see `ChatDeps`'s doc comment); production
 * (`index.ts`) mounts `createChatApp()` with no overrides, which defaults to the real streaming
 * client and the real wall clock. */
export function createChatApp({ llmFactory = streamingLLM, nowFn = Date.now }: ChatDeps = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/", async (c) => {
    // Cheapest rejection first: a declared Content-Length over the cap 413s before the body is
    // even read. Defense-in-depth only — the header is client-supplied (absent on chunked
    // requests, and free to lie), so the post-read wire-bytes check below stays authoritative.
    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > CHAT_MAX_BODY_BYTES) {
      return c.json({ error: `request body exceeds the ${CHAT_MAX_BODY_BYTES}-byte limit` }, 413);
    }

    // Wire-level size check BEFORE parsing: `validateChatBody`'s own 32KB check judges the
    // re-serialized form (the unit-testable contract), but a raw body padded with insignificant
    // whitespace could be far larger on the wire than after re-serialization — and JSON.parse on
    // a multi-MB body is CPU an anonymous caller shouldn't get to spend. Reject on the actual
    // received bytes first; parse only what already fits the cap.
    const bodyText = await c.req.text();
    if (new TextEncoder().encode(bodyText).length > CHAT_MAX_BODY_BYTES) {
      return c.json({ error: `request body exceeds the ${CHAT_MAX_BODY_BYTES}-byte limit` }, 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }

    const validated = validateChatBody(raw);
    if (!validated.ok) {
      return c.json({ error: validated.error }, validated.status);
    }

    // The gate itself can throw on a D1 hiccup — that must still come back as the graceful
    // single-SSE-error shape, not a raw 5xx (the same "never a hard failure the UI has to
    // special-case" contract as an over-cap rejection). `tryEnterChatTurn` guarantees a thrown
    // error has already released any slot it acquired, so rejecting here leaks nothing.
    let gate: ChatGate;
    try {
      gate = await tryEnterChatTurn(c.env.DB, nowFn());
    } catch (err) {
      console.error("chat: cap-gate check failed", err);
      gate = { ok: false, reason: "chat is temporarily unavailable — please try again" };
    }
    if (!gate.ok) {
      const reason = gate.reason;
      // Graceful, in-UI failure (task brief): HTTP 200, a single SSE `error` event, stream closes
      // — never a 4xx/5xx the caller has to special-case, and every cap the request touched is
      // back to net zero (see `tryEnterChatTurn`'s doc comment) for a turn that never got to run.
      return streamSSE(c, async (stream) => {
        await sendEvent(stream, { type: "error", message: reason });
      });
    }
    const leaseKey = gate.leaseKey;

    return streamSSE(c, async (stream) => {
      try {
        await pumpChatTurn(stream, {
          env: c.env,
          llmFactory,
          nowFn,
          messages: validated.messages,
          // Both signals: the request's own abort signal (the runtime's disconnect notification)
          // and Hono's stream-level aborted flag — either one means nobody is reading.
          isDisconnected: () => c.req.raw.signal.aborted || stream.aborted,
        });
      } catch (err) {
        // pumpChatTurn is never supposed to throw — this is the belt to that suspender, keeping
        // any future regression from surfacing as Hono's silent zero-event stream close.
        console.error("chat: unexpected pump failure", err);
        await sendEvent(stream, { type: "error", message: GENERIC_TURN_ERROR });
      } finally {
        // waitUntil, not a bare await: the response stream may already be fully flushed (or the
        // client may have disconnected) by the time this finally runs, and the lease-release
        // write must still happen — the task brief's "crashed stream must not leak the slot"
        // requirement. For crashes even waitUntil can't survive (isolate hard-kill), the lease
        // TTL is the backstop (see tryAcquireConcurrentSSESlot).
        c.executionCtx.waitUntil(releaseConcurrentSSESlot(c.env.DB, leaseKey));
      }
    });
  });

  return app;
}

export const chatRoutes = createChatApp();
