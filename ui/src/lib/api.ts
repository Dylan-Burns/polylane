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

import type {
  ChaosErrorBody,
  ChaosFaultBody,
  FaultState,
  IncidentDetailResponse,
  IncidentListResponse,
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

// --- Chaos actions ---------------------------------------------------------------------------

export type ChaosResult =
  | { kind: "ok"; fault: FaultState }
  | { kind: "scenario_active" }
  | { kind: "cooldown"; retryAfterMs: number }
  | { kind: "error"; status: number; message: string };

async function postChaos(path: string): Promise<ChaosResult> {
  const res = await fetch(path, { method: "POST" });
  const body = await parseBody(res);
  if (res.status === 200) return { kind: "ok", fault: (body as ChaosFaultBody).fault };
  if (res.status === 409) return { kind: "scenario_active" };
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
