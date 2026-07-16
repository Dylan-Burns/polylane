import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FaultState } from "../../src/sim/scenarios";

/** The remediation route talks to the single `idFromName('world')` SimulatorDO instance — the same
 * singleton the chaos routes proxy to and every other test file shares. Reset its fault/cooldown
 * state directly before each test (mirroring `chaos.test.ts`) so the "no fault active" 409 and the
 * chaos-then-restore happy path don't depend on run order or leftover state — clearing
 * `lastChaosAtMs` in particular so this file's own chaos POSTs never trip the 30s cooldown between
 * tests. */
async function resetWorldState(worldStatus: "running" | "unseeded" = "running"): Promise<void> {
  const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("worldStatus", worldStatus);
    await state.storage.put("generation", 1);
    await state.storage.delete("fault");
    await state.storage.delete("lastChaosAtMs");
    await state.storage.delete("lastResetAtMs");
    await state.storage.deleteAlarm();
  });
}

/** Seeds one `incidents` row directly (the route reads it back through `getIncidents`) — status
 * and `report_json` are the two knobs the endpoint's precondition gate branches on. */
/** `opened_at` defaults to seed time: the relevance gate requires the active fault to have
 * started BEFORE the incident opened (a fault that postdates the incident can't be its cause),
 * so tests that trigger chaos first and seed second model the real detection-lag ordering. */
async function seedIncident(id: string, status: string, reportJson: string | null, openedAt: number = Date.now()): Promise<void> {
  await env.DB
    .prepare(
      "INSERT INTO incidents (id, status, severity, opened_at, trigger_json, report_json) VALUES (?, ?, 'warning', ?, '{}', ?)",
    )
    .bind(id, status, openedAt, reportJson)
    .run();
}

/** A report body shaped like a real submitted report's remediation-relevant slice. */
const REPORT_JSON = JSON.stringify({
  root_cause: "payments v2.4.1 deploy",
  suggested_action: "roll back payments to v2.4.0",
});

afterEach(async () => {
  for (const table of ["incident_fingerprints", "investigation_steps", "incidents", "meta", "spans", "logs", "rollups", "deploys"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("POST /api/incidents/:id/remediate", () => {
  beforeEach(async () => resetWorldState());

  it("404s an unknown incident id", async () => {
    const res = await SELF.fetch("https://example.com/api/incidents/inc-nope/remediate", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("409s a reported incident when no fault is active in the world -- nothing to roll back", async () => {
    await seedIncident("inc-reported", "reported", REPORT_JSON);

    const res = await SELF.fetch("https://example.com/api/incidents/inc-reported/remediate", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "nothing to roll back — no fault is active in the world" });
  });

  it("409s an open incident whose investigation hasn't produced a report yet", async () => {
    await seedIncident("inc-open", "open", null);

    const res = await SELF.fetch("https://example.com/api/incidents/inc-open/remediate", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "the investigation hasn't produced a report yet" });
  });

  it("409s a resolved incident -- already closed, nothing to remediate", async () => {
    await seedIncident("inc-resolved", "resolved", REPORT_JSON);

    const res = await SELF.fetch("https://example.com/api/incidents/inc-resolved/remediate", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "incident is already closed — nothing to remediate" });
  });

  it("happy path: restores the active fault and appends a visible remediation note to the timeline", async () => {
    // Arm a real fault via the chaos route (the same DO state the remediation gate re-checks).
    const chaos = await SELF.fetch("https://example.com/api/chaos/bad-deploy", { method: "POST" });
    expect(chaos.status).toBe(200);

    await seedIncident("inc-happy", "reported", REPORT_JSON);

    const res = await SELF.fetch("https://example.com/api/incidents/inc-happy/remediate", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The fault is actually cleared in DO storage -- the rollback really executed.
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    const fault = await runInDurableObject(stub, async (_instance, state) => {
      return (await state.storage.get<FaultState>("fault")) ?? null;
    });
    expect(fault).toBeNull();

    // Exactly one 'note' step landed on the incident's timeline, numbered from 1 (no prior steps),
    // carrying the operator-approval message with the report's own suggested_action embedded.
    const steps = await env.DB
      .prepare("SELECT step_no, kind, content_json FROM investigation_steps WHERE incident_id = ? ORDER BY step_no")
      .bind("inc-happy")
      .all<{ step_no: number; kind: string; content_json: string }>();
    expect(steps.results).toHaveLength(1);
    const step = steps.results?.[0];
    expect(step?.kind).toBe("note");
    expect(step?.step_no).toBe(1);
    expect(step?.content_json).toContain("Remediation approved by operator");
    expect(step?.content_json).toContain("roll back payments to v2.4.0");
  });

  it("409s a stale approval: the active fault started AFTER this incident opened, so it isn't this report's fault", async () => {
    // Reverse of the happy path's ordering: the incident predates the fault. A real operator hits
    // this by leaving an old reported incident's modal open while someone injects a NEW fault --
    // approving must not roll back the unrelated newer fault (relevance gate).
    await seedIncident("inc-stale", "reported", REPORT_JSON, Date.now() - 60_000);

    const chaos = await SELF.fetch("https://example.com/api/chaos/bad-deploy", { method: "POST" });
    expect(chaos.status).toBe(200);

    const res = await SELF.fetch("https://example.com/api/incidents/inc-stale/remediate", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "the active fault started after this incident opened — it isn't the fault this report concerns",
    });

    // The newer fault survived -- the stale approval touched nothing.
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    const fault = await runInDurableObject(stub, async (_instance, state) => {
      return (await state.storage.get<FaultState>("fault")) ?? null;
    });
    expect(fault).not.toBeNull();
  });

  it("409s a second remediate call after success -- the fault is already cleared", async () => {
    const chaos = await SELF.fetch("https://example.com/api/chaos/bad-deploy", { method: "POST" });
    expect(chaos.status).toBe(200);

    await seedIncident("inc-twice", "reported", REPORT_JSON);

    const first = await SELF.fetch("https://example.com/api/incidents/inc-twice/remediate", { method: "POST" });
    expect(first.status).toBe(200);

    const second = await SELF.fetch("https://example.com/api/incidents/inc-twice/remediate", { method: "POST" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "nothing to roll back — no fault is active in the world" });
  });
});
