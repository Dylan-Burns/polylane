/**
 * Chaos panel routes (spec §6's fault-scenario table): thin proxies from the public HTTP surface to
 * SimulatorDO, which owns all the real state (fault, cooldown, reset sequencing — see
 * `sim/simulator-do.ts`). Every route here passes the DO's response status and JSON body straight
 * through (`200`/`409 scenario_active`/`429 cooldown`/`202 resetting`) rather than reinterpreting
 * it — the DO is the single source of truth for what happened.
 *
 * `POST /api/admin/reset` gets one piece of behavior beyond a bare proxy: once SimulatorDO's
 * `/reset` actually ACCEPTS the reset (`202` — as opposed to `429 cooldown`/`429` in-progress,
 * where nothing happens at all), it marks any `open`/`investigating` incident `failed`
 * (`failure_reason: "world reset"`). Gated on the real 202 response, not called unconditionally
 * before proxying — a rejected reset must not destroy live incidents for a wipe that never
 * happened. This is the Task 1.4 carry-forward (`SimulatorDO.abortActiveInvestigation`'s TODO):
 * `SimulatorDO` itself can't reach into `incidents` (spec §6: fault state lives in SimulatorDO
 * storage only, telemetry writes live in D1 — the DO never mixes the two), so the abort has to
 * happen here, at the one call site that already knows a reset is genuinely underway. Task 4.2
 * closes the loop: once a reset is confirmed underway, this also calls `InvestigatorDO`'s
 * `/abort` — not just for the in-flight model loop to stop promptly instead of burning its budget
 * against a wiped world, but because the DO's OWN 1-concurrent invariant (`active` in DO storage)
 * has no other way to learn the incident it's tracking just got force-failed here; without this
 * call, `active` would stay wedged on that incident id forever, 409ing every future `/start`.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "../env";
import { simulatorStub } from "../sim/simulator-do";
import { SCENARIOS, type ScenarioId } from "../sim/scenarios";
import { healthClearStatement } from "../telemetry/incidents";
import { investigatorStub } from "../agent/investigator-do";

const VALID_SCENARIOS: ReadonlySet<string> = new Set(Object.keys(SCENARIOS));

type AppContext = Context<{ Bindings: Env }>;

/** Relays a SimulatorDO response verbatim: same status code, same JSON body text. */
async function relay(res: Response): Promise<Response> {
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "content-type": "application/json" } });
}

async function proxyToSimulator(c: AppContext, path: string, init?: RequestInit): Promise<Response> {
  const res = await simulatorStub(c.env).fetch(`http://simulator${path}`, init);
  return relay(res);
}

export const chaosRoutes = new Hono<{ Bindings: Env }>();

// Registered before the `/:scenario` wildcard so "restore" is never mistaken for a scenario id
// (Hono's router prioritizes static routes over parameterized ones regardless of registration
// order, but the explicit ordering documents the intent either way).
chaosRoutes.post("/restore", async (c) => proxyToSimulator(c, "/restore", { method: "POST" }));

chaosRoutes.post("/:scenario", async (c) => {
  const scenario = c.req.param("scenario");
  if (!VALID_SCENARIOS.has(scenario)) {
    return c.json({ error: "unknown_scenario" }, 404);
  }
  return proxyToSimulator(c, "/fault", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: scenario as ScenarioId }),
  });
});

/** Marks every currently `open`/`investigating` incident `failed` and clears each one's
 * `incident_health:*` meta rows (matching `autoResolve`/`forceFailStuck`'s terminal-transition
 * cleanup, so health bookkeeping never survives a reset-time fail either) — all in one `db.batch`
 * (transactional: the flips and their cleanup land together or not at all), once a reset is
 * confirmed underway and about to wipe the telemetry those incidents reference. `reported`
 * incidents are untouched — they survive a reset, and their health rows must stay so
 * `autoResolve` can still resolve them. */
async function failActiveIncidents(db: D1Database, nowMs: number): Promise<void> {
  const { results } = await db
    .prepare(`SELECT id FROM incidents WHERE status IN ('open', 'investigating')`)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => r.id);
  if (ids.length === 0) return;

  const placeholders = ids.map(() => "?").join(", ");
  await db.batch([
    db
      .prepare(`UPDATE incidents SET status = 'failed', resolved_at = ?, report_json = ? WHERE id IN (${placeholders})`)
      .bind(nowMs, JSON.stringify({ failure_reason: "world reset" }), ...ids),
    ...ids.map((id) => healthClearStatement(db, id)),
  ]);
}

/** Best-effort `InvestigatorDO` `/abort` call, gated the same way `failActiveIncidents` is (only
 * once a reset is confirmed underway). A failure here is logged and does NOT block the response --
 * the D1-side `failActiveIncidents` write is what actually protects the incident data; this call
 * is what keeps the DO's own `active` flag from wedging, not something the reset's success depends
 * on. */
async function abortActiveInvestigation(env: Env): Promise<void> {
  try {
    await investigatorStub(env).fetch("http://investigator/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "world reset" }),
    });
  } catch (err) {
    console.error("chaos: failed to abort the active investigation after reset", err);
  }
}

export async function handleAdminReset(c: AppContext): Promise<Response> {
  const res = await simulatorStub(c.env).fetch("http://simulator/reset", { method: "POST" });

  if (res.status === 202) {
    // Only when the reset was genuinely accepted (not 429 cooldown/in-progress, where nothing
    // happened) -- best-effort: a failure here is logged and does NOT block the response, since
    // the reset itself has already succeeded regardless of whether this bookkeeping lands.
    try {
      await failActiveIncidents(c.env.DB, Date.now());
    } catch (err) {
      console.error("chaos: failed to mark active incidents failed after reset", err);
    }
    await abortActiveInvestigation(c.env);
  }

  return relay(res);
}
