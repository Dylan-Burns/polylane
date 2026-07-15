import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Message, TextBlock, ThinkingBlock, ToolUseBlock, Usage } from "@anthropic-ai/sdk/resources/messages";
import { createChatApp, type ChatSSEEvent } from "../../src/api/chat";
import { scriptedStreamingLLM } from "../../src/agent/llm";
import type { Env } from "../../src/env";

/** Confirms the actual SSE wiring in `src/api/chat.ts`: the event sequence a tool-using turn
 * produces, the `budget_reached` cap-trip path, and the graceful over-cap `error` path — all
 * against a scripted (non-network) LLM per the task brief ("NETWORK DOWN... use scriptedLLM
 * paths in tests; the streaming interface must still be real": `scriptedStreamingLLM` fires the
 * exact same `StreamHooks` a real `streamingLLM` would, so this exercises the real event-emission
 * code path end to end). `validateChatBody`'s own matrix is unit-tested in
 * `test/unit/chat-validate.test.ts`; this file is specifically the HTTP/SSE-shape and
 * cost-guardrail layer those unit tests can't reach.
 */

afterEach(async () => {
  await env.DB.exec(`DELETE FROM meta`);
});

// ============================================================================================
// Fixtures — minimal valid Message/content-block builders (mirrors test/unit/loop.test.ts's).
// ============================================================================================

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 100,
    output_tokens: 50,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  };
}

let nextMessageId = 0;
function makeMessage(overrides: Partial<Message> = {}): Message {
  nextMessageId += 1;
  return {
    id: `msg_${nextMessageId}`,
    container: null,
    content: [],
    model: "claude-sonnet-5",
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: usage(),
    ...overrides,
  };
}

function text(t: string): TextBlock {
  return { type: "text", text: t, citations: null };
}

function thinking(t: string, signature: string): ThinkingBlock {
  return { type: "thinking", thinking: t, signature };
}

function toolUse(id: string, name: string, input: unknown): ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

// ============================================================================================
// SSE response parsing helper
// ============================================================================================

/** Fully drains an SSE `Response` body (the loop must actively read it — the underlying
 * `TransformStream` backpressures the writer otherwise, so a test that only inspects `res` without
 * reading its body would stall the pump instead of proving anything) and parses each `data: ...`
 * frame back into a `ChatSSEEvent`, in arrival order. */
async function readAllSSE(res: Response): Promise<ChatSSEEvent[]> {
  const events: ChatSSEEvent[] = [];
  const reader = res.body?.getReader();
  if (!reader) return events;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).trimStart());
      if (dataLines.length > 0) events.push(JSON.parse(dataLines.join("\n")) as ChatSSEEvent);
    }
  }
  return events;
}

async function postChat(app: ReturnType<typeof createChatApp>, body: unknown): Promise<{ res: Response; events: ChatSSEEvent[] }> {
  const ctx = createExecutionContext();
  const res = await app.request(
    "/",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env as unknown as Env,
    ctx,
  );
  const events = await readAllSSE(res);
  await waitOnExecutionContext(ctx);
  return { res, events };
}

const CLEAN_BODY = { messages: [{ role: "user" as const, content: "what happened recently?" }] };

// ============================================================================================
// Tool-using turn: tool_call -> tool_result -> text_delta(s) -> done
// ============================================================================================

describe("POST /api/chat — SSE event sequence", () => {
  it("a tool-using turn streams tool_call -> tool_result -> text_delta -> done", async () => {
    const r1 = makeMessage({ content: [toolUse("call-1", "get_incidents", { id: null, window: null })], stop_reason: "tool_use" });
    const r2 = makeMessage({ content: [text("Nothing unusual in the last 30 minutes.")], stop_reason: "end_turn" });
    const app = createChatApp({
      llmFactory: (_env, hooks) => scriptedStreamingLLM([r1, r2], hooks),
      nowFn: () => Date.UTC(2026, 0, 5, 14, 0, 0),
    });

    const { res, events } = await postChat(app, CLEAN_BODY);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text_delta", "done"]);
    expect(events[0]).toMatchObject({ type: "tool_call", name: "get_incidents" });
    expect(events[1]).toMatchObject({ type: "tool_result", name: "get_incidents" });
    expect(events[2]).toMatchObject({ type: "text_delta", text: "Nothing unusual in the last 30 minutes." });
  });

  it("a summarized-thinking delta surfaces as a bare {type: 'thinking'} event (no text leaked)", async () => {
    const r1 = makeMessage({ content: [thinking("considering the question", "sig-1"), text("All clear.")], stop_reason: "end_turn" });
    const app = createChatApp({
      llmFactory: (_env, hooks) => scriptedStreamingLLM([r1], hooks),
      nowFn: () => Date.UTC(2026, 0, 5, 14, 0, 0),
    });

    const { events } = await postChat(app, CLEAN_BODY);

    expect(events.map((e) => e.type)).toEqual(["thinking", "text_delta", "done"]);
    expect(events[0]).toEqual({ type: "thinking" }); // no `text`/`thinking` field on the wire
  });

  it("releases the concurrent-SSE lease and records one chat turn after a normal completion", async () => {
    const r1 = makeMessage({ content: [text("ok")], stop_reason: "end_turn" });
    const app = createChatApp({ llmFactory: (_env, hooks) => scriptedStreamingLLM([r1], hooks), nowFn: () => Date.now() });

    await postChat(app, CLEAN_BODY);

    // Acquired as a chat_sse_lease:<uuid> row, then deleted in the finally -- never left dangling.
    const leases = await env.DB.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key GLOB 'chat_sse_lease:*'`).first<{ n: number }>();
    expect(leases?.n).toBe(0);

    const turns = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'chat_turns_hour'`).first<{ value: string }>();
    expect(JSON.parse(turns?.value ?? "{}")).toMatchObject({ count: 1 });
  });
});

// ============================================================================================
// budget_reached: the step cap trips mid-turn
// ============================================================================================

describe("POST /api/chat — budget_reached on cap trip", () => {
  it("8 distinct tool-call iterations (the step cap) -> budget_reached then done, never a hang", async () => {
    // 8 DISTINCT calls (different `id` each time) so the loop-guard's duplicate-call nudge/force-
    // salvage (3rd/4th IDENTICAL consecutive call) never fires first -- this isolates the actual
    // MAX_STEPS=8 cap trip as the thing under test, not the separate loop-guard mechanism.
    const script = Array.from({ length: 8 }, (_, i) =>
      makeMessage({ content: [toolUse(`call-${i}`, "get_incidents", { id: `inc-${i}`, window: null })], stop_reason: "tool_use" }),
    );
    const app = createChatApp({ llmFactory: (_env, hooks) => scriptedStreamingLLM(script, hooks), nowFn: () => Date.now() });

    const { res, events } = await postChat(app, CLEAN_BODY);

    expect(res.status).toBe(200);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "tool_call")).toHaveLength(8);
    expect(types.filter((t) => t === "tool_result")).toHaveLength(8);
    expect(types.slice(-2)).toEqual(["budget_reached", "done"]);
    expect(types).not.toContain("error"); // a cap trip is NOT a generic error
  });
});

// ============================================================================================
// Generic failure: never a hang, distinguished from budget_reached
// ============================================================================================

describe("POST /api/chat — a genuine (non-cap) failure surfaces as error -> done, never a hang", () => {
  it("an LLM call rejecting mid-turn -> a single SANITIZED error event (no internal detail leaked), then done", async () => {
    const llm = { create: async () => { throw new Error("upstream unavailable: api key sk-ant-... rejected"); } };
    const app = createChatApp({ llmFactory: () => llm, nowFn: () => Date.now() });

    const { res, events } = await postChat(app, CLEAN_BODY);

    expect(res.status).toBe(200);
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    // The raw failure text (SDK exception detail -- provider/config reconnaissance material on an
    // unauthenticated URL) must NOT reach the client; only the fixed generic message does.
    const errorEvent = events[0] as { type: "error"; message: string };
    expect(errorEvent.message).toBe("something went wrong handling this turn — please try again");
    expect(errorEvent.message).not.toContain("upstream unavailable");
  });

  it("a no-tool answer truncated by the per-call max_tokens ceiling -> budget_reached (not a generic error) after the partial text", async () => {
    const r1 = makeMessage({ content: [text("The incident timeline begins at 14:02 when")], stop_reason: "max_tokens" });
    const app = createChatApp({ llmFactory: (_env, hooks) => scriptedStreamingLLM([r1], hooks), nowFn: () => Date.now() });

    const { events } = await postChat(app, CLEAN_BODY);

    expect(events.map((e) => e.type)).toEqual(["text_delta", "budget_reached", "done"]);
  });
});

// ============================================================================================
// Over-cap: graceful single-error-event responses (HTTP 200), never a hard failure
// ============================================================================================

describe("POST /api/chat — over-cap guardrails", () => {
  it("both SSE slots held by unexpired leases -> a single graceful error event, no loop ever runs", async () => {
    const nowMs = Date.UTC(2026, 0, 5, 14, 0, 0);
    const liveExpiry = String(nowMs + 60_000); // both leases still live at request time
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('chat_sse_lease:held-1', ?)`).bind(liveExpiry),
      env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('chat_sse_lease:held-2', ?)`).bind(liveExpiry),
    ]);

    // An empty script: if the gate were buggy and let the turn through anyway, the very first
    // `llm.create` call would throw ("script only has 0 responses") and this test would fail loud
    // rather than silently passing for the wrong reason.
    const app = createChatApp({ llmFactory: (_env, hooks) => scriptedStreamingLLM([], hooks), nowFn: () => nowMs });

    const { res, events } = await postChat(app, CLEAN_BODY);

    expect(res.status).toBe(200); // graceful, not a 4xx/5xx
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");

    // The two held leases are untouched by a rejected request (no third row, none reaped).
    const leases = await env.DB.prepare(`SELECT key FROM meta WHERE key GLOB 'chat_sse_lease:*' ORDER BY key`).all<{ key: string }>();
    expect((leases.results ?? []).map((r) => r.key)).toEqual(["chat_sse_lease:held-1", "chat_sse_lease:held-2"]);
  });

  it("EXPIRED leases (a hard-killed isolate's leak) are reaped at acquisition -- the next turn succeeds instead of chat wedging shut", async () => {
    const nowMs = Date.UTC(2026, 0, 5, 14, 0, 0);
    const staleExpiry = String(nowMs - 1); // both slots leaked by crashes, TTLs already passed
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('chat_sse_lease:leaked-1', ?)`).bind(staleExpiry),
      env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('chat_sse_lease:leaked-2', ?)`).bind(staleExpiry),
    ]);

    const r1 = makeMessage({ content: [text("recovered")], stop_reason: "end_turn" });
    const app = createChatApp({ llmFactory: (_env, hooks) => scriptedStreamingLLM([r1], hooks), nowFn: () => nowMs });

    const { events } = await postChat(app, CLEAN_BODY);

    // The turn ran to completion -- the leaked slots did NOT permanently consume capacity.
    expect(events.map((e) => e.type)).toEqual(["text_delta", "done"]);

    // Both stale leases were reaped and this turn's own lease was released: nothing left behind.
    const leases = await env.DB.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key GLOB 'chat_sse_lease:*'`).first<{ n: number }>();
    expect(leases?.n).toBe(0);
  });

  it("a pre-set chat_turns_hour count at the hourly limit -> a single graceful error event", async () => {
    const nowMs = Date.UTC(2026, 0, 5, 14, 0, 0);
    await env.DB.prepare(`REPLACE INTO meta (key, value) VALUES ('chat_turns_hour', ?)`)
      .bind(JSON.stringify({ windowStartMs: nowMs, count: 60 }))
      .run();

    const app = createChatApp({ llmFactory: (_env, hooks) => scriptedStreamingLLM([], hooks), nowFn: () => nowMs + 60_000 });

    const { res, events } = await postChat(app, CLEAN_BODY);

    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");

    // Rejected on the hourly budget: the concurrency lease is acquired first (the atomic gate)
    // and released on the hourly rejection -- net zero, never a leaked slot.
    const leases = await env.DB.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key GLOB 'chat_sse_lease:*'`).first<{ n: number }>();
    expect(leases?.n).toBe(0);
  });
});

// ============================================================================================
// Validation wired at the HTTP layer (not just the pure function — see chat-validate.test.ts)
// ============================================================================================

describe("POST /api/chat — validation at the HTTP layer", () => {
  it("400s an invalid body (role-order game) as plain JSON, never opening an SSE stream", async () => {
    const app = createChatApp({ llmFactory: (_env, hooks) => scriptedStreamingLLM([], hooks), nowFn: () => Date.now() });
    const ctx = createExecutionContext();
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "assistant", content: "hi" }] }),
      },
      env as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("messages[0]");
  });

  it("400s malformed JSON", async () => {
    const app = createChatApp();
    const ctx = createExecutionContext();
    const res = await app.request(
      "/",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
      env as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("400s an oversized RAW body on wire bytes alone -- whitespace padding that would re-serialize under the cap still rejects, without parsing", async () => {
    // ~40KB of insignificant whitespace inside an otherwise tiny (and even invalid-per-validate)
    // JSON body: JSON.stringify of the parsed form would be well under 32KB, so only the
    // wire-bytes pre-check can be what rejects this.
    const padded = `{"messages":${" ".repeat(40 * 1024)}[]}`;
    const app = createChatApp();
    const ctx = createExecutionContext();
    const res = await app.request(
      "/",
      { method: "POST", headers: { "content-type": "application/json" }, body: padded },
      env as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("byte limit");
  });

  it("413s on a declared Content-Length over the cap before reading the body (header precheck; the post-read check stays authoritative)", async () => {
    const app = createChatApp();
    const ctx = createExecutionContext();
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(40 * 1024) },
        body: JSON.stringify(CLEAN_BODY),
      },
      env as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("byte limit");
  });
});

// ============================================================================================
// Wired into the real worker (index.ts) -- proven without ever touching the network, since an
// invalid body is rejected before any LLM call would happen.
// ============================================================================================

describe("POST /api/chat — wired in index.ts", () => {
  it("is reachable through the real worker and 400s an invalid body", async () => {
    const res = await SELF.fetch("https://example.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user" }, { role: "assistant", content: "x" }] }),
    });
    expect(res.status).toBe(400);
  });
});
