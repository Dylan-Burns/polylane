/**
 * The public GET data-surface (spec §10): `/api/health` (moved here from `index.ts`, which now just
 * mounts this app), `/api/state`, `/api/incidents`, `/api/incidents/:id`, `/api/traces/:id`,
 * `/api/logs` — every GET endpoint the UI polls or drills into. POST routes (chaos, admin reset,
 * chat) stay in their own files (`api/chaos.ts`, future `api/chat.ts`) since they're a
 * fundamentally different shape (proxies / SSE, not a query layer passthrough); this file is
 * specifically the read side, mirroring `telemetry/read.ts`'s own "reads only" boundary at the
 * HTTP layer.
 *
 * Every handler here is a thin adapter, exactly like `agent/tools.ts`'s executors: parse/validate
 * query params, resolve the window via `parseWindow`, call the matching `telemetry/read.ts` /
 * `telemetry/state.ts` function, and return its result close to verbatim — caps, `truncated`/`total`
 * signals, and shape all live in the query layer, never re-implemented here.
 */

import { Hono } from "hono";
import { getBaselines } from "../detect/baselines";
import type { Env } from "../env";
import { simulatorStub } from "../sim/simulator-do";
import { getIncidents, getTrace, listInvestigationSteps, searchLogs, type StepView } from "../telemetry/read";
import { buildTopology, getOpsHealth, serviceHealth, sparklineSeries, type StateResponse, type WorldStatusView } from "../telemetry/state";
import type { IncidentView } from "../telemetry/types";
import { parseWindow, WindowError } from "../agent/window";

const LOG_LEVELS = ["info", "warn", "error"] as const;

/** `GET /api/incidents`' default lookback when no `from` is supplied — incidents are the UI's
 * durable history panel (spec §6: kept indefinitely, surviving resets), so its default window is
 * a day, not `parseWindow`'s generic 30-minute telemetry default. */
const INCIDENTS_DEFAULT_FROM = "-24h";

/** `GET /api/incidents/:id`'s response shape (spec §10: "incident + steps") — exported alongside
 * `StateResponse` so Task 5.2's UI (which polls this at 2s during an investigation) types against
 * the same definition this handler builds. `steps` is ordered by `step_no` ascending — see
 * `read.ts`'s `listInvestigationSteps`. */
export interface IncidentDetailResponse {
  incident: IncidentView;
  steps: StepView[];
}

/** Fetches `SimulatorDO`'s `/status` for the singleton `idFromName('world')` instance and returns
 * its body verbatim (`WorldStatusView`) — `null` on any failure (network error, non-2xx, malformed
 * JSON) so `GET /api/state` can fall back rather than 500ing the whole response over a DO hiccup. */
async function fetchWorldStatus(env: Env): Promise<WorldStatusView | null> {
  try {
    const res = await simulatorStub(env).fetch("http://simulator/status");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The one honest default for `GET /api/state` when `SimulatorDO` itself is unreachable — matches
 * `index.ts`'s pre-existing `/api/health` fallback ("unseeded") rather than inventing a new
 * failure-mode string, since both are "we couldn't learn the real world status" moments. */
const FALLBACK_WORLD_STATUS: WorldStatusView = { worldStatus: "unseeded", fault: null, generation: 0 };

export const routes = new Hono<{ Bindings: Env }>();

routes.get("/health", async (c) => {
  const status = await fetchWorldStatus(c.env);
  return c.json({ ok: true, worldStatus: status?.worldStatus ?? "unseeded" });
});

routes.get("/state", async (c) => {
  const nowMs = Date.now();

  const [baselines, world] = await Promise.all([getBaselines(c.env.DB), fetchWorldStatus(c.env)]);
  const [health, sparklines, opsHealth] = await Promise.all([
    serviceHealth(c.env.DB, baselines, nowMs),
    sparklineSeries(c.env.DB, nowMs),
    getOpsHealth(c.env.DB, nowMs),
  ]);

  const body: StateResponse = {
    topology: buildTopology(),
    health,
    sparklines,
    worldStatus: world ?? FALLBACK_WORLD_STATUS,
    opsHealth,
  };
  return c.json(body);
});

routes.get("/incidents", async (c) => {
  const nowMs = Date.now();
  try {
    const { fromMs, toMs } = parseWindow(
      { from: c.req.query("from") ?? INCIDENTS_DEFAULT_FROM, to: c.req.query("to") },
      nowMs,
    );
    // getIncidents' window branch is already newest-first (spec §10: "recent first") and carries
    // the {incidents, total} envelope with its 20-row cap -- passed through verbatim.
    const result = await getIncidents(c.env.DB, { fromMs, toMs });
    return c.json(result);
  } catch (err) {
    if (err instanceof WindowError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

routes.get("/incidents/:id", async (c) => {
  const id = c.req.param("id");
  const { incidents } = await getIncidents(c.env.DB, { id });
  const incident = incidents[0];
  if (incident === undefined) {
    return c.json({ error: "not_found" }, 404);
  }
  const steps = await listInvestigationSteps(c.env.DB, id);
  const body: IncidentDetailResponse = { incident, steps };
  return c.json(body);
});

routes.get("/traces/:id", async (c) => {
  const traceId = c.req.param("id");
  const trace = await getTrace(c.env.DB, traceId);
  // `getTrace` returns an empty, non-truncated view for an unknown trace_id (see read.ts) -- that's
  // the "no such trace" signal this route turns into a 404, distinct from a real (possibly
  // truncated) trace that simply has spans.
  if (trace.spans.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(trace);
});

routes.get("/logs", async (c) => {
  const nowMs = Date.now();
  const service = c.req.query("service");
  const levelRaw = c.req.query("level");
  if (levelRaw !== undefined && !(LOG_LEVELS as readonly string[]).includes(levelRaw)) {
    return c.json({ error: "invalid_level", allowed: LOG_LEVELS }, 400);
  }
  const level = levelRaw as (typeof LOG_LEVELS)[number] | undefined;
  const contains = c.req.query("contains");
  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;

  try {
    const { fromMs, toMs } = parseWindow({ from: c.req.query("from"), to: c.req.query("to") }, nowMs);
    const result = await searchLogs(c.env.DB, { service, level, contains, fromMs, toMs, limit });
    return c.json(result);
  } catch (err) {
    if (err instanceof WindowError) return c.json({ error: err.message }, 400);
    throw err;
  }
});
