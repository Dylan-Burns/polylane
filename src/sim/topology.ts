/**
 * The demo universe's static, data-driven service topology (spec §6):
 *
 * ```
 * gateway ──► checkout ──► payments ──► payments-db
 *    │            │
 *    │            └──► notifications ──► email-provider (external)
 *    └──► catalog
 * ```
 *
 * Six internal services emit spans; `email-provider` is an external dependency (no internal
 * spans of its own, only call results — see `EXTERNAL_SERVICE` below). `generator.ts` walks
 * `FLOWS` to build traces; this file only holds data, no generation logic.
 */

export const SERVICES = ["gateway", "checkout", "payments", "payments-db", "notifications", "catalog"] as const;

export type ServiceName = (typeof SERVICES)[number];

/**
 * `email-provider` is a dependency `notifications` calls, but per spec §6 it emits no internal
 * span — only its latency/error outcome folds into the calling step's timing and propagation.
 */
export const EXTERNAL_SERVICE = "email-provider";

export interface Latency {
  mu: number;
  sigma: number;
}

/**
 * One node in a flow's call tree. Shape matches the brief exactly (`{service, operation,
 * latency, errorRate, children}`) — symptom-only error message templates and the async-branch
 * marker live *alongside* the step defs below (`ERROR_LOG_MESSAGES`, `ASYNC_STEP_KEYS`), keyed
 * by `${service}:${operation}`, rather than as extra fields on `Step` itself.
 */
export interface Step {
  service: string;
  operation: string;
  latency: Latency;
  errorRate: number;
  children: Step[];
}

export interface Flow {
  name: string;
  weight: number;
  entry: Step;
}

/** Composite key used by `ERROR_LOG_MESSAGES` / `ASYNC_STEP_KEYS` and by `generator.ts`. */
export function stepKey(step: Pick<Step, "service" | "operation">): string {
  return `${step.service}:${step.operation}`;
}

// --- Step definitions (leaves first) ---------------------------------------------------------

const paymentsDbStep: Step = {
  service: "payments-db",
  operation: "query_ledger",
  latency: { mu: Math.log(12), sigma: 0.45 },
  errorRate: 0.003,
  children: [],
};

const paymentsStep: Step = {
  service: "payments",
  operation: "charge",
  latency: { mu: Math.log(25), sigma: 0.35 },
  errorRate: 0.002,
  children: [paymentsDbStep],
};

const emailProviderStep: Step = {
  service: EXTERNAL_SERVICE,
  operation: "send",
  latency: { mu: Math.log(90), sigma: 0.5 },
  errorRate: 0.003,
  children: [],
};

const notificationsStep: Step = {
  service: "notifications",
  operation: "send_email",
  latency: { mu: Math.log(6), sigma: 0.3 },
  errorRate: 0.002,
  children: [emailProviderStep],
};

const checkoutStep: Step = {
  service: "checkout",
  operation: "place_order",
  latency: { mu: Math.log(15), sigma: 0.4 },
  errorRate: 0.002,
  // Two children: the synchronous payments chain, and the async notifications branch (see
  // ASYNC_STEP_KEYS below) — both nest inside checkout's span, but only the former's errors
  // bubble up to checkout/gateway.
  children: [paymentsStep, notificationsStep],
};

const catalogStep: Step = {
  service: "catalog",
  operation: "search",
  latency: { mu: Math.log(40), sigma: 0.45 },
  errorRate: 0.002,
  children: [],
};

// Gateway is the entry point for every flow; each flow gets its own gateway operation, which
// naturally gives `gateway` the "2-3 operations with distinct profiles" spec §6 calls for.
// Downstream services in this demo topology each sit on exactly one call path, so they get one
// operation apiece — a deliberate scope decision (see task report), not an oversight.

const gatewayCheckoutEntry: Step = {
  service: "gateway",
  operation: "route_checkout",
  latency: { mu: Math.log(8), sigma: 0.35 },
  errorRate: 0.002,
  children: [checkoutStep],
};

const gatewayBrowseEntry: Step = {
  service: "gateway",
  operation: "route_browse",
  latency: { mu: Math.log(6), sigma: 0.3 },
  errorRate: 0.002,
  children: [catalogStep],
};

const gatewayStatusEntry: Step = {
  service: "gateway",
  operation: "get_status",
  latency: { mu: Math.log(4), sigma: 0.25 },
  errorRate: 0.0015,
  children: [],
};

/** Flows: checkout ~15%, browse ~70%, status ~15% (spec §6). Weights need not sum to 1 —
 * `generator.ts` normalizes them — but they do here for readability. */
export const FLOWS: Flow[] = [
  { name: "checkout", weight: 0.15, entry: gatewayCheckoutEntry },
  { name: "browse", weight: 0.7, entry: gatewayBrowseEntry },
  { name: "status", weight: 0.15, entry: gatewayStatusEntry },
];

/**
 * Symptom-only log message for when a step is the one with its own intrinsic error (spec §6
 * telemetry honesty calibration: realistic-sounding, but never names the injected root cause —
 * no deploy/version/scenario references). Keyed by `stepKey`. `payments-db` and `email-provider`
 * use the exact example strings from spec §6 / the task brief.
 */
export const ERROR_LOG_MESSAGES: Readonly<Record<string, string>> = {
  [stepKey(gatewayCheckoutEntry)]: "request handling failed: unexpected client disconnect",
  [stepKey(gatewayBrowseEntry)]: "request handling failed: unexpected client disconnect",
  [stepKey(gatewayStatusEntry)]: "request handling failed: unexpected client disconnect",
  [stepKey(checkoutStep)]: "checkout processing failed: invalid cart state",
  [stepKey(paymentsStep)]: "payment authorization failed: card issuer declined",
  [stepKey(paymentsDbStep)]: "connection pool exhausted: 25/25 in use, acquire timeout 5000ms",
  [stepKey(notificationsStep)]: "notification dispatch failed: template render error",
  [stepKey(emailProviderStep)]: "upstream 503 from provider",
  [stepKey(catalogStep)]: "catalog search failed: index shard timeout",
};

/**
 * Keys of steps whose failures are fire-and-forget from the caller's perspective — the brief's
 * "async branch" (checkout -> notifications -> email-provider). An async step's span still
 * nests inside its parent's duration (generator.ts walks it like any other child), but its
 * error does NOT bubble up to mark the parent 'error' (spec §6 scenario 2: "notifications
 * degrade; checkout unaffected").
 */
export const ASYNC_STEP_KEYS: ReadonlySet<string> = new Set([stepKey(notificationsStep)]);
