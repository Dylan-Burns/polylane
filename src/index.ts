import { Hono } from "hono";
import { runSweep } from "./detect/sweep";
import type { Env } from "./env";
import { chaosRoutes, handleAdminReset } from "./api/chaos";
import { chatRoutes } from "./api/chat";
import { routes } from "./api/routes";
import { SimulatorDO } from "./sim/simulator-do";
import { InvestigatorDO } from "./agent/investigator-do";

const app = new Hono<{ Bindings: Env }>();

// The GET data surface (health, state, traces, logs — spec §10): consolidated in api/routes.ts,
// mounted at /api here.
app.route("/api", routes);

// Chaos panel (spec §6) + admin reset (Task 3.3): thin proxies to SimulatorDO, plus the
// reset-time incident-abort carry-forward from Task 1.4 — see src/api/chaos.ts's doc comment.
app.route("/api/chaos", chaosRoutes);
app.post("/api/admin/reset", handleAdminReset);

// Hardened streaming chat (Task 6.1) — POST /api/chat, SSE. See src/api/chat.ts's doc comment.
app.route("/api/chat", chatRoutes);

export { SimulatorDO };
export { InvestigatorDO };

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await runSweep(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
