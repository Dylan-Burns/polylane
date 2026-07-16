/**
 * Remediation approval endpoint (`POST /api/incidents/:id/remediate`) — the operator-approved
 * rollback that closes the story loop the report opens: the agent's report carries a
 * `suggested_action` (spec §9), the UI renders it with an "approve" button, and THIS route is what
 * that click hits. The agent itself only ever SUGGESTS — it has no tool that mutates the world
 * (spec §6: the loop's tools are all reads over telemetry) — so a human approval gate sits between
 * suggestion and execution by construction, and this endpoint IS that gate: it re-checks the
 * incident's state at click time (not report time) and refuses when there's nothing left to fix.
 *
 * "Roll back" in this simulated world means SimulatorDO's `POST /restore` — the exact call
 * `api/chaos.ts`'s Restore button proxies. Every fault scenario is an injected generator effect
 * (`sim/scenarios.ts`), so restoring the world to its no-fault baseline is precisely what "roll
 * back the offending change" would mean in the real system the simulation stands in for (revert
 * the bad deploy, lift the outage). The DO's response is relayed verbatim on failure, matching
 * `api/chaos.ts`'s proxy convention: the DO is the single source of truth for what happened, and
 * this layer never reinterprets its status codes.
 *
 * On success the approval is recorded as a `note` step via `insertInvestigationStep` — the same
 * `investigation_steps` timeline the loop itself writes (`InvestigatorDO`'s UI projection) and the
 * incident detail view already polls/renders (`GET /api/incidents/:id`'s `steps`). Appending there,
 * rather than inventing a separate audit table, makes the human approval show up inline in the
 * investigation's own story: tool calls, report, then "remediation approved by operator".
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { fetchWorldStatus as fetchWorldStatusFromDO, simulatorStub } from "../sim/simulator-do";
import { appendInvestigationStep } from "../telemetry/incidents";
import { getIncidents } from "../telemetry/read";
import type { WorldStatusView } from "../telemetry/state";

/** `simulator-do.ts`'s shared status fetch, pinned to this module's view type. Here `null` folds
 * into the "no fault active" 409 below: if we can't PROVE a fault is active, we refuse to fire a
 * world-mutating restore on a guess (fail closed, unlike `/api/state`'s render-something fallback). */
const fetchWorldStatus = (env: Env) => fetchWorldStatusFromDO<WorldStatusView>(env);

/** Reads `suggested_action` defensively out of the report (`IncidentView.report` is `unknown` by
 * contract — the agent authored it, and `validateReport` guarantees shape at submit time but this
 * endpoint must survive hand-seeded or legacy rows too): any non-string falls back to a generic
 * phrasing rather than 500ing the approval or embedding `undefined` in the timeline note. */
function readSuggestedAction(report: unknown): string {
  const value = (report as { suggested_action?: unknown } | null)?.suggested_action;
  return typeof value === "string" ? value : "roll back the offending change";
}

export const remediationRoutes = new Hono<{ Bindings: Env }>();

remediationRoutes.post("/:id/remediate", async (c) => {
  const id = c.req.param("id");
  const { incidents } = await getIncidents(c.env.DB, { id });
  const incident = incidents[0];
  if (incident === undefined) {
    return c.json({ error: "not_found" }, 404);
  }

  // The gate's precondition checks, most-specific first: a closed incident can never be remediated
  // regardless of what its report says; an un-reported one has no suggestion to approve yet.
  if (incident.status === "resolved" || incident.status === "failed") {
    return c.json({ error: "incident is already closed — nothing to remediate" }, 409);
  }
  if (incident.report === null) {
    return c.json({ error: "the investigation hasn't produced a report yet" }, 409);
  }

  // Re-checked at click time, not report time: the operator may approve long after the fault was
  // already restored (or the world reset). A `null` status fetch fails closed — see fetchWorldStatus.
  const world = await fetchWorldStatus(c.env);
  if (world === null || world.fault === null) {
    return c.json({ error: "nothing to roll back — no fault is active in the world" }, 409);
  }
  // Relevance gate (adversarial-review finding): "a fault is active" isn't enough — a stale
  // approval on an old incident must not roll back a DIFFERENT, newer fault someone else just
  // injected. The fault this report can legitimately concern necessarily STARTED before the
  // incident opened (detection lags injection); one that started after cannot be this incident's
  // cause, so approving against it is refused rather than silently killing the wrong fault.
  if (world.fault.startedMs > incident.opened_at) {
    return c.json({ error: "the active fault started after this incident opened — it isn't the fault this report concerns" }, 409);
  }

  const res = await simulatorStub(c.env).fetch("http://simulator/restore", { method: "POST" });
  if (!res.ok) {
    // api/chaos.ts's relay convention: same status, same JSON body text, no reinterpretation --
    // the DO is the single source of truth for why the restore didn't happen.
    const body = await res.text();
    return new Response(body, { status: res.status, headers: { "content-type": "application/json" } });
  }

  // The restore actually happened -- record the approval on the incident's own timeline.
  // appendInvestigationStep computes MAX(step_no)+1 inside one atomic INSERT, so two concurrent
  // approvals (two tabs, two operators) can't read the same MAX and silently lose the audit note
  // the way a separate SELECT + INSERT OR IGNORE pair would.
  const suggestedAction = readSuggestedAction(incident.report);
  const message = `Remediation approved by operator: ${suggestedAction} — executed by restoring the injected fault (rollback).`;
  await appendInvestigationStep(c.env.DB, {
    incidentId: id,
    kind: "note",
    // `{note: ...}` is the shape both step renderers read (`normalize.ts`'s `normalizeNote` and
    // `chat-prompt.ts`'s `compactStepContent`); `kind` rides along for programmatic consumers.
    contentJson: JSON.stringify({ kind: "remediation", note: message }),
    tsMs: Date.now(),
    tokensIn: 0,
    tokensOut: 0,
  });

  return c.json({ ok: true });
});
