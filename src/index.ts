import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { runSweep } from "./detect/sweep";
import type { Env } from "./env";
import { chaosRoutes, handleAdminReset } from "./api/chaos";
import { simulatorStub, SimulatorDO } from "./sim/simulator-do";

const app = new Hono<{ Bindings: Env }>();

/** Fetches SimulatorDO's `/status` for the singleton `idFromName('world')` instance. Returns
 * `null` on any failure so callers can fall back rather than 500ing the whole request. */
async function fetchWorldStatus(env: Env): Promise<{ worldStatus: string } | null> {
  try {
    const res = await simulatorStub(env).fetch("http://simulator/status");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

app.get("/api/health", async (c) => {
  const status = await fetchWorldStatus(c.env);
  return c.json({ ok: true, worldStatus: status?.worldStatus ?? "unseeded" });
});

// Chaos panel (spec §6) + admin reset (Task 3.3): thin proxies to SimulatorDO, plus the
// reset-time incident-abort carry-forward from Task 1.4 — see src/api/chaos.ts's doc comment.
app.route("/api/chaos", chaosRoutes);
app.post("/api/admin/reset", handleAdminReset);

export { SimulatorDO };

/** Stub — replaced with the real investigation agent loop in Task 4.2. */
export class InvestigatorDO extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Implemented", { status: 501 });
  }
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await runSweep(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
