import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => {
  return c.json({ ok: true, worldStatus: "unseeded" });
});

/** Stub — replaced with real tick/fault/backfill/reset logic in Task 1.4. */
export class SimulatorDO extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Implemented", { status: 501 });
  }
}

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
