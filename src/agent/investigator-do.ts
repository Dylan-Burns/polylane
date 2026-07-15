/**
 * InvestigatorDO: the single `idFromName('investigator')` Durable Object that runs the
 * investigator agent loop (spec §9) end to end — persistence, resume, and budgets. Mirrors
 * `sim/simulator-do.ts`'s structure deliberately (same alarm-driven-recovery shape, same
 * `setTestNow`/hook-injection seams for deterministic tests): a request handler does the minimal
 * synchronous bookkeeping and hands the actual (potentially minutes-long) work to the alarm.
 *
 * **Why the loop runs inside `alarm()`, not inline in `/start`'s fetch handler**: `/start` must
 * return fast (the sweep's cron-driven `notifyInvestigator` call awaits it — Task 3.3), and a
 * DO's own `ctx.waitUntil` has no test-observable "flush" point this project's test harness can
 * hook into deterministically. Routing ALL loop execution through `alarm()` sidesteps that
 * entirely and matches this repo's own precedent (`SimulatorDO`'s reset: a fetch handler commits
 * state and arms an alarm; the alarm does the heavy lifting) — tests drive it the same documented
 * way `test/integration/simulator.test.ts` does: call `instance.alarm()` directly via
 * `runInDurableObject`, never wait on real wall-clock time.
 *
 * **Two persisted representations per step** (spec §9): (a) `conv:<incidentId>` in DO storage —
 * the exact `messages` array `runLoop` holds, including signed thinking blocks and verbatim
 * capped tool results, for resume fidelity; (b) an `investigation_steps` D1 row — the
 * human-readable UI-timeline projection. Both are written from the SAME `onStep` callback, in that
 * order, before the next model call ever fires (`loop.ts`'s `onStep` persistence contract).
 *
 * **Budgets across a resume boundary**: `meta:<incidentId>` in DO storage tracks cumulative
 * `iterations`/`tokensIn`/`tokensOut`/`elapsedMs` consumed so far, updated from `runLoop`'s own
 * `StepContext` (iterations/usage) plus this DO's own wall-clock read (`elapsedMs`) after every
 * step. A resumed run's `caps` are `BASE - consumedSoFar` (floored at 0), so `runLoop`'s own cap
 * check trips at the correct COMBINED total across however many alarm-driven attempts it took —
 * never a full fresh budget each time.
 *
 * **1-concurrent invariant**: a single DO storage key, `active` (the incident id currently under
 * investigation, if any) — `/start` checks-and-sets it atomically (`blockConcurrencyWhile`, like
 * `SimulatorDO.handleFault`'s cooldown gate), `/abort` and every terminal outcome clear it.
 *
 * **Cooperative cancellation** (review FIX 1): `/abort` can land while a loop is mid-flight (in
 * an `llm.create` await it cannot be preempted out of). Killing it isn't possible; letting it run
 * to its own budget caps would burn up to the full remaining spend (~$0.40) against telemetry
 * that may already be wiped, appending step rows to an already-failed incident for minutes. So
 * `/abort` sets a `cancelled` storage key holding the in-flight run's `runId`, and the loop
 * (via `LoopConfig.shouldAbort`) checks it at every iteration top: at most ONE in-flight model
 * call + its tool executions complete after an abort, then the loop exits `failed` with no
 * salvage call. Each investigation attempt carries a unique `runId` (in `meta:<incidentId>`) so a
 * stale cancel — or a zombie loop's terminal cleanup — can never touch a NEWER investigation,
 * even one that reuses the same incident id.
 *
 * **Idle quiesce** (review FIX 2): the keepalive alarm exists only to resurrect a crashed loop,
 * so once nothing is active it must stop — `alarm()` deletes the just-re-armed alarm when no
 * investigation is active, and every terminal cleanup deletes the pending alarm alongside the
 * `active` key. A finished investigator goes fully silent instead of heartbeating forever.
 */

import { DurableObject } from "cloudflare:workers";
import type { ContentBlockParam, MessageParam, ToolUseBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { Env } from "../env";
import { realLLM, type LLM } from "./llm";
import { runLoop, type LoopCaps, type LoopResult, type StepContext, type StepRecord } from "./loop";
import { buildInitialMessages, buildInvestigatorSystemPrompt } from "./prompts";
import { embedEvidence, validateReport } from "./report-schema";
import { SUBMIT_REPORT, TOOLS, executeTool } from "./tools";
import {
  insertInvestigationStep,
  markDelivered,
  setStatus,
  setStatusGuarded,
  undeliveredUpdates,
} from "../telemetry/incidents";

/** Per-investigation budgets (Global Constraints / spec §9): 1-concurrent is enforced separately
 * (the `active` storage key); these four are the per-investigation caps `runLoop` itself enforces. */
const MAX_STEPS = 15;
const MAX_WALL_MS = 240_000;
const MAX_TOKENS_IN = 200_000;
const MAX_TOKENS_OUT = 16_000;

/** Alarm re-arm cadence while a loop is actively progressing (spec §9: "re-armed before each model
 * call" / "before each await"). Comfortably above `llm.ts`'s `DEFAULT_TIMEOUT_MS` (60s, the longest
 * a single call can legitimately take) so a healthy in-flight call is never mistaken for a dead
 * one — the `loopRunning` in-memory guard (below) is the belt to this cadence's suspenders. */
const KEEPALIVE_MS = 90_000;

/** The single `idFromName('investigator')` InvestigatorDO stub every caller (the sweep, the chaos
 * reset abort call site) talks to — mirrors `sim/simulator-do.ts`'s `simulatorStub`. */
export function investigatorStub(env: Pick<Env, "INVESTIGATOR">): DurableObjectStub {
  return env.INVESTIGATOR.get(env.INVESTIGATOR.idFromName("investigator"));
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Persisted per active investigation (`meta:<incidentId>`) — the resume-budget bookkeeping the
 * file doc comment describes, plus the byte-stable inputs `prompts.ts` needs to rebuild an
 * IDENTICAL system prompt across a resume (`statement`/`openedAtMs`, stamped once at `/start`). */
interface InvestigationMeta {
  statement: string;
  openedAtMs: number;
  /** Unique per investigation *attempt lineage* (minted once at `/start`, carried across
   * resumes): the ownership token that keeps a zombie loop's cleanup, or a stale `cancelled`
   * flag, from ever touching a NEWER investigation — including one that reuses the same incident
   * id (the "latent same-id clobber" the review flagged). */
  runId: string;
  /** The next `investigation_steps.step_no` to assign — continues across a resume rather than
   * restarting from 1, so the D1 timeline has no duplicate/overwritten rows. */
  nextStepNo: number;
  iterations: number;
  tokensIn: number;
  tokensOut: number;
  /** Cumulative real wall-clock ms actually spent running the loop, summed across every
   * alarm-driven attempt (NOT wall-clock time since the incident opened — an isolate sitting idle
   * between a death and its resume must not count against the 4-minute budget). */
  elapsedMs: number;
}

/** The neutral user turn appended when a resumed conversation's tail is a COMPLETE assistant
 * turn (see `healConversationTail` case 2). Exported for the resume test's exact assertion. */
export const RESUME_CONTINUE_TEXT = "continue the investigation from where it left off";

/**
 * Heals a possibly-mid-turn conversation snapshot before handing it to a fresh `runLoop` call —
 * a resumed transcript must always end on a USER turn, for two distinct reasons:
 *
 * 1. **Dangling tool calls**: the persisted `conv` ends with an assistant turn containing
 *    `tool_use` blocks (the DO died between recording that turn's `tool_call`/`tool_result`
 *    steps, before the aggregated `tool_result` user turn was ever pushed). The Anthropic API
 *    requires every `tool_use` to be answered by a matching `tool_result` in the immediately
 *    following user turn, so a synthetic error `tool_result` is appended for each dangling id —
 *    the model sees its interrupted calls as failed and naturally moves on (retry, or conclude
 *    with what it has) rather than the resume producing a malformed request.
 * 2. **Trailing complete assistant turn** (review minor): the DO died right after snapshotting a
 *    tool_use-free assistant response (e.g. an `end_turn` text the loop hadn't yet reacted to).
 *    Resubmitting an assistant-final transcript would be read by the API as a *prefill* — an
 *    instruction to continue generating that same turn's text — not as a fresh turn. A neutral
 *    user "continue" message is appended instead, so the resumed call is a normal next turn.
 */
function healConversationTail(messages: readonly MessageParam[]): MessageParam[] {
  if (messages.length === 0) return [];
  const last = messages[messages.length - 1] as MessageParam;
  if (last.role !== "assistant") return [...messages];

  const blocks = Array.isArray(last.content) ? last.content : [];
  const toolUses = blocks.filter((b): b is ToolUseBlockParam => b.type === "tool_use");
  if (toolUses.length > 0) {
    const results: ContentBlockParam[] = toolUses.map((tu) => ({
      type: "tool_result",
      tool_use_id: tu.id,
      content: JSON.stringify({ error: "investigation interrupted before this tool call completed; retry or proceed with the available evidence" }),
      is_error: true,
    }));
    return [...messages, { role: "user", content: results }];
  }

  return [...messages, { role: "user", content: [{ type: "text", text: RESUME_CONTINUE_TEXT }] }];
}

export class InvestigatorDO extends DurableObject<Env> {
  /** Injected LLM factory (Task 4.2 requirement: the DO must accept an injected factory for
   * tests). Defaults to the real Anthropic-backed client (Task 4.3 wires this live); tests
   * substitute `() => scriptedLLM([...])` via direct instance access (`runInDurableObject`). */
  llmFactory: (env: Env) => LLM = realLLM;

  /** TEST-ONLY wall-clock override, mirroring `SimulatorDO`'s own seam. Always `null` in
   * production. */
  private testNowMs: number | null = null;

  /** In-memory (NOT durable) guard against a redundant keepalive firing while a loop is already
   * progressing in THIS instance — always `false` on a freshly constructed instance (i.e. after a
   * real isolate eviction), which is exactly the signal `alarm()` needs: `true` means "the loop is
   * demonstrably still alive right here, no resume needed"; `false` + an `active` incident means
   * either a genuine crash or a plain "nothing running yet" state. */
  private loopRunning = false;

  setTestNow(ms: number | null): void {
    this.testNowMs = ms;
  }

  private now(): number {
    return this.testNowMs ?? Date.now();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "GET /status":
        return this.handleStatus();
      case "POST /start":
        return this.handleStart(request);
      case "POST /abort":
        return this.handleAbort(request);
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    // Re-armed FIRST, unconditionally, before any other await (spec §9 / Task 1.4 pattern): a
    // pending alarm must exist across every subsequent await in this method, or an eviction right
    // here orphans the loop with no way back.
    await this.armAlarm(KEEPALIVE_MS);

    const incidentId = await this.ctx.storage.get<string>("active");
    if (incidentId === undefined) {
      // Idle quiesce (review FIX 2): nothing to keep alive, so remove the keepalive re-armed
      // above — otherwise a single completed investigation would leave this DO heartbeating
      // every 90s forever. Arm-then-delete (rather than check-then-arm) keeps the
      // alarm-before-await discipline intact for the active path.
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (this.loopRunning) return; // a healthy loop is already live in this instance -- redundant tick

    this.loopRunning = true;
    try {
      await this.driveInvestigation(incidentId);
    } catch (err) {
      // Never rethrow: DO alarms retry a throwing handler ~6 times then go silent forever -- a
      // crash-looping resume must not burn through those retries (spec §9).
      await this.failIncident(incidentId, `resume failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loopRunning = false;
    }
  }

  // --- HTTP handlers ---------------------------------------------------------------------------

  private async handleStatus(): Promise<Response> {
    const incidentId = await this.ctx.storage.get<string>("active");
    // `incidentId: undefined` is dropped by JSON.stringify, matching the brief's `incidentId?`.
    return jsonResponse({ active: incidentId !== undefined, incidentId }, 200);
  }

  private async handleStart(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_body" }, 400);
    }
    const rec = body as { incidentId?: unknown; statement?: unknown } | null;
    const incidentId = rec?.incidentId;
    const statement = rec?.statement;
    if (typeof incidentId !== "string" || incidentId.length === 0 || typeof statement !== "string" || statement.length === 0) {
      return jsonResponse({ error: "invalid_body" }, 400);
    }

    // Check-and-set the 1-concurrent invariant atomically -- without `blockConcurrencyWhile`, two
    // overlapping /start requests could both observe "no active investigation" before either
    // writes (the same race `SimulatorDO.handleFault`'s cooldown gate guards against).
    const gate = await this.ctx.blockConcurrencyWhile(async () => {
      const active = await this.ctx.storage.get<string>("active");
      if (active !== undefined) return { ok: false as const };

      const openedAtMs = this.now();
      const meta: InvestigationMeta = {
        statement,
        openedAtMs,
        runId: crypto.randomUUID(),
        nextStepNo: 1,
        iterations: 0,
        tokensIn: 0,
        tokensOut: 0,
        elapsedMs: 0,
      };
      // Any lingering `cancelled` flag is stale by definition here (no investigation is active,
      // so there is nothing left for it to cancel -- e.g. an aborted loop's isolate died before
      // its own cleanup could observe and consume the flag). Cleared so it can never bleed into
      // this new run (whose fresh runId wouldn't match it anyway -- belt and suspenders).
      await this.ctx.storage.delete("cancelled");
      await this.ctx.storage.put("active", incidentId);
      await this.ctx.storage.put(`conv:${incidentId}`, buildInitialMessages(statement));
      await this.ctx.storage.put(`meta:${incidentId}`, meta);
      return { ok: true as const };
    });
    if (!gate.ok) {
      return jsonResponse({ error: "investigation_active" }, 409);
    }

    // D1/alarm-scheduling awaits happen outside the input gate (DO input gates don't protect
    // across D1/fetch awaits anyway -- SimulatorDO's own `advanceReset` doc comment) -- safe here
    // since the storage writes above already established 1-concurrent exclusivity.
    await setStatus(this.env.DB, incidentId, "investigating");
    // Armed BEFORE the loop starts (spec §9): the loop itself only ever runs from `alarm()`, so
    // arming here is what makes it start at all, immediately satisfying "before" trivially.
    await this.armAlarm(0);

    return jsonResponse({ status: "investigating" }, 202);
  }

  private async handleAbort(request: Request): Promise<Response> {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // No body / invalid JSON -- fall back to the default reason below.
    }
    const rawReason = (body as { reason?: unknown } | null)?.reason;
    const reason = typeof rawReason === "string" && rawReason.length > 0 ? rawReason : "aborted";

    const incidentId = await this.ctx.storage.get<string>("active");
    if (incidentId !== undefined) {
      const meta = await this.ctx.storage.get<InvestigationMeta>(`meta:${incidentId}`);
      // Guarded the same way a normal terminal write is (see `finalizeFailed`): if the incident is
      // no longer 'investigating' (e.g. already force-failed by the watchdog), don't clobber it.
      await setStatusGuarded(this.env.DB, incidentId, "investigating", "failed", {
        ts: { field: "resolved_at", value: this.now() },
        reportPatch: { failure_reason: reason },
      });
      // Cooperative cancel (review FIX 1): a loop in flight in this instance can't be preempted,
      // but it CAN be told to stop -- `shouldAbort` (wired in `driveInvestigation`) reads this
      // flag at every iteration top and exits without a salvage call, so at most the one
      // in-flight model call + its tool executions land after this point. Only set while a loop
      // is actually running (this DO is a singleton, so `loopRunning` is authoritative);
      // otherwise the flag would just linger as stale state for `/start` to clean up.
      if (this.loopRunning && meta !== undefined) {
        await this.ctx.storage.put("cancelled", meta.runId);
      }
      await this.clearInvestigationState(incidentId, meta?.runId);
    }
    return jsonResponse({ status: "aborted" }, 202);
  }

  // --- Internals ---------------------------------------------------------------------------------

  private async armAlarm(delayMs: number): Promise<void> {
    // Anchored to the REAL wall clock, never `this.now()` -- alarm scheduling is a physical-timer
    // concern the runtime owns, independent of `testNowMs` (mirrors SimulatorDO.armAlarm exactly).
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /**
   * Drives one alarm-attempt of the investigation: rebuilds the `LoopConfig` from whatever's
   * persisted (a fresh `/start`'s just-written state, or a resume's leftover conv/meta), runs
   * `runLoop` to termination, and hands the result to `handleOutcome`. Never assumes this is the
   * FIRST attempt -- a fresh start and a resume are the exact same code path here, which is the
   * whole point (spec §9: the alarm handler "resumes from stored messages").
   */
  private async driveInvestigation(incidentId: string): Promise<void> {
    const db = this.env.DB;
    const storedMeta = await this.ctx.storage.get<InvestigationMeta>(`meta:${incidentId}`);
    const convRaw = await this.ctx.storage.get<MessageParam[]>(`conv:${incidentId}`);
    if (!storedMeta || !convRaw) {
      // Should not happen (both are written together at /start and never deleted before the
      // terminal clear) -- defensive: an active flag with no backing state can't be resumed.
      await this.failIncident(incidentId, "resume failed: missing persisted investigation state");
      return;
    }

    let meta = storedMeta;
    const runId = storedMeta.runId;
    const initialMessages = healConversationTail(convRaw);
    const system = buildInvestigatorSystemPrompt({ incidentId, statement: meta.statement, openedAtMs: meta.openedAtMs });
    const llm = this.llmFactory(this.env);
    const callStartMs = this.now();
    const priorElapsedMs = meta.elapsedMs;

    const caps: LoopCaps = {
      maxSteps: Math.max(0, MAX_STEPS - meta.iterations),
      maxWallMs: Math.max(0, MAX_WALL_MS - meta.elapsedMs),
      maxTokensIn: Math.max(0, MAX_TOKENS_IN - meta.tokensIn),
      maxTokensOut: Math.max(0, MAX_TOKENS_OUT - meta.tokensOut),
    };

    /** True once `/abort` has flagged THIS run (see `handleAbort`) -- the loop's `shouldAbort`
     * seam and the onStep persistence guard below both read it. Compared against `runId`, never
     * mere presence, so a stale flag from a dead earlier run can't cancel this one. */
    const isCancelled = async (): Promise<boolean> => (await this.ctx.storage.get<string>("cancelled")) === runId;

    const onStep = async (step: StepRecord, stepCtx: StepContext): Promise<void> => {
      // Once cancelled, storage writes are skipped: `/abort` already cleared conv/meta, and the
      // one in-flight iteration still completing must not resurrect them (its D1 step rows below
      // are still recorded -- they're real history, and bounded to this single iteration).
      const cancelled = await isCancelled();

      // (a) Raw conversation snapshot, verbatim (incl. signed thinking blocks) -- resume fidelity.
      // Shallow-copied: `runLoop` keeps mutating its OWN array by reference after this call
      // returns (see `loop.ts`'s `onStep` doc comment), so storage must hold a point-in-time copy.
      if (!cancelled) {
        await this.ctx.storage.put(`conv:${incidentId}`, [...stepCtx.messages]);
      }

      // (b) Human-readable row -- the UI-timeline projection.
      const dbStepNo = meta.nextStepNo;
      await insertInvestigationStep(db, {
        incidentId,
        stepNo: dbStepNo,
        kind: step.kind,
        contentJson: JSON.stringify(step.content),
        tsMs: step.ts_ms,
        tokensIn: step.tokens_in,
        tokensOut: step.tokens_out,
      });

      // Budgets consumed so far, cumulative across a possible resume boundary. The local `meta`
      // always advances (step numbering must stay correct through the cancelled tail too); only
      // the durable copy is withheld after a cancel.
      meta = {
        ...meta,
        nextStepNo: dbStepNo + 1,
        iterations: stepCtx.iterations,
        tokensIn: stepCtx.usage.in,
        tokensOut: stepCtx.usage.out,
        elapsedMs: priorElapsedMs + (this.now() - callStartMs),
      };
      if (!cancelled) {
        await this.ctx.storage.put(`meta:${incidentId}`, meta);
      }
    };

    const result = await runLoop(
      {
        llm,
        model: this.env.MODEL_ID,
        system,
        tools: TOOLS,
        executeTool: (name, input) => executeTool(name, input, { db, nowMs: this.now() }),
        caps,
        submitReportTool: SUBMIT_REPORT,
        onStep,
        checkUpdates: async () => {
          const updates = await undeliveredUpdates(db, incidentId);
          if (updates.length === 0) return null;
          await markDelivered(db, incidentId, updates.map((u) => u.fingerprint));
          return updates.map((u) => u.statement).join(" | ");
        },
        shouldAbort: isCancelled,
        nowFn: () => this.now(),
      },
      initialMessages,
    );

    await this.handleOutcome(incidentId, runId, result, meta.nextStepNo);
  }

  /**
   * Terminal handling for a completed (not crashed -- `runLoop` never throws) attempt: a `report`
   * outcome is validated, evidence-embedded, and written with the guarded status transition (spec
   * §9); anything else (`failed`, or the chat-only `text` outcome that should never occur here
   * since `submitReportTool` is always supplied) becomes a guarded `failed` write instead.
   *
   * A cancelled run (see `handleAbort`) short-circuits to cleanup only: `/abort` already wrote
   * the terminal `failed` status with ITS reason, so this run writes nothing further -- not even
   * a "discarded" note step (the abort's own bookkeeping is the record), and not even a report
   * that happened to complete in the raced in-flight call (abort means discard).
   */
  private async handleOutcome(incidentId: string, runId: string, result: LoopResult, nextStepNo: number): Promise<void> {
    if ((await this.ctx.storage.get<string>("cancelled")) === runId) {
      await this.ctx.storage.delete("cancelled");
      await this.clearInvestigationState(incidentId, runId);
      return;
    }

    if (result.outcome === "report") {
      let report;
      try {
        report = validateReport(result.report);
      } catch (err) {
        await this.finalizeFailed(incidentId, runId, nextStepNo, `report failed validation: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const embedded = await embedEvidence(this.env.DB, report);
      const applied = await setStatusGuarded(this.env.DB, incidentId, "investigating", "reported", {
        ts: { field: "reported_at", value: this.now() },
        reportPatch: embedded as unknown as Record<string, unknown>,
      });
      if (!applied) {
        // The watchdog (or a world reset) already moved this incident on while we were still
        // running -- do NOT overwrite whatever terminal state won (spec §9's guarded-write rule).
        await insertInvestigationStep(this.env.DB, {
          incidentId,
          stepNo: nextStepNo,
          kind: "note",
          contentJson: JSON.stringify({ text: "report discarded: incident no longer investigating" }),
          tsMs: this.now(),
          tokensIn: 0,
          tokensOut: 0,
        });
      }
      await this.clearInvestigationState(incidentId, runId);
      return;
    }

    const reason =
      result.outcome === "failed"
        ? extractFailureReason(result.steps)
        : "investigator loop ended without a report (unexpected outcome)";
    await this.finalizeFailed(incidentId, runId, nextStepNo, reason);
  }

  private async finalizeFailed(incidentId: string, runId: string, nextStepNo: number, reason: string): Promise<void> {
    const applied = await setStatusGuarded(this.env.DB, incidentId, "investigating", "failed", {
      ts: { field: "resolved_at", value: this.now() },
      reportPatch: { failure_reason: reason },
    });
    if (!applied) {
      await insertInvestigationStep(this.env.DB, {
        incidentId,
        stepNo: nextStepNo,
        kind: "note",
        contentJson: JSON.stringify({ text: "failure discarded: incident no longer investigating" }),
        tsMs: this.now(),
        tokensIn: 0,
        tokensOut: 0,
      });
    }
    await this.clearInvestigationState(incidentId, runId);
  }

  /** Best-effort terminal path for a `driveInvestigation`/resume failure that never even reached
   * `handleOutcome` (e.g. missing persisted state, or the alarm handler's catch). Swallows its own
   * D1 errors -- there is nothing further to safely do if even the failure write itself fails, and
   * `alarm()`'s caller must never see this throw (spec §9's "never rethrow"). No `runId` is in
   * hand on this path (the failure may have struck before meta was even readable), so the cleanup
   * runs unguarded -- acceptable: this path only fires for a hard resume failure, which cannot
   * coexist with a healthy newer run of the same incident id in any realistic interleaving. */
  private async failIncident(incidentId: string, reason: string): Promise<void> {
    try {
      await setStatusGuarded(this.env.DB, incidentId, "investigating", "failed", {
        ts: { field: "resolved_at", value: this.now() },
        reportPatch: { failure_reason: reason },
      });
    } catch (err) {
      console.error(`InvestigatorDO: failIncident itself failed for ${incidentId}`, err);
    }
    await this.clearInvestigationState(incidentId, undefined).catch((err: unknown) => {
      console.error(`InvestigatorDO: clearInvestigationState failed for ${incidentId}`, err);
    });
  }

  /**
   * Clears conv/meta/active (and, once nothing is active, the keepalive alarm -- review FIX 2)
   * for `incidentId` -- every terminal path funnels through this.
   *
   * `runId` is the ownership guard (review minor: the latent same-id clobber): when supplied and
   * the STORED meta carries a different runId, a newer investigation -- possibly for the very
   * same incident id -- owns this state now, and a zombie run's late cleanup must not touch any
   * of it. `active`'s delete is additionally guarded on still pointing at this incident, and the
   * alarm is only deleted together with `active` (deleting it while a newer investigation is
   * active would kill THAT run's keepalive).
   */
  private async clearInvestigationState(incidentId: string, runId: string | undefined): Promise<void> {
    if (runId !== undefined) {
      const stored = await this.ctx.storage.get<InvestigationMeta>(`meta:${incidentId}`);
      if (stored !== undefined && stored.runId !== runId) return;
    }
    await this.ctx.storage.delete(`conv:${incidentId}`);
    await this.ctx.storage.delete(`meta:${incidentId}`);
    const active = await this.ctx.storage.get<string>("active");
    if (active === incidentId) {
      await this.ctx.storage.delete("active");
      await this.ctx.storage.deleteAlarm();
    }
  }
}

/** Pulls a human-readable reason out of a `failed` `LoopResult`'s last `error` step, falling back
 * to a generic message if the loop somehow failed without recording one (shouldn't happen given
 * `runLoop`'s own contract, but `report_json.failure_reason` should never be empty). */
function extractFailureReason(steps: readonly StepRecord[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i] as StepRecord;
    if (step.kind === "error" && typeof step.content === "object" && step.content !== null && "message" in step.content) {
      const message = (step.content as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  return "investigation failed";
}
