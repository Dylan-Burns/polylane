import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** The chaos routes are thin proxies to the single `idFromName('world')` SimulatorDO instance —
 * the same singleton every other test file (`smoke.test.ts`, `simulator.test.ts` via its own
 * differently-named instances) and production share. Reset its fault/cooldown state directly
 * before each test so scenario/cooldown assertions don't depend on run order or on whatever a
 * previous test left behind. */
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

afterEach(async () => {
  for (const table of ["incident_fingerprints", "investigation_steps", "incidents", "meta", "spans", "logs", "rollups", "deploys"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("POST /api/chaos/:scenario", () => {
  beforeEach(async () => resetWorldState());

  it("activates a known scenario and relays SimulatorDO's 200 fault-state body", async () => {
    const res = await SELF.fetch("https://example.com/api/chaos/bad-deploy", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fault: { scenario: string; startedMs: number } };
    expect(body.fault.scenario).toBe("bad-deploy");
  });

  it("404s an unknown scenario id without ever calling SimulatorDO", async () => {
    const res = await SELF.fetch("https://example.com/api/chaos/not-a-real-scenario", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_scenario" });

    // No fault was set on the DO -- proof the validation short-circuited before any proxy call.
    const status = await (await SELF.fetch("https://example.com/api/health")).json();
    expect(status).toMatchObject({ worldStatus: "running" });
  });

  it("relays SimulatorDO's 409 scenario_active when a scenario is already running", async () => {
    const first = await SELF.fetch("https://example.com/api/chaos/bad-deploy", { method: "POST" });
    expect(first.status).toBe(200);

    const second = await SELF.fetch("https://example.com/api/chaos/traffic-spike", { method: "POST" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "scenario_active" });
  });
});

describe("POST /api/chaos/restore", () => {
  beforeEach(async () => resetWorldState());

  it("is never mistaken for a scenario id, and clears an active fault", async () => {
    await SELF.fetch("https://example.com/api/chaos/bad-deploy", { method: "POST" });

    const res = await SELF.fetch("https://example.com/api/chaos/restore", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fault: null });
  });
});

describe("POST /api/admin/reset", () => {
  beforeEach(async () => resetWorldState());

  it("fails open/investigating incidents with failure_reason 'world reset' and clears their health rows, leaving resolved/reported ones untouched", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES ('inc-open', 'open', 'warning', 1000, '{}')",
      ),
      env.DB.prepare(
        "INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES ('inc-investigating', 'investigating', 'critical', 1000, '{}')",
      ),
      env.DB.prepare(
        "INSERT INTO incidents (id, status, severity, opened_at, resolved_at, trigger_json) VALUES ('inc-resolved', 'resolved', 'warning', 1000, 2000, '{}')",
      ),
      env.DB.prepare(
        "INSERT INTO incidents (id, status, severity, opened_at, reported_at, trigger_json) VALUES ('inc-reported', 'reported', 'warning', 1000, 2000, '{}')",
      ),
      // Health rows for the two soon-to-fail incidents plus one for the reported incident, which
      // must SURVIVE the reset (autoResolve still needs it to resolve the reported incident later).
      env.DB.prepare("INSERT INTO meta (key, value) VALUES ('incident_health:inc-open:payments:errors', '1000')"),
      env.DB.prepare("INSERT INTO meta (key, value) VALUES ('incident_health:inc-investigating:checkout:errors', '1000')"),
      env.DB.prepare("INSERT INTO meta (key, value) VALUES ('incident_health:inc-reported:catalog:traffic', '1000')"),
    ]);

    const res = await SELF.fetch("https://example.com/api/admin/reset", { method: "POST" });
    expect(res.status).toBe(202); // proxied straight from SimulatorDO's /reset

    const rows = await env.DB
      .prepare("SELECT id, status, report_json FROM incidents ORDER BY id")
      .all<{ id: string; status: string; report_json: string | null }>();
    const byId = new Map((rows.results ?? []).map((r) => [r.id, r]));

    expect(byId.get("inc-open")?.status).toBe("failed");
    expect(JSON.parse(byId.get("inc-open")?.report_json ?? "{}")).toEqual({ failure_reason: "world reset" });

    expect(byId.get("inc-investigating")?.status).toBe("failed");
    expect(JSON.parse(byId.get("inc-investigating")?.report_json ?? "{}")).toEqual({ failure_reason: "world reset" });

    expect(byId.get("inc-resolved")?.status).toBe("resolved"); // untouched
    expect(byId.get("inc-resolved")?.report_json).toBeNull();

    expect(byId.get("inc-reported")?.status).toBe("reported"); // untouched -- survives a reset

    // The failed incidents' health rows are gone (the terminal-transition cleanup, review FIX 3);
    // the reported incident's row remains.
    const healthRows = await env.DB
      .prepare("SELECT key FROM meta WHERE key LIKE 'incident_health:%' ORDER BY key")
      .all<{ key: string }>();
    expect((healthRows.results ?? []).map((r) => r.key)).toEqual(["incident_health:inc-reported:catalog:traffic"]);
  });

  it("still proxies the reset even with no active incidents at all", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/reset", { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("does NOT fail active incidents when SimulatorDO rejects the reset (429 cooldown) -- the wipe never happened", async () => {
    // Simulate an in-progress reset cooldown: worldStatus 'resetting' with a pending alarm (a
    // genuinely in-progress, non-wedged reset), which handleReset rejects with 429.
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("worldStatus", "resetting");
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await env.DB.prepare(
      "INSERT INTO incidents (id, status, severity, opened_at, trigger_json) VALUES ('inc-live', 'open', 'warning', 1000, '{}')",
    ).run();

    const res = await SELF.fetch("https://example.com/api/admin/reset", { method: "POST" });
    expect(res.status).toBe(429);

    const row = await env.DB.prepare("SELECT status FROM incidents WHERE id = ?").bind("inc-live").first<{ status: string }>();
    expect(row?.status).toBe("open"); // untouched -- the reset never actually happened
  });
});
