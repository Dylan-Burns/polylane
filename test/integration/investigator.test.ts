import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ContentBlockParam,
  Message,
  MessageParam,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";
import type { LLM } from "../../src/agent/llm";
import { scriptedLLM } from "../../src/agent/llm";
import { insertSpans } from "../../src/telemetry/queries";
import type { Span } from "../../src/telemetry/types";

// Mandated integration tests (Task 4.2 brief): InvestigatorDO persistence/resume/budgets, driven
// the same documented way `test/integration/simulator.test.ts` drives SimulatorDO's alarm-based
// flows -- `runInDurableObject` for direct instance access (llmFactory/setTestNow injection, raw
// storage seeding/inspection) and explicit `instance.alarm()` calls instead of waiting on real
// wall-clock time. Each test uses its OWN `idFromName` so DO storage never bleeds across tests;
// D1 is shared, so `afterEach` clears every table these tests touch.

// ============================================================================================
// Fixture builders -- trimmed copies of loop.test.ts's own (that file's helpers aren't exported;
// duplicating a handful of small builders is cheaper than introducing cross-test-file coupling).
// ============================================================================================

const NOW0 = Date.UTC(2026, 0, 20, 14, 0, 0);

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

function thinking(t: string, signature: string): ThinkingBlock {
  return { type: "thinking", thinking: t, signature };
}

function toolUse(id: string, name: string, input: unknown): ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

/**
 * A safe `llmFactory` override for tests that call `/start` but don't want the loop to actually
 * run (e.g. the `/start`/`/abort` lifecycle test below, which only cares about the 1-concurrent
 * invariant). `/start` arms an alarm the DO's own alarm scheduler genuinely fires on its own
 * shortly after (confirmed empirically -- this is NOT `ctx.waitUntil`-dependent, which is exactly
 * the point of routing execution through `alarm()`) -- WITHOUT this, that stray firing would use
 * the DEFAULT `realLLM`, attempting a genuine 60s-timeout network call in a sandboxed test
 * environment that never resolves within the test's lifetime, surfacing later as an unattributed
 * "uncaught exception in promise" during teardown.
 *
 * The returned promise never settles -- deliberately: a llmFactory that THROWS would let the
 * auto-fired alarm run the loop to a `failed` outcome and clear the DO's `active` key before the
 * test gets a chance to observe it as "still active" (a real race this project's own alarm-driven
 * design creates), defeating the 1-concurrent test's premise. A promise that never resolves keeps
 * the investigation genuinely in-flight (and `active` genuinely set) for as long as the test
 * needs, with no real I/O and nothing left to reject at teardown.
 */
function neverRespondingLLM(): LLM {
  return { create: () => new Promise(() => {}) };
}

const GOOD_REPORT = {
  summary: "Payments pool exhaustion caused checkout failures.",
  timeline: [{ time: "14:32Z", description: "checkout error_rate spiked" }],
  root_cause: { hypothesis: "connection pool exhaustion", mechanism: "payments pool saturated" },
  evidence: [{ description: "failing trace", trace_id: "test-trace-1", metric: null, log_excerpt: null }],
  blast_radius: { affected_services: ["checkout", "payments"], customer_impact: "~5% of checkouts failed" },
  confidence: { level: "high", why: "reproduced in a single trace" },
  suggested_action: "roll back the payments deploy",
};

const GOOD_REPORT_NO_EVIDENCE = {
  ...GOOD_REPORT,
  evidence: [{ description: "no trace cited", trace_id: null, metric: "payments error_rate", log_excerpt: null }],
};

interface IncidentRow {
  status: string;
  report_json: string | null;
}

async function insertIncident(id: string, status: string, openedAtMs: number, triggerJson = "{}"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES (?, ?, 'critical', ?, ?)`,
  )
    .bind(id, status, openedAtMs, triggerJson)
    .run();
}

async function getIncident(id: string): Promise<IncidentRow | null> {
  return env.DB.prepare(`SELECT status, report_json FROM incidents WHERE id = ?`).bind(id).first<IncidentRow>();
}

interface StepRow {
  step_no: number;
  kind: string;
  content_json: string;
  tokens_in: number;
  tokens_out: number;
}

async function getSteps(incidentId: string): Promise<StepRow[]> {
  const { results } = await env.DB
    .prepare(`SELECT step_no, kind, content_json, tokens_in, tokens_out FROM investigation_steps WHERE incident_id = ? ORDER BY step_no ASC`)
    .bind(incidentId)
    .all<StepRow>();
  return results ?? [];
}

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    trace_id: "test-trace-1",
    span_id: "span-1",
    parent_span_id: null,
    service: "payments",
    operation: "charge",
    start_ms: NOW0 - 60_000,
    duration_ms: 3000,
    status: "error",
    error_type: "pool_exhausted",
    ...overrides,
  };
}

afterEach(async () => {
  for (const table of ["investigation_steps", "incident_fingerprints", "incidents", "spans", "logs", "meta"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("InvestigatorDO: end-to-end mock investigation", () => {
  it("steps land in D1 in order with correct kinds/tokens; conv snapshots exist mid-run (incl. signed thinking blocks); report lands with embedded evidence; status open -> investigating -> reported; conv state cleared after", async () => {
    const incidentId = "inc-e2e-1";
    await insertIncident(incidentId, "open", NOW0 - 120_000);
    await insertSpans(env.DB, [makeSpan()]);

    const stub = env.INVESTIGATOR.get(env.INVESTIGATOR.idFromName("test-e2e-1"));

    const r1 = makeMessage({
      content: [
        thinking("checking payments metrics first", "sig-e2e-1"),
        toolUse("call-1", "query_metrics", { service: "payments", operation: null, metrics: null, window: { from: "-30m", to: null }, step: null }),
      ],
      stop_reason: "tool_use",
      usage: usage({ input_tokens: 500, output_tokens: 80 }),
    });
    const r2 = makeMessage({
      content: [toolUse("call-2", "submit_report", GOOD_REPORT)],
      stop_reason: "tool_use",
      usage: usage({ input_tokens: 700, output_tokens: 300 }),
    });

    let midRunConv: MessageParam[] | undefined;
    await runInDurableObject(stub, async (instance, state) => {
      instance.setTestNow(NOW0);
      const script = scriptedLLM([r1, r2]);
      const wrapped: LLM = {
        create: async (params, timeoutMs) => {
          if (script.requests.length === 1) {
            // About to fire the SECOND model call -- the conv snapshot from step 1 must already
            // be durable in DO storage (spec §9's per-step persistence, "during the run" -- not
            // just after the whole investigation finishes).
            midRunConv = await state.storage.get<MessageParam[]>(`conv:${incidentId}`);
          }
          return script.create(params, timeoutMs);
        },
      };
      instance.llmFactory = () => wrapped;
    });

    const startRes = await stub.fetch("http://investigator/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId, statement: "payments error_rate 24% vs baseline 0.3%" }),
    });
    expect(startRes.status).toBe(202);
    expect((await getIncident(incidentId))?.status).toBe("investigating");

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    // --- Conv snapshot existed mid-run, verbatim (signed thinking block preserved exactly). ---
    expect(midRunConv).toBeDefined();
    const assistantTurn = midRunConv?.find((m) => m.role === "assistant");
    const thinkingBlock = (assistantTurn?.content as ContentBlockParam[] | undefined)?.find((b) => b.type === "thinking");
    expect(thinkingBlock).toEqual(thinking("checking payments metrics first", "sig-e2e-1"));

    // --- Steps landed in D1, in order, correct kinds/tokens. ---
    const steps = await getSteps(incidentId);
    expect(steps.map((s) => s.step_no)).toEqual([1, 2, 3]);
    expect(steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result", "report"]);
    expect(steps[0]?.tokens_in).toBe(500);
    expect(steps[0]?.tokens_out).toBe(80);
    expect(JSON.parse(steps[0]?.content_json ?? "{}")).toMatchObject({ name: "query_metrics" });

    // --- Report lands with embedded evidence. ---
    const incident = await getIncident(incidentId);
    expect(incident?.status).toBe("reported");
    const report = JSON.parse(incident?.report_json ?? "{}");
    expect(report.summary).toBe(GOOD_REPORT.summary);
    expect(report.evidence[0].trace_id).toBe("test-trace-1");
    expect(report.evidence[0].embedded.spans).toHaveLength(1);
    expect(report.evidence[0].embedded.spans[0].span_id).toBe("span-1");

    // --- Conv state cleared after. ---
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(`conv:${incidentId}`)).toBeUndefined();
      expect(await state.storage.get(`meta:${incidentId}`)).toBeUndefined();
      expect(await state.storage.get("active")).toBeUndefined();
    });
  });
});

describe("InvestigatorDO: resume after a simulated death", () => {
  it("rebuilds from stored conv+budgets, scripted continuation completes, step_no continues with no duplicates, wall budget carried across the boundary", async () => {
    const incidentId = "inc-resume-1";
    await insertIncident(incidentId, "investigating", NOW0 - 60_000);

    const stub = env.INVESTIGATOR.get(env.INVESTIGATOR.idFromName("test-resume-1"));

    // Simulate "died after step 2": a complete, resumable conversation (assistant tool_use turn
    // already answered by its tool_result -- not a dangling mid-turn snapshot), 2 investigation_steps
    // already written, and cumulative budgets already partially consumed.
    const priorAssistant: MessageParam = {
      role: "assistant",
      content: [toolUse("call-1", "query_metrics", { service: null, operation: null, metrics: null, window: null, step: null })] as unknown as ContentBlockParam[],
    };
    const priorToolResult: MessageParam = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: JSON.stringify({ ok: true }), is_error: false }],
    };
    const preCrashConv: MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "Anomaly detected: payments p95 8x baseline" }] },
      priorAssistant,
      priorToolResult,
    ];

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("active", incidentId);
      await state.storage.put(`conv:${incidentId}`, preCrashConv);
      await state.storage.put(`meta:${incidentId}`, {
        statement: "payments p95 8x baseline",
        openedAtMs: NOW0 - 60_000,
        nextStepNo: 3,
        iterations: 1,
        tokensIn: 1500,
        tokensOut: 300,
        elapsedMs: 200_000, // 200s of the 240s wall budget already consumed pre-crash
      });
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO investigation_steps (incident_id, step_no, kind, content_json, ts_ms, tokens_in, tokens_out) VALUES (?, 1, 'tool_call', '{}', ?, 750, 150)`,
      ).bind(incidentId, NOW0 - 50_000),
      env.DB.prepare(
        `INSERT INTO investigation_steps (incident_id, step_no, kind, content_json, ts_ms, tokens_in, tokens_out) VALUES (?, 2, 'tool_result', '{}', ?, 750, 150)`,
      ).bind(incidentId, NOW0 - 40_000),
    ]);

    const r2 = makeMessage({ content: [toolUse("call-2", "submit_report", GOOD_REPORT_NO_EVIDENCE)], stop_reason: "tool_use" });
    const llm = scriptedLLM([r2]);

    await runInDurableObject(stub, async (instance) => {
      instance.setTestNow(NOW0); // frozen -- this resumed call's OWN elapsed stays ~0
      instance.llmFactory = () => llm;
      await instance.alarm();
    });

    // --- Budgets carried across the boundary: the resumed call's timeout reflects the REMAINING
    // wall budget (240s - 200s = 40s), not a fresh 240s -- proof `meta.elapsedMs` was honored. ---
    expect(llm.timeouts[0]).toBe(40_000);

    // --- Completed; report landed. ---
    const incident = await getIncident(incidentId);
    expect(incident?.status).toBe("reported");
    expect(JSON.parse(incident?.report_json ?? "{}").summary).toBe(GOOD_REPORT_NO_EVIDENCE.summary);

    // --- step_no continues from where it left off, no duplicates. ---
    const steps = await getSteps(incidentId);
    expect(steps.map((s) => s.step_no)).toEqual([1, 2, 3]);
    expect(steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result", "report"]);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(`conv:${incidentId}`)).toBeUndefined();
      expect(await state.storage.get("active")).toBeUndefined();
    });
  });
});

describe("InvestigatorDO: guarded report write", () => {
  it("a force-failed incident (watchdog raced mid-run) is never overwritten by a late report; a note step records the discard", async () => {
    const incidentId = "inc-guarded-1";
    await insertIncident(incidentId, "investigating", NOW0 - 30_000);

    const stub = env.INVESTIGATOR.get(env.INVESTIGATOR.idFromName("test-guarded-1"));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("active", incidentId);
      await state.storage.put(`conv:${incidentId}`, [{ role: "user", content: [{ type: "text", text: "anomaly" }] }]);
      await state.storage.put(`meta:${incidentId}`, {
        statement: "anomaly",
        openedAtMs: NOW0 - 30_000,
        nextStepNo: 1,
        iterations: 0,
        tokensIn: 0,
        tokensOut: 0,
        elapsedMs: 0,
      });
    });

    const r1 = makeMessage({ content: [toolUse("call-1", "submit_report", GOOD_REPORT_NO_EVIDENCE)], stop_reason: "tool_use" });
    const script = scriptedLLM([r1]);

    await runInDurableObject(stub, async (instance) => {
      instance.setTestNow(NOW0);
      const wrapped: LLM = {
        create: async (params, timeoutMs) => {
          // Simulate the stuck-investigation watchdog (`forceFailStuck`) force-failing this
          // incident mid-flight, before the model even responds.
          await env.DB.prepare(`UPDATE incidents SET status = 'failed', resolved_at = ? WHERE id = ?`).bind(NOW0, incidentId).run();
          return script.create(params, timeoutMs);
        },
      };
      instance.llmFactory = () => wrapped;
      await instance.alarm();
    });

    // --- The incident stays failed -- the report write must no-op, not overwrite. ---
    const incident = await getIncident(incidentId);
    expect(incident?.status).toBe("failed");
    expect(JSON.parse(incident?.report_json ?? "{}")).toEqual({}); // untouched by the discarded report write

    // --- A note step records the discard. ---
    const steps = await getSteps(incidentId);
    const noteStep = steps.find((s) => s.kind === "note");
    expect(noteStep).toBeDefined();
    expect(JSON.parse(noteStep?.content_json ?? "{}")).toEqual({ text: "report discarded: incident no longer investigating" });

    // --- Terminal cleanup still ran. ---
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(`conv:${incidentId}`)).toBeUndefined();
      expect(await state.storage.get("active")).toBeUndefined();
    });
  });
});

describe("InvestigatorDO: /start, /abort lifecycle", () => {
  it("409s a second /start while active; /abort fails the incident with a reason and clears state; a subsequent /start is then accepted", async () => {
    const incidentA = "inc-lifecycle-a";
    const incidentC = "inc-lifecycle-c";
    await insertIncident(incidentA, "open", NOW0 - 10_000);
    await insertIncident(incidentC, "open", NOW0 - 5_000);

    const stub = env.INVESTIGATOR.get(env.INVESTIGATOR.idFromName("test-lifecycle-1"));
    await runInDurableObject(stub, async (instance) => {
      instance.setTestNow(NOW0);
      instance.llmFactory = () => neverRespondingLLM();
    });

    const startA = await stub.fetch("http://investigator/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId: incidentA, statement: "anomaly A" }),
    });
    expect(startA.status).toBe(202);
    expect((await getIncident(incidentA))?.status).toBe("investigating");

    const statusRes = await stub.fetch("http://investigator/status");
    expect(await statusRes.json()).toEqual({ active: true, incidentId: incidentA });

    const startB = await stub.fetch("http://investigator/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId: "inc-lifecycle-b", statement: "anomaly B" }),
    });
    expect(startB.status).toBe(409);
    expect(await startB.json()).toEqual({ error: "investigation_active" });

    const abortRes = await stub.fetch("http://investigator/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "test abort" }),
    });
    expect(abortRes.status).toBe(202);

    const incidentAAfterAbort = await getIncident(incidentA);
    expect(incidentAAfterAbort?.status).toBe("failed");
    expect(JSON.parse(incidentAAfterAbort?.report_json ?? "{}")).toEqual({ failure_reason: "test abort" });

    const statusAfterAbort = await stub.fetch("http://investigator/status");
    expect(await statusAfterAbort.json()).toEqual({ active: false });

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(`conv:${incidentA}`)).toBeUndefined();
    });

    const startC = await stub.fetch("http://investigator/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId: incidentC, statement: "anomaly C" }),
    });
    expect(startC.status).toBe(202);
    expect((await getIncident(incidentC))?.status).toBe("investigating");
  });
});

describe("InvestigatorDO: detector update injection", () => {
  it("an undelivered fingerprint seeded mid-run is injected as a 'detector update:' user message on the NEXT model call, and marked delivered", async () => {
    const incidentId = "inc-update-1";
    const trigger = { statements: ["checkout error_rate 12%"], anomalies: [{ statement: "checkout error_rate 12%", fingerprint: "checkout:errors", service: "checkout", rule: "sustained" }] };
    await insertIncident(incidentId, "open", NOW0 - 10_000, JSON.stringify(trigger));

    const stub = env.INVESTIGATOR.get(env.INVESTIGATOR.idFromName("test-update-1"));

    const r1 = makeMessage({ content: [toolUse("call-1", "query_metrics", { service: "checkout", operation: null, metrics: null, window: null, step: null })], stop_reason: "tool_use" });
    const r2 = makeMessage({ content: [toolUse("call-2", "submit_report", GOOD_REPORT_NO_EVIDENCE)], stop_reason: "tool_use" });
    const script = scriptedLLM([r1, r2]);

    // Wire the clock + llmFactory seam BEFORE the real /start call below (no alarm fired yet --
    // /start hasn't run, so there's nothing to drive).
    await runInDurableObject(stub, async (instance) => {
      instance.setTestNow(NOW0);
      const wrapped: LLM = {
        create: async (params, timeoutMs) => {
          if (script.requests.length === 0) {
            // Seed the undelivered detector update while call 1 is in flight, so it's present in
            // D1 by the time call 2's checkUpdates runs (the loop checks BEFORE each model call).
            await env.DB.batch([
              env.DB.prepare(
                `INSERT INTO incident_fingerprints (incident_id, fingerprint, first_seen_ms, delivered_to_agent) VALUES (?, 'payments:latency', ?, 0)`,
              ).bind(incidentId, NOW0),
              env.DB.prepare(`UPDATE incidents SET trigger_json = ? WHERE id = ?`).bind(
                JSON.stringify({
                  statements: [...trigger.statements, "payments p95 now 9x baseline"],
                  anomalies: [...trigger.anomalies, { statement: "payments p95 now 9x baseline", fingerprint: "payments:latency", service: "payments", rule: "sustained" }],
                }),
                incidentId,
              ),
            ]);
          }
          return script.create(params, timeoutMs);
        },
      };
      instance.llmFactory = () => wrapped;
    });

    const startRes = await stub.fetch("http://investigator/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId, statement: "checkout error_rate 12%" }),
    });
    expect(startRes.status).toBe(202);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    // --- The SECOND request carries the injected "detector update: ..." user message. ---
    expect(script.requests).toHaveLength(2);
    const secondReqMessages = script.requests[1]?.messages ?? [];
    const lastMsg = secondReqMessages[secondReqMessages.length - 1];
    expect(lastMsg?.role).toBe("user");
    const lastText = ((lastMsg?.content as ContentBlockParam[] | undefined)?.[0] as { text?: string } | undefined)?.text;
    expect(lastText).toBe("detector update: payments p95 now 9x baseline");

    const incident = await getIncident(incidentId);
    expect(incident?.status).toBe("reported");

    const fpRow = await env.DB
      .prepare(`SELECT delivered_to_agent FROM incident_fingerprints WHERE incident_id = ? AND fingerprint = 'payments:latency'`)
      .bind(incidentId)
      .first<{ delivered_to_agent: number }>();
    expect(fpRow?.delivered_to_agent).toBe(1);
  });
});
