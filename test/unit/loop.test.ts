import { describe, expect, it } from "vitest";
import type {
  ContentBlockParam,
  Message,
  MessageParam,
  TextBlock,
  ThinkingBlock,
  ToolResultBlockParam,
  ToolUseBlock,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";
import { realLLM, scriptedLLM, type LLM } from "../../src/agent/llm";
import { runLoop, SALVAGE_FLOOR_MS, SALVAGE_MAX_TOKENS, type LoopConfig, type StepRecord } from "../../src/agent/loop";
import { SUBMIT_REPORT, TOOLS } from "../../src/agent/tools";

// ============================================================================================
// Fixture builders — a minimal valid `Message`/content-block per Anthropic SDK shape, with
// sensible defaults so each test only spells out what it actually cares about.
// ============================================================================================

const NOW0 = Date.UTC(2026, 0, 5, 14, 0, 0);
const MIN = 60_000;

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

function userText(t: string): MessageParam {
  return { role: "user", content: [{ type: "text", text: t }] };
}

/** Reads back a `ToolResultBlockParam`'s JSON-stringified `content` (`loop.ts` always sends tool
 * results as a JSON string, never a raw object — see `runLoop`'s `results.push` call sites). */
function parseToolResult(block: ContentBlockParam): unknown {
  const b = block as ToolResultBlockParam;
  return JSON.parse(b.content as string);
}

const GOOD_REPORT = {
  summary: "Bad deploy caused checkout errors.",
  timeline: [{ time: "14:32Z", description: "checkout error_rate spiked" }],
  root_cause: { hypothesis: "connection pool exhaustion", mechanism: "payments pool saturated" },
  evidence: [{ description: "error_rate 22% vs baseline", trace_id: null, metric: "checkout error_rate", log_excerpt: null }],
  blast_radius: { affected_services: ["checkout"], customer_impact: "~5% of checkouts failed" },
  confidence: { level: "high", why: "reproduced in a single trace" },
  suggested_action: "roll back the payments SDK bump",
};

const INITIAL_MESSAGES: MessageParam[] = [userText("checkout error_rate 22% vs baseline 0.4% since 14:32Z")];

function baseCaps() {
  return { maxSteps: 15, maxWallMs: 4 * 60 * MIN, maxTokensIn: 200_000, maxTokensOut: 16_000 };
}

// ============================================================================================
// llm.ts — scriptedLLM / realLLM
// ============================================================================================

describe("scriptedLLM", () => {
  it("plays back responses in call order", async () => {
    const m1 = makeMessage({ content: [text("one")] });
    const m2 = makeMessage({ content: [text("two")] });
    const llm = scriptedLLM([m1, m2]);

    const r1 = await llm.create({ model: "m", max_tokens: 10, messages: [] });
    const r2 = await llm.create({ model: "m", max_tokens: 10, messages: [] });

    expect(r1).toBe(m1);
    expect(r2).toBe(m2);
  });

  it("throws when called more times than the script provides", async () => {
    const llm = scriptedLLM([makeMessage()]);
    await llm.create({ model: "m", max_tokens: 10, messages: [] });
    await expect(llm.create({ model: "m", max_tokens: 10, messages: [] })).rejects.toThrow(/scriptedLLM/);
  });

  it("captures every call's params and timeoutMs, in order, on .requests/.timeouts", async () => {
    const llm = scriptedLLM([makeMessage(), makeMessage()]);
    await llm.create({ model: "a", max_tokens: 1, messages: [] }, 5_000);
    await llm.create({ model: "b", max_tokens: 2, messages: [] });

    expect(llm.requests.map((r) => r.model)).toEqual(["a", "b"]);
    expect(llm.timeouts).toEqual([5_000, undefined]);
  });
});

describe("realLLM", () => {
  it("constructs an LLM (SDK client) without making any network call", () => {
    const llm = realLLM({ ANTHROPIC_API_KEY: "test-key-not-real" });
    expect(typeof llm.create).toBe("function");
  });
});

// ============================================================================================
// loop.ts — runLoop behavioral contract
// ============================================================================================

describe("runLoop", () => {
  it("[1] happy path: 3 steps -> submit_report; assistant content echoed verbatim; cache_control breakpoints exact and non-duplicated", async () => {
    const r1 = makeMessage({
      content: [
        thinking("checking checkout metrics", "sig-1"),
        toolUse("call-1", "query_metrics", { service: "checkout", operation: null, metrics: null, window: { from: "-30m", to: null }, step: null }),
      ],
      stop_reason: "tool_use",
    });
    const r2 = makeMessage({
      content: [toolUse("call-2", "search_logs", { service: "checkout", level: "error", contains: null, window: { from: "-30m", to: null }, limit: null })],
      stop_reason: "tool_use",
    });
    const r3 = makeMessage({
      content: [toolUse("call-3", "submit_report", GOOD_REPORT)],
      stop_reason: "tool_use",
    });
    const llm = scriptedLLM([r1, r2, r3]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "You are the investigator." }],
      tools: TOOLS,
      executeTool: async (name, input) => ({ ok: true, tool: name, input }),
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    expect(result.report).toEqual(GOOD_REPORT);
    expect(result.usage).toEqual({ in: 300, out: 150 });
    expect(result.steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result", "report"]);
    expect(result.steps.map((s) => s.step_no)).toEqual([1, 2, 3, 4, 5]);

    // --- Verbatim echo: exact object identity of the scripted response's content array. ---
    const req1 = llm.requests[1];
    expect(req1).toBeDefined();
    const echoedAssistant = req1?.messages.find((m) => m.role === "assistant");
    expect(echoedAssistant?.content).toBe(r1.content); // object identity, not just deep-equality

    // --- cache_control: last system block only. ---
    for (const req of llm.requests) {
      const sys = req.system as { cache_control?: unknown }[];
      expect(sys[sys.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
      for (const block of sys.slice(0, -1)) expect(block.cache_control).toBeUndefined();
    }

    // --- cache_control: last MESSAGE's last block only, exactly once, never duplicated/stale. ---
    const req0 = llm.requests[0];
    expect(req0?.messages).toHaveLength(1);
    const req0Blocks = req0?.messages[0]?.content as ContentBlockParam[];
    expect((req0Blocks[req0Blocks.length - 1] as { cache_control?: unknown }).cache_control).toEqual({ type: "ephemeral" });

    expect(req1?.messages).toHaveLength(3); // [user0, assistant(r1), tool_results]
    const req1Msg0Blocks = req1?.messages[0]?.content as ContentBlockParam[];
    expect((req1Msg0Blocks[0] as { cache_control?: unknown }).cache_control).toBeUndefined(); // no longer "last" -> no breakpoint
    const req1AssistantBlocks = echoedAssistant?.content as ContentBlockParam[];
    for (const block of req1AssistantBlocks) expect((block as { cache_control?: unknown }).cache_control).toBeUndefined();
    const req1LastBlocks = req1?.messages[2]?.content as ContentBlockParam[];
    expect((req1LastBlocks[req1LastBlocks.length - 1] as { cache_control?: unknown }).cache_control).toEqual({ type: "ephemeral" });

    const req2 = llm.requests[2];
    expect(req2?.messages).toHaveLength(5);
    // Nothing before the last message carries a breakpoint by the 3rd call either.
    for (const m of req2?.messages.slice(0, -1) ?? []) {
      for (const block of m.content as ContentBlockParam[]) expect((block as { cache_control?: unknown }).cache_control).toBeUndefined();
    }

    // --- Anthropic API policy: thinking/effort/max_tokens/no temperature or top_p. ---
    for (const req of llm.requests) {
      expect(req.thinking).toEqual({ type: "adaptive" });
      expect(req.output_config).toEqual({ effort: "medium" });
      expect(req.max_tokens).toBe(8192);
      expect(req.temperature).toBeUndefined();
      expect(req.top_p).toBeUndefined();
      expect(req.tool_choice).toBeUndefined(); // normal calls never force tool_choice
    }
  });

  it("[2] tool executor throws -> error tool_result (is_error: true) fed back, loop continues normally", async () => {
    const r1 = makeMessage({ content: [toolUse("call-1", "get_trace", { trace_id: "trace-x" })], stop_reason: "tool_use" });
    const r2 = makeMessage({ content: [toolUse("call-2", "submit_report", GOOD_REPORT)], stop_reason: "tool_use" });
    const llm = scriptedLLM([r1, r2]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async (name) => {
        if (name === "get_trace") throw new Error("boom: D1 unavailable");
        return { ok: true };
      },
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    const toolResultStep = result.steps.find((s) => s.kind === "tool_result");
    expect(toolResultStep?.content).toMatchObject({ is_error: true, output: { error: "boom: D1 unavailable" } });

    const req1 = llm.requests[1];
    const toolResultMsg = req1?.messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => (b as ToolResultBlockParam).type === "tool_result"));
    const block = (toolResultMsg?.content as ContentBlockParam[])[0] as ToolResultBlockParam;
    expect(block.is_error).toBe(true);
    expect(JSON.parse(block.content as string)).toEqual({ error: "boom: D1 unavailable" });
  });

  it("[2a] parallel turn with TWO tool_use blocks -> exactly one following user message with two matching tool_results", async () => {
    const r1 = makeMessage({
      content: [
        toolUse("par-1", "query_metrics", { service: "checkout", operation: null, metrics: null, window: null, step: null }),
        toolUse("par-2", "search_logs", { service: "checkout", level: "error", contains: null, window: null, limit: null }),
      ],
      stop_reason: "tool_use",
    });
    const r2 = makeMessage({ content: [toolUse("par-3", "submit_report", GOOD_REPORT)], stop_reason: "tool_use" });
    const llm = scriptedLLM([r1, r2]);

    const executed: string[] = [];
    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async (name) => {
        executed.push(name);
        return { ok: true, tool: name };
      },
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    expect(executed).toEqual(["query_metrics", "search_logs"]); // both executed, in block order

    // Exactly ONE user message follows the parallel assistant turn: [user0, assistant(r1), results].
    const req1 = llm.requests[1];
    expect(req1?.messages).toHaveLength(3);
    const resultsMsg = req1?.messages[2];
    expect(resultsMsg?.role).toBe("user");
    const blocks = resultsMsg?.content as ToolResultBlockParam[];
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.type === "tool_result")).toBe(true);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["par-1", "par-2"]); // ids match both tool_use blocks
    expect(parseToolResult(blocks[0] as ToolResultBlockParam)).toEqual({ ok: true, tool: "query_metrics" });
    expect(parseToolResult(blocks[1] as ToolResultBlockParam)).toEqual({ ok: true, tool: "search_logs" });
  });

  it("[2b] submit_report alongside another tool in one parallel turn -> immediate report, no further model call", async () => {
    const r1 = makeMessage({
      content: [
        toolUse("mix-1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null }),
        toolUse("mix-2", "submit_report", GOOD_REPORT),
      ],
      stop_reason: "tool_use",
    });
    const llm = scriptedLLM([r1]);

    let executeCount = 0;
    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => {
        executeCount += 1;
        return { ok: true };
      },
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    expect(result.report).toEqual(GOOD_REPORT);
    expect(llm.requests).toHaveLength(1); // no further model call after the report
    expect(executeCount).toBe(0); // sibling tools are never executed once the report exists
    expect(result.steps.map((s) => s.kind)).toEqual(["report"]);
  });

  it("[3a] end_turn without submit_report -> one salvage call (tool_choice forced) -> outcome report", async () => {
    const r1 = makeMessage({ content: [text("I believe the investigation is complete.")], stop_reason: "end_turn" });
    const r2 = makeMessage({ content: [toolUse("call-salvage", "submit_report", GOOD_REPORT)], stop_reason: "tool_use" });
    const llm = scriptedLLM([r1, r2]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    expect(result.report).toEqual(GOOD_REPORT);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.tool_choice).toEqual({ type: "tool", name: "submit_report" });
    // Salvage-specific ceilings: a bigger max_tokens (thinking + a full mandatory report payload
    // must never truncate on this one call) and a real timeout floor.
    expect(llm.requests[0]?.max_tokens).toBe(8192);
    expect(llm.requests[1]?.max_tokens).toBe(SALVAGE_MAX_TOKENS);
    expect(llm.timeouts[1]).toBeGreaterThanOrEqual(SALVAGE_FLOOR_MS);

    const salvageReq = llm.requests[1];
    expect(salvageReq?.messages).toHaveLength(3); // [user0, assistant(end_turn), user(salvage instruction)]
    const salvageMsg = salvageReq?.messages[2];
    expect(salvageMsg?.role).toBe("user");
    expect(((salvageMsg?.content as ContentBlockParam[])[0] as { text: string }).text).toBe("conclude with what you have; state low confidence");

    // Review-mandated: a "note" step lands the instant salvage begins, so a caller persisting
    // steps live (Task 4.2) sees an explicit marker instead of a silent gap until the report.
    expect(result.steps.map((s) => s.kind)).toEqual(["note", "report"]);
  });

  it("[3b] salvage response also end_turn/no-report -> outcome failed", async () => {
    const r1 = makeMessage({ content: [text("done")], stop_reason: "end_turn" });
    const r2 = makeMessage({ content: [text("still not sure")], stop_reason: "end_turn" });
    const llm = scriptedLLM([r1, r2]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("failed");
    expect(result.failure).toBe("error"); // a salvage that returned no report is a real failure, not a budget trip
    expect(result.steps.some((s) => s.kind === "error")).toBe(true);
    expect(llm.requests).toHaveLength(2); // exactly one salvage attempt, never more
  });

  it("[4a] step cap: 3 tool-loops then a would-be 4th -> salvage fires instead -> report", async () => {
    const r1 = makeMessage({ content: [toolUse("c1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null })], stop_reason: "tool_use" });
    const r2 = makeMessage({ content: [toolUse("c2", "search_logs", { service: null, level: null, contains: null, window: null, limit: null })], stop_reason: "tool_use" });
    const r3 = makeMessage({ content: [toolUse("c3", "list_deploys", { window: null })], stop_reason: "tool_use" });
    const salvageResp = makeMessage({ content: [toolUse("c4", "submit_report", GOOD_REPORT)], stop_reason: "tool_use" });
    const llm = scriptedLLM([r1, r2, r3, salvageResp]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: { ...baseCaps(), maxSteps: 3 },
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    expect(llm.requests).toHaveLength(4);
    expect(llm.requests[3]?.tool_choice).toEqual({ type: "tool", name: "submit_report" });
  });

  it("[4b] token budget cap: cumulative usage exceeding maxTokensIn mid-loop -> salvage", async () => {
    const r1 = makeMessage({ content: [toolUse("c1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null })], stop_reason: "tool_use", usage: usage({ input_tokens: 100 }) });
    const r2 = makeMessage({ content: [toolUse("c2", "search_logs", { service: null, level: null, contains: null, window: null, limit: null })], stop_reason: "tool_use", usage: usage({ input_tokens: 100 }) });
    const salvageResp = makeMessage({ content: [toolUse("c3", "submit_report", GOOD_REPORT)], stop_reason: "tool_use" });
    const llm = scriptedLLM([r1, r2, salvageResp]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: { ...baseCaps(), maxTokensIn: 150 }, // trips after 2 calls (100 then 200 >= 150)
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[2]?.tool_choice).toEqual({ type: "tool", name: "submit_report" });
  });

  it("[4c] wall clock cap: nowFn advanced past maxWallMs mid-loop -> salvage", async () => {
    let clock = NOW0;
    const r1 = makeMessage({ content: [toolUse("c1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null })], stop_reason: "tool_use" });
    const r2 = makeMessage({ content: [toolUse("c2", "search_logs", { service: null, level: null, contains: null, window: null, limit: null })], stop_reason: "tool_use" });
    const salvageResp = makeMessage({ content: [toolUse("c3", "submit_report", GOOD_REPORT)], stop_reason: "tool_use" });
    const llm = scriptedLLM([r1, r2, salvageResp]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      // Each tool execution simulates 60s of wall-clock time passing.
      executeTool: async () => {
        clock += 60_000;
        return { ok: true };
      },
      caps: { ...baseCaps(), maxWallMs: 100_000 }, // trips after 2 simulated 60s executions (120s >= 100s)
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => clock,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[2]?.tool_choice).toEqual({ type: "tool", name: "submit_report" });
    // The wall cap has tripped, so remaining budget is 0 — the salvage call must still get a
    // real timeout (SALVAGE_FLOOR_MS floor), otherwise a timeout of 0 aborts the SDK request
    // instantly and a wall-capped investigation could never salvage a report, only fail.
    expect(llm.timeouts[2]).toBeGreaterThanOrEqual(SALVAGE_FLOOR_MS);
    // The non-salvage calls still get the plain remaining-budget timeout, no floor.
    expect(llm.timeouts[0]).toBe(100_000);
  });

  it("[5] duplicate-call nudge: 3rd identical call gets synthetic error nudge; 4th (ignored) forces salvage, not infinite", async () => {
    const sameInput = { service: "checkout", level: "error" as const, contains: null, window: { from: "2026-01-05T13:30:00.000Z", to: "2026-01-05T14:00:00.000Z" }, limit: null };
    const r1 = makeMessage({ content: [toolUse("c1", "search_logs", sameInput)], stop_reason: "tool_use" });
    const r2 = makeMessage({ content: [toolUse("c2", "search_logs", sameInput)], stop_reason: "tool_use" });
    const r3 = makeMessage({ content: [toolUse("c3", "search_logs", sameInput)], stop_reason: "tool_use" });
    const r4 = makeMessage({ content: [toolUse("c4", "search_logs", sameInput)], stop_reason: "tool_use" });
    const salvageResp = makeMessage({ content: [toolUse("c5", "submit_report", GOOD_REPORT)], stop_reason: "tool_use" });
    const llm = scriptedLLM([r1, r2, r3, r4, salvageResp]);

    let executeCount = 0;
    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => {
        executeCount += 1;
        return { ok: true };
      },
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    expect(llm.requests).toHaveLength(5); // 4 identical calls + 1 salvage call — never infinite
    // Only the 1st and 2nd calls actually executed; the 3rd (nudge) and 4th (forced salvage) did not.
    expect(executeCount).toBe(2);

    const toolResultSteps = result.steps.filter((s) => s.kind === "tool_result");
    expect(toolResultSteps).toHaveLength(4);
    const nudgeStep = toolResultSteps[2] as StepRecord & { content: { output: { error: string }; is_error: boolean } };
    expect(nudgeStep.content.output.error).toContain("submit_report");
    expect(nudgeStep.content.is_error).toBe(true);
  });

  it("[6] checkUpdates string is injected as a user message immediately before the next model call", async () => {
    const r1 = makeMessage({ content: [toolUse("c1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null })], stop_reason: "tool_use" });
    const r2 = makeMessage({ content: [toolUse("c2", "submit_report", GOOD_REPORT)], stop_reason: "tool_use" });
    const llm = scriptedLLM([r1, r2]);

    let checkCalls = 0;
    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      checkUpdates: async () => {
        checkCalls += 1;
        return checkCalls === 2 ? "checkout p95 now 9x baseline" : null;
      },
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    // No injection on the FIRST call.
    const req0Texts = llm.requests[0]?.messages.map((m) => JSON.stringify(m.content));
    expect(req0Texts?.some((t) => t.includes("detector update"))).toBe(false);

    // Injected as the LAST message before the SECOND call.
    const req1Messages = llm.requests[1]?.messages ?? [];
    const lastMsg = req1Messages[req1Messages.length - 1];
    expect(lastMsg?.role).toBe("user");
    expect(((lastMsg?.content as ContentBlockParam[])[0] as { text: string }).text).toBe("detector update: checkout p95 now 9x baseline");

    expect(result.steps.some((s) => s.kind === "note" && (s.content as { update: string }).update === "checkout p95 now 9x baseline")).toBe(true);
  });

  it("[6b] shouldAbort true at an iteration top -> outcome failed with an 'aborted' error step, NO salvage call", async () => {
    const r1 = makeMessage({ content: [toolUse("c1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null })], stop_reason: "tool_use" });
    // Only ONE scripted response: if the abort path incorrectly attempted a salvage call, the
    // script would run dry and the failure reason would say "scriptedLLM", not "aborted".
    const llm = scriptedLLM([r1]);

    let checks = 0;
    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      shouldAbort: async () => {
        checks += 1;
        return checks >= 2; // false at iteration 1's top, true at iteration 2's
      },
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("failed");
    expect(result.failure).toBe("aborted"); // the structural discriminant chat's disconnect guard branches on
    expect(llm.requests).toHaveLength(1); // the in-flight iteration only -- no second call, no salvage
    expect(result.steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result", "error"]);
    expect(result.steps[2]?.content).toEqual({ message: "aborted" });
  });

  it("[7] chat mode (no submitReportTool): end_turn with text -> outcome text", async () => {
    const r1 = makeMessage({ content: [text("The checkout error rate returned to baseline at 14:45Z.")], stop_reason: "end_turn" });
    const llm = scriptedLLM([r1]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: baseCaps(),
      // submitReportTool omitted: chat mode.
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("text");
    expect(result.text).toBe("The checkout error rate returned to baseline at 14:45Z.");
    expect(llm.requests).toHaveLength(1); // no salvage attempted without a submit_report tool
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });

  it("[7a] chat mode: a cap trip with no submit_report tool -> outcome failed with failure 'budget'", async () => {
    const r1 = makeMessage({ content: [toolUse("c1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null })], stop_reason: "tool_use" });
    // Only one scripted response: the step cap (1) trips before a second call; without a
    // submit_report tool, salvage() records the budget-exhausted error and returns immediately.
    const llm = scriptedLLM([r1]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: { ...baseCaps(), maxSteps: 1 },
      // submitReportTool omitted: chat mode.
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("failed");
    expect(result.failure).toBe("budget"); // what chat.ts turns into the budget_reached SSE event
    expect(llm.requests).toHaveLength(1); // no salvage model call without a tool to force
  });

  it("[7b] chat mode: stop_reason max_tokens with no tool calls -> failed with failure 'budget' (a truncation is a budget trip, not a crash)", async () => {
    const r1 = makeMessage({ content: [text("The timeline begins at 14:02 when")], stop_reason: "max_tokens" });
    const llm = scriptedLLM([r1]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: baseCaps(),
      // submitReportTool omitted: chat mode (with it present, salvage fires first instead).
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("failed");
    expect(result.failure).toBe("budget");
    expect(llm.requests).toHaveLength(1);
    expect(result.steps.map((s) => s.kind)).toEqual(["error"]);
  });

  it("[8] onStep is called for every step in order and awaited before the next model call", async () => {
    const r1 = makeMessage({ content: [toolUse("c1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null })], stop_reason: "tool_use" });
    const r2 = makeMessage({ content: [toolUse("c2", "submit_report", GOOD_REPORT)], stop_reason: "tool_use" });
    const script = scriptedLLM([r1, r2]);

    const order: string[] = [];
    let callIdx = 0;
    const llm: LLM = {
      create: async (params, timeoutMs) => {
        order.push(`create:${callIdx}`);
        callIdx += 1;
        return script.create(params, timeoutMs);
      },
    };

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      onStep: async (step) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`onStep:${step.step_no}`);
      },
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("report");
    // create:0 (model call 1) -> tool_call/tool_result steps for it, each onStep AWAITED ->
    // create:1 (model call 2, the submit_report turn) -> its own report step's onStep.
    expect(order).toEqual(["create:0", "onStep:1", "onStep:2", "create:1", "onStep:3"]);
  });

  it("llm.create rejection -> outcome failed with an error StepRecord, never throws", async () => {
    const llm: LLM = {
      create: async () => {
        throw new Error("network is down");
      },
    };

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES);

    expect(result.outcome).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.kind).toBe("error");
    expect((result.steps[0]?.content as { message: string }).message).toContain("network is down");
  });

  it("onStep throwing -> outcome failed, runLoop still never throws", async () => {
    const r1 = makeMessage({ content: [toolUse("c1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null })], stop_reason: "tool_use" });
    const llm = scriptedLLM([r1]);

    const cfg: LoopConfig = {
      llm,
      model: "claude-sonnet-5",
      system: [{ type: "text", text: "sys" }],
      tools: TOOLS,
      executeTool: async () => ({ ok: true }),
      caps: baseCaps(),
      submitReportTool: SUBMIT_REPORT,
      onStep: async () => {
        throw new Error("persistence down");
      },
      nowFn: () => NOW0,
    };

    const result = await runLoop(cfg, INITIAL_MESSAGES); // must resolve, not reject
    expect(result.outcome).toBe("failed");
  });
});
