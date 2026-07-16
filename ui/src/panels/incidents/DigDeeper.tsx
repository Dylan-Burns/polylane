/**
 * "Dig deeper" — the incident-scoped follow-up thread at the bottom of the incident modal
 * (polylane.com's Investigation-thread input, adapted). Reuses the chat SSE wire end-to-end:
 * `streamChat` with `{incidentId}` makes the SERVER load this incident's report/steps into the
 * system prompt (see `src/api/chat.ts`'s security story) — this component never serializes any
 * incident context itself, it only names the id.
 *
 * Deliberately smaller than `panels/Chat.tsx` (no starter prompts, no budget banner, compact tool
 * chips): the same client-held-history model, but capped to `MAX_THREAD_TURNS` and scoped to one
 * question-at-a-time UX. Empty assistant turns are filtered from the wire payload for the same
 * empty-content-block reason as Chat.tsx's `buildWirePayload` (one failed turn must not wedge the
 * whole thread).
 */

import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/Markdown";
import { streamChat, type ChatRequestTurn } from "../../lib/api";
import type { ChatSSEEvent } from "../../lib/types";

/** Tighter than Chat.tsx's 20: a dig-deeper thread is a few pointed follow-ups, not a session. */
const MAX_THREAD_TURNS = 10;
const MAX_QUESTION_CHARS = 2000;

interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Assistant-only: compact "→ tool" chips, folded inline rather than Chat.tsx's full trail. */
  tools: string[];
  pending: boolean;
  errorMessage?: string;
}

function applyEvent(message: ThreadMessage, event: ChatSSEEvent): ThreadMessage {
  switch (event.type) {
    case "text_delta":
      return { ...message, content: message.content + event.text };
    case "tool_call":
      return { ...message, tools: [...message.tools, event.name] };
    case "thinking":
    case "tool_result":
      return message;
    case "budget_reached":
      // A partial answer stands on its own in this compact surface — but a budget trip BEFORE the
      // first token would otherwise leave a silent, answer-less bubble (adversarial-review
      // finding), so that one case gets an explicit inline explanation.
      return message.content.length === 0
        ? { ...message, errorMessage: "turn budget reached before an answer landed — try a narrower question" }
        : message;
    case "error":
      return { ...message, errorMessage: event.message };
    case "done":
      return { ...message, pending: false };
  }
}

function wirePayload(history: ThreadMessage[], newUserText: string): ChatRequestTurn[] {
  const turns: ChatRequestTurn[] = [];
  for (let i = 0; i + 1 < history.length; i += 2) {
    const user = history[i];
    const assistant = history[i + 1];
    if (user === undefined || assistant === undefined) break;
    if (assistant.content.trim().length === 0) continue;
    turns.push({ role: "user", content: user.content }, { role: "assistant", content: assistant.content });
  }
  turns.push({ role: "user", content: newUserText });
  let out = turns;
  while (out.length > MAX_THREAD_TURNS) out = out.slice(2);
  return out;
}

function Bubble({ message }: { message: ThreadMessage }) {
  if (message.role === "user") {
    return <div className="ml-auto max-w-[85%] rounded-xl rounded-br-sm border border-hairline bg-panel-raised px-3 py-2 text-xs leading-relaxed text-ink">{message.content}</div>;
  }
  return (
    <div className="mr-auto flex max-w-[90%] flex-col gap-1.5">
      {message.tools.length > 0 && (
        <p className="font-mono text-[10px] text-ink-faint">→ {message.tools.join(" → ")}</p>
      )}
      {message.pending && message.content.length === 0 && !message.errorMessage && (
        <p className="flex items-center gap-1.5 font-mono text-[10px] text-ink-faint">
          <span className="h-1 w-1 animate-scan-pulse rounded-full bg-signal" aria-hidden="true" />
          digging…
        </p>
      )}
      {message.content.length > 0 && (
        <div className="rounded-xl rounded-bl-sm border border-hairline bg-panel px-3 py-2 text-xs leading-relaxed text-ink">
          <Markdown>{message.content}</Markdown>
        </div>
      )}
      {message.errorMessage && <p className="rounded-lg border border-status-red/30 bg-status-red/5 px-2.5 py-1.5 text-[11px] text-status-red">{message.errorMessage}</p>}
    </div>
  );
}

export function DigDeeper({ incidentId }: { incidentId: string }) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send() {
    const text = draft.trim();
    if (sending || text.length === 0 || text.length > MAX_QUESTION_CHARS) return;

    const assistantId = crypto.randomUUID();
    const userMessage: ThreadMessage = { id: crypto.randomUUID(), role: "user", content: text, tools: [], pending: false };
    const assistantMessage: ThreadMessage = { id: assistantId, role: "assistant", content: "", tools: [], pending: true };
    const payload = wirePayload(messages, text);

    setMessages((prev) => {
      let next = [...prev, userMessage, assistantMessage];
      while (next.length > MAX_THREAD_TURNS) next = next.slice(2);
      return next;
    });
    setDraft("");
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const patch = (updater: (m: ThreadMessage) => ThreadMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)));

    try {
      await streamChat(payload, (event) => patch((m) => applyEvent(m, event)), controller.signal, { incidentId });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        patch((m) => ({ ...m, errorMessage: "couldn't reach Watchtower — try again" }));
      }
    } finally {
      patch((m) => ({ ...m, pending: false }));
      setSending(false);
      abortRef.current = null;
    }
  }

  return (
    <section className="mt-6 border-t border-hairline pt-5">
      <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Dig deeper</h4>
      <p className="mt-1 text-xs text-ink-dim">
        Ask the watchdog about this incident — it answers with this investigation's report and evidence already in hand.
      </p>

      {messages.length > 0 && (
        <div ref={listRef} className="mt-3 flex max-h-72 flex-col gap-2.5 overflow-y-auto pr-1">
          {messages.map((m) => (
            <Bubble key={m.id} message={m} />
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="mt-3 flex items-center gap-2"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={sending}
          maxLength={MAX_QUESTION_CHARS}
          placeholder={sending ? "Waiting for a reply…" : "Dig deeper…"}
          aria-label="Ask about this incident"
          className="w-full rounded-full border border-hairline bg-panel-raised px-3.5 py-2 font-sans text-xs text-ink placeholder:text-ink-faint focus:border-hairline-bright disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          className="shrink-0 rounded-full bg-signal px-3.5 py-2 font-sans text-xs font-medium text-void transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:border disabled:border-hairline disabled:bg-transparent disabled:text-ink-faint disabled:opacity-100"
        >
          {sending ? "Asking…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
