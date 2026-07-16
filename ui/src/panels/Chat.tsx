/**
 * Area 4 (spec §11): the streaming chat surface — same watchdog, same read-only tool layer
 * (`src/agent/tools.ts`'s `TOOLS`), no report submission, talked to over `POST /api/chat`'s SSE
 * protocol (`src/api/chat.ts`'s `ChatSSEEvent` union, mirrored in `lib/types.ts`).
 *
 * **History is entirely client-held** (Task 6.2 brief): this component's own `messages` state IS
 * the conversation — replayed in full (as `{role, content}` pairs) on every request, capped to
 * `CHAT_MAX_TURNS` turns by dropping the oldest *pair* once exceeded (`capMessages` — dropping in
 * pairs is what keeps a `user, assistant, user, …` transcript starting and ending on `user` after a
 * trim, which is what the server's strict-alternation validator requires). This is a client-side
 * proactive mirror of `chat.ts`'s own hard `CHAT_MAX_TURNS` rejection — under normal use through
 * this panel, the server-side cap should never actually fire.
 *
 * **Activity chips** (thinking/tool_call/tool_result) render *inside* the in-progress assistant
 * turn's own bubble, not a separate log — see `ActivityTrail`. While that turn is still streaming
 * they're always visible (the same "watch it work" moment `panels/incidents/Timeline.tsx` gives the
 * investigator); once the turn finishes they fold into a `<details>` disclosure, exactly
 * `StepCard.tsx`'s `RawDisclosure` convention, so a finished transcript reads as prose first with
 * the tool trail available on demand.
 */

import { useEffect, useRef, useState } from "react";
import { Markdown } from "../components/Markdown";
import { streamChat, type ChatRequestTurn } from "../lib/api";
import type { ChatSSEEvent } from "../lib/types";

/** Mirrors `src/api/chat.ts`'s `CHAT_MAX_TURNS` — see this file's header comment for why the cap is
 * enforced here too rather than only trusting the server's 400. */
const CHAT_MAX_TURNS = 20;

/** Mirrors `src/api/chat.ts`'s `CHAT_MAX_MESSAGE_CHARS` — enforced live in the composer (task
 * brief: "enforce in the composer with a live counter"), not just on rejection. */
const CHAT_MAX_MESSAGE_CHARS = 2000;

const STARTER_PROMPTS = ["What happened in the last hour?", "Is checkout healthy?", "Summarize the last incident"];

type ActivityEntry =
  | { id: string; kind: "thinking" }
  | { id: string; kind: "tool_call"; name: string; summary: string }
  | { id: string; kind: "tool_result"; name: string; summary: string };

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Assistant-only: the ordered thinking/tool trail for this turn — see the file header comment. */
  activity: ActivityEntry[];
  /** Assistant-only: true while this turn's stream is still open. */
  pending: boolean;
  budgetReached?: boolean;
  errorMessage?: string;
}

function newId(): string {
  return crypto.randomUUID();
}

/** Drops the oldest (user, assistant) pair at a time until `list` is within `CHAT_MAX_TURNS` — see
 * the file header comment on why pairs, not single messages, are dropped. Generic over anything
 * shaped like a turn so it works for both the rich `ChatMessage[]` (display state) and the plain
 * `ChatRequestTurn[]` (the wire payload) without a second copy of the loop. */
function capMessages<T>(list: T[]): T[] {
  let out = list;
  while (out.length > CHAT_MAX_TURNS) out = out.slice(2);
  return out;
}

/**
 * Builds the wire payload for one send. Prior `history` (always strictly `[user, assistant,
 * user, assistant, …]` pairs — `sendMessage` is the only writer and always appends both at once)
 * is filtered down to the pairs whose assistant turn actually produced text: a turn that ended
 * with zero `text_delta`s (a rate-gate SSE error, a client-caught 400, a network failure, a
 * budget trip before the first token) leaves its placeholder at `content: ""`, and replaying that
 * empty turn would poison every later request — the Anthropic API rejects empty text content
 * blocks, so one gated turn would wedge the whole session, with each failed retry appending
 * another empty turn (never self-healing).
 *
 * The empty assistant turn's paired USER turn is dropped with it: keeping it would put two user
 * turns back to back, which the server's strict-alternation validator 400s — and the model never
 * saw a response to it anyway, so the pair conveyed nothing worth replaying. (Trim-compared, to
 * also catch a hypothetical whitespace-only answer.) Display state deliberately keeps both turns
 * — the inline error banner in the bubble is the UX; this filter is wire-only.
 *
 * The result is pairs + the fresh user text, so it starts and ends on `user` and alternates by
 * construction — `validateChatBody`-clean — then `capMessages` bounds it to `CHAT_MAX_TURNS`.
 */
function buildWirePayload(history: ChatMessage[], newUserText: string): ChatRequestTurn[] {
  const turns: ChatRequestTurn[] = [];
  for (let i = 0; i + 1 < history.length; i += 2) {
    const user = history[i];
    const assistant = history[i + 1];
    if (user === undefined || assistant === undefined) break; // defensive: pairing invariant broken
    if (assistant.content.trim().length === 0) continue;
    turns.push({ role: "user", content: user.content }, { role: "assistant", content: assistant.content });
  }
  turns.push({ role: "user", content: newUserText });
  return capMessages(turns);
}

/** Folds one incoming SSE event into the in-progress assistant message it belongs to. Pure — takes
 * the message, returns the next version — so it can be used from a `setMessages` updater. */
function applyEvent(message: ChatMessage, event: ChatSSEEvent): ChatMessage {
  switch (event.type) {
    case "text_delta":
      return { ...message, content: message.content + event.text };
    case "thinking": {
      // Collapse consecutive thinking pulses into one live chip rather than a growing wall of
      // identical "thinking…" rows — a genuinely new chip only appears once something else (a tool
      // call) has interrupted the run of thinking events.
      const last = message.activity[message.activity.length - 1];
      if (last?.kind === "thinking") return message;
      return { ...message, activity: [...message.activity, { id: newId(), kind: "thinking" }] };
    }
    case "tool_call":
      return { ...message, activity: [...message.activity, { id: newId(), kind: "tool_call", name: event.name, summary: event.summary }] };
    case "tool_result":
      return { ...message, activity: [...message.activity, { id: newId(), kind: "tool_result", name: event.name, summary: event.summary }] };
    case "budget_reached":
      return { ...message, budgetReached: true };
    case "error":
      return { ...message, errorMessage: event.message };
    case "done":
      return { ...message, pending: false };
  }
}

function ActivityChip({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === "thinking") {
    return (
      <li className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
        <span className="h-1.5 w-1.5 animate-scan-pulse rounded-full bg-signal" aria-hidden="true" />
        thinking…
      </li>
    );
  }
  const arrow = entry.kind === "tool_call" ? "→" : "←";
  const accent = entry.kind === "tool_call" ? "text-signal-glow" : "text-ink-dim";
  return (
    <li className={`font-mono text-[11px] ${accent}`}>
      {arrow} {entry.name} <span className="text-ink-faint normal-case">{entry.summary}</span>
    </li>
  );
}

/** The thinking/tool_call/tool_result trail for one assistant turn. Always expanded while `live`
 * (the turn is still streaming — the "watch it work" moment); once finished, folds behind a
 * `<details>` disclosure so a completed transcript reads as prose first. */
function ActivityTrail({ activity, live }: { activity: ActivityEntry[]; live: boolean }) {
  if (activity.length === 0) return null;
  const items = (
    <ul className="flex flex-col gap-1 border-l border-hairline pl-3">
      {activity.map((entry) => (
        <ActivityChip key={entry.id} entry={entry} />
      ))}
    </ul>
  );
  if (live) return <div className="mb-2">{items}</div>;
  return (
    <details className="mb-2">
      <summary className="cursor-pointer select-none text-[11px] text-ink-faint hover:text-ink-dim">
        {activity.length} step{activity.length === 1 ? "" : "s"} (thinking &amp; tool calls)
      </summary>
      <div className="mt-1.5">{items}</div>
    </details>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-hairline bg-panel-raised px-4 py-2.5 text-sm leading-relaxed text-ink sm:max-w-[75%]">
        {message.content}
      </div>
    );
  }

  const waitingForFirstToken = message.pending && message.content.length === 0 && message.activity.length === 0 && !message.errorMessage;

  return (
    <div className="mr-auto flex max-w-[85%] flex-col gap-2 sm:max-w-[75%]">
      <ActivityTrail activity={message.activity} live={message.pending} />
      {waitingForFirstToken && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-faint">
          <span className="h-1.5 w-1.5 animate-scan-pulse rounded-full bg-signal" aria-hidden="true" />
          thinking…
        </div>
      )}
      {message.content.length > 0 && (
        <div className="rounded-2xl rounded-bl-sm border border-hairline bg-panel px-4 py-2.5 text-sm leading-relaxed text-ink">
          {/* Assistant turns are markdown (the watchdog answers with headings/bold/inline code) —
              user turns above stay literal `whitespace-pre-wrap` text since that's the human's raw
              input. Mid-stream, unclosed syntax (a dangling `**`) renders literally until its
              closing token arrives, so partial turns degrade to plain text rather than breaking. */}
          <Markdown>{message.content}</Markdown>
          {message.pending && <span className="mt-1 inline-block h-[1em] w-0.5 animate-pulse bg-signal" aria-hidden="true" />}
        </div>
      )}
      {message.budgetReached && (
        <p className="rounded-lg border border-status-amber/30 bg-status-amber/5 px-3 py-2 text-xs text-status-amber">
          Turn budget reached — the answer above is complete as far as it got.
        </p>
      )}
      {message.errorMessage && <p className="rounded-lg border border-status-red/30 bg-status-red/5 px-3 py-2 text-xs text-status-red">{message.errorMessage}</p>}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-8 text-center">
      <div className="flex flex-col items-center gap-1.5">
        <h3 className="font-display text-lg font-semibold text-ink">Ask the watchdog</h3>
        <p className="max-w-sm text-xs leading-relaxed text-ink-dim">
          It reads the same live metrics, logs, traces, deploys, and incidents the investigator does — nothing else, and nothing it doesn't already
          have access to.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
        {STARTER_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPick(prompt)}
            className="rounded-full border border-hairline bg-panel px-3.5 py-2 text-left font-sans text-xs text-ink-dim transition-colors hover:border-hairline-bright hover:text-ink"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({
  draft,
  onDraftChange,
  onSend,
  disabled,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const overLimit = draft.length > CHAT_MAX_MESSAGE_CHARS;
  const canSend = !disabled && !overLimit && draft.trim().length > 0;

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Never treat Enter as "send" mid-IME-composition (Japanese/Chinese/Korean input): confirming
    // a candidate fires an Enter keydown with `isComposing` set (legacy engines report keyCode
    // 229 instead) that must select the candidate, not submit the message.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Enter sends; Shift+Enter inserts a newline (task brief, verbatim).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
      className="flex flex-col gap-1.5 border-t border-hairline pt-3"
    >
      <textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={2}
        placeholder={disabled ? "Waiting for a reply…" : "Ask about the live world… (Enter to send, Shift+Enter for a new line)"}
        aria-label="Message"
        className="w-full resize-none rounded-xl border border-hairline bg-panel-raised px-3 py-2 font-sans text-sm text-ink placeholder:text-ink-faint focus:border-hairline-bright disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="flex items-center justify-between gap-2">
        <span
          className={`font-mono text-[10px] ${
            overLimit ? "text-status-red" : draft.length > CHAT_MAX_MESSAGE_CHARS * 0.9 ? "text-status-amber" : "text-ink-faint"
          }`}
        >
          {draft.length} / {CHAT_MAX_MESSAGE_CHARS}
        </span>
        <button
          type="submit"
          disabled={!canSend}
          className="rounded-full bg-signal px-4 py-1.5 font-sans text-xs font-medium text-void transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:border disabled:border-hairline disabled:bg-transparent disabled:text-ink-faint disabled:opacity-100"
        >
          {disabled ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // behavior "auto" (instant), not "smooth": text_delta events re-run this many times a second
    // while a turn streams, and restarting a smooth-scroll animation on every delta makes the
    // list judder and lag behind the newest text instead of tracking it.
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  // Abort any in-flight turn if the whole app unmounts (tab close/navigation away) — the panel
  // itself stays mounted across the Dashboard/Chat tab switch (see App.tsx) specifically so a
  // still-streaming turn is never interrupted just by glancing at the dashboard.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function sendMessage(rawText: string) {
    const text = rawText.trim();
    if (sending || text.length === 0 || text.length > CHAT_MAX_MESSAGE_CHARS) return;

    const userMessage: ChatMessage = { id: newId(), role: "user", content: text, activity: [], pending: false };
    const assistantId = newId();
    const assistantMessage: ChatMessage = { id: assistantId, role: "assistant", content: "", activity: [], pending: true };

    // Wire payload: prior history with dead (empty-assistant) pairs filtered out, plus this
    // message — see buildWirePayload. Built from `messages` as it stands right now rather than a
    // ref, since this handler only ever runs once per turn (the composer is disabled while
    // `sending`).
    const payload = buildWirePayload(messages, text);

    setMessages((prev) => capMessages([...prev, userMessage, assistantMessage]));
    setDraft("");
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    function patch(updater: (m: ChatMessage) => ChatMessage) {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)));
    }

    try {
      await streamChat(payload, (event) => patch((m) => applyEvent(m, event)), controller.signal);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        patch((m) => ({ ...m, errorMessage: "couldn't reach Watchtower — check your connection and try again" }));
      }
    } finally {
      patch((m) => ({ ...m, pending: false }));
      setSending(false);
      abortRef.current = null;
    }
  }

  return (
    <section className="flex h-[calc(100vh-11rem)] min-h-[420px] flex-col rounded-2xl border border-hairline bg-panel/40 p-5">
      <header className="mb-3 border-b border-hairline pb-3">
        <h2 className="font-display text-lg font-semibold tracking-tight text-ink">Chat</h2>
        <p className="mt-1 text-xs text-ink-dim">Same watchdog, same read-only tools — ask it anything about the live world.</p>
      </header>

      <div ref={listRef} className="flex flex-1 flex-col overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <EmptyState onPick={sendMessage} />
        ) : (
          <div className="flex flex-col gap-4 py-2">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>

      <Composer draft={draft} onDraftChange={setDraft} disabled={sending} onSend={() => sendMessage(draft)} />
    </section>
  );
}
