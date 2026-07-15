import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import type { Env } from "./env";
import { SimulatorDO } from "./sim/simulator-do";

const app = new Hono<{ Bindings: Env }>();

/** Fetches SimulatorDO's `/status` for the singleton `idFromName('world')` instance. Returns
 * `null` on any failure so callers can fall back rather than 500ing the whole request. */
async function fetchWorldStatus(env: Env): Promise<{ worldStatus: string } | null> {
  try {
    const stub = env.SIMULATOR.get(env.SIMULATOR.idFromName("world"));
    const res = await stub.fetch("http://simulator/status");
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

/** Temporary direct route to the DO (task brief, Task 1.4 step 3) — superseded by a hardened
 * admin surface later; forwards straight to SimulatorDO's `/reset` and relays its response. */
app.post("/api/admin/reset", async (c) => {
  const stub = c.env.SIMULATOR.get(c.env.SIMULATOR.idFromName("world"));
  const res = await stub.fetch("http://simulator/reset", { method: "POST" });
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "content-type": "application/json" } });
});

export { SimulatorDO };

/** Stub — replaced with the real investigation agent loop in Task 4.2. */
export class InvestigatorDO extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Implemented", { status: 501 });
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    console.log("scheduled trigger fired (no-op)");
  },
} satisfies ExportedHandler<Env>;
