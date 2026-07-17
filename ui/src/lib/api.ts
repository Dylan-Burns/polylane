/**
 * Thin, typed fetch wrappers over the GET/POST surface `src/api/routes.ts` and `src/api/chaos.ts`
 * expose (spec §10). No react-query — see `poll.ts` for the polling hook these feed. Every GET
 * helper throws `ApiError` on a non-2xx response (404 "not found" is a real, expected outcome for
 * `getTrace`, handled by callers via `err instanceof ApiError && err.status === 404`, not treated
 * as a network failure). The two POST chaos helpers deliberately do NOT throw on 409/scenario_active
 * or 429/cooldown — those are ordinary, UI-surfaced outcomes (an inline toast, per the task brief:
 * "409/429 responses surfaced as inline toasts, not alerts"), not exceptional failures — so they
 * return a discriminated result instead.
 */

import { readSSEStream } from "./sse";
import type {
  AnalyticsResponse,
  ChaosErrorBody,
  ChaosFaultBody,
  ChatSSEEvent,
  DeployListResponse,
  FaultState,
  IncidentDetailResponse,
  IncidentListResponse,
  IncidentLogsResponse,
  IncidentMetricsResponse,
  ScenarioId,
  StateResponse,
  TraceView,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = await parseBody(res);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export function getState(): Promise<StateResponse> {
  return getJson<StateResponse>("/api/state");
}

export function getIncidents(): Promise<IncidentListResponse> {
  return getJson<IncidentListResponse>("/api/incidents");
}

export function getIncidentDetail(id: string): Promise<IncidentDetailResponse> {
  return getJson<IncidentDetailResponse>(`/api/incidents/${encodeURIComponent(id)}`);
}

export function getTrace(traceId: string): Promise<TraceView> {
  return getJson<TraceView>(`/api/traces/${encodeURIComponent(traceId)}`);
}

export function getAnalytics(): Promise<AnalyticsResponse> {
  return getJson<AnalyticsResponse>("/api/analytics");
}

export function getDeploys(): Promise<DeployListResponse> {
  return getJson<DeployListResponse>("/api/deploys");
}

export function getIncidentMetrics(id: string): Promise<IncidentMetricsResponse> {
  return getJson<IncidentMetricsResponse>(`/api/incidents/${encodeURIComponent(id)}/metrics`);
}

/** The incident detail modal's Logs tab: raw log lines from the incident's window, fetched lazily
 * (only once that tab is opened) since `/api/incidents/:id/logs` 404s for an unknown id and returns
 * an honestly-empty `{logs: [], total: 0}` once raw telemetry has aged out of retention — both are
 * ordinary outcomes the tab renders inline, not exceptions. */
export function getIncidentLogs(id: string): Promise<IncidentLogsResponse> {
  return getJson<IncidentLogsResponse>(`/api/incidents/${encodeURIComponent(id)}/logs`);
}

// --- Remediation ---------------------------------------------------------------------------------

/** Like `ChaosResult`, a 409 here is an ordinary UI-surfaced outcome (the incident has no report
 * yet, is already closed, or there's no active fault to roll back), never an exception — the
 * server's specific `error` string is the toast copy, so it rides along as `message`. The
 * `cooldown` arm is purely defensive today: the remediate endpoint relays SimulatorDO's non-2xx
 * responses verbatim and `/restore` currently has no cooldown, so no live path produces a 429 —
 * kept so a future DO-side cooldown surfaces as a proper toast instead of a generic error. */
export type RemediateResult =
  | { kind: "ok" }
  | { kind: "rejected"; message: string }
  | { kind: "cooldown"; retryAfterMs: number }
  | { kind: "error"; status: number; message: string };

export async function remediateIncident(id: string): Promise<RemediateResult> {
  const res = await fetch(`/api/incidents/${encodeURIComponent(id)}/remediate`, { method: "POST" });
  const body = await parseBody(res);
  if (res.status === 200) return { kind: "ok" };
  if (res.status === 409) {
    return { kind: "rejected", message: (body as ChaosErrorBody)?.error ?? "remediation was rejected" };
  }
  if (res.status === 429) {
    return { kind: "cooldown", retryAfterMs: (body as ChaosErrorBody)?.retryAfterMs ?? 30_000 };
  }
  const message = (body as ChaosErrorBody)?.error ?? `HTTP ${res.status}`;
  return { kind: "error", status: res.status, message };
}

// --- Chaos actions ---------------------------------------------------------------------------

export type ChaosResult =
  | { kind: "ok"; fault: FaultState }
  | { kind: "scenario_active" }
  | { kind: "world_not_ready" }
  | { kind: "cooldown"; retryAfterMs: number }
  | { kind: "error"; status: number; message: string };

async function postChaos(path: string): Promise<ChaosResult> {
  const res = await fetch(path, { method: "POST" });
  const body = await parseBody(res);
  if (res.status === 200) return { kind: "ok", fault: (body as ChaosFaultBody).fault };
  // Both are 409s from SimulatorDO — disambiguated by the error string (a click can race the
  // world into seeding after the disabled-button check passed).
  if (res.status === 409) {
    return (body as ChaosErrorBody)?.error === "world_not_ready" ? { kind: "world_not_ready" } : { kind: "scenario_active" };
  }
  if (res.status === 429) {
    return { kind: "cooldown", retryAfterMs: (body as ChaosErrorBody)?.retryAfterMs ?? 30_000 };
  }
  const message = (body as ChaosErrorBody)?.error ?? `HTTP ${res.status}`;
  return { kind: "error", status: res.status, message };
}

export function triggerScenario(scenario: ScenarioId): Promise<ChaosResult> {
  return postChaos(`/api/chaos/${scenario}`);
}

export function restoreWorld(): Promise<ChaosResult> {
  return postChaos("/api/chaos/restore");
}

// --- Admin reset -------------------------------------------------------------------------------

export type ResetResult =
  | { kind: "accepted" }
  | { kind: "cooldown"; retryAfterMs: number }
  | { kind: "error"; status: number; message: string };

export async function resetWorld(): Promise<ResetResult> {
  const res = await fetch("/api/admin/reset", { method: "POST" });
  const body = await parseBody(res);
  if (res.status === 202) return { kind: "accepted" };
  if (res.status === 429) {
    return { kind: "cooldown", retryAfterMs: (body as ChaosErrorBody)?.retryAfterMs ?? 30_000 };
  }
  const message = (body as ChaosErrorBody)?.error ?? `HTTP ${res.status}`;
  return { kind: "error", status: res.status, message };
}

// --- Chat --------------------------------------------------------------------------------------

/** One turn of the client-held chat history, as `POST /api/chat` expects it (`ChatTurn` in
 * `src/api/chat.ts`, re-declared here for the same D1-free-import reason as `lib/types.ts`'s
 * header comment). */
export interface ChatRequestTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Streams one `/api/chat` turn, POSTing `messages` and pumping the SSE response through
 * `lib/sse.ts`'s `readSSEStream`, calling `onEvent` with each parsed `ChatSSEEvent` in order.
 *
 * Every failure path funnels into `onEvent` as a synthetic `{type: "error"}` event too — including
 * the ones that never reach an SSE body at all: a `validateChatBody` 400 (a plain JSON `{error}`
 * response, not a stream — e.g. a fabricated request that slips past client-side checks) and a
 * network failure reaching the worker at all. This gives the panel exactly one code path to render
 * a failure inline, matching the task brief's "400s carry specific error strings — surface them
 * inline" — the specific string comes along for the ride either way.
 *
 * An `AbortSignal`, if given, aborts the underlying fetch (and, per the Fetch spec, any in-flight
 * body read) — an `AbortError` is rethrown rather than turned into a user-facing error event, since
 * an abort means nobody local is listening anymore either.
 */
export async function streamChat(
  messages: ChatRequestTurn[],
  onEvent: (event: ChatSSEEvent) => void,
  signal?: AbortSignal,
  opts?: {
    /** Scopes the turn to one incident ("Dig deeper" in the incident modal): the server loads the
     * incident's report/steps itself and injects them into the system prompt — the client only
     * ever names the id, never supplies the context, preserving chat's untrusted-history boundary. */
    incidentId?: string;
  },
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts?.incidentId !== undefined ? { messages, incidentId: opts.incidentId } : { messages }),
    signal,
  });

  if (!res.ok) {
    // validateChatBody rejections (and any other non-2xx) land here as plain JSON, never a stream
    // (`src/api/chat.ts` only calls `streamSSE` once a request has cleared validation and the cap
    // gate) — surfaced as one synthetic error event so the caller doesn't need a second code path.
    const body = await parseBody(res);
    const message = (body as ChaosErrorBody)?.error ?? `request failed (HTTP ${res.status})`;
    onEvent({ type: "error", message });
    return;
  }

  await readSSEStream(res, (raw) => {
    let event: ChatSSEEvent;
    try {
      event = JSON.parse(raw) as ChatSSEEvent;
    } catch {
      return; // a malformed frame — drop it rather than crash the whole turn over one bad event
    }
    onEvent(event);
  });
}
