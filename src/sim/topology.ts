/**
 * The demo universe's static, data-driven service topology (spec §6):
 *
 * ```
 * edge-gateway ──► checkout-edge ──► payments-api ──► ledger-db
 *    │                   │
 *    │                   └──► notify ──► email-api (external)
 *    └──► catalog-kv
 * ```
 *
 * Six internal services emit spans; `email-api` is an external dependency (no internal
 * spans of its own, only call results — see `EXTERNAL_SERVICE` below). Each internal service
 * exposes 2-3 operations with distinct latency/error profiles (spec §6). `generator.ts` walks
 * `FLOWS` to build traces; this file only holds data, no generation logic.
 */

export const SERVICES = ["edge-gateway", "checkout-edge", "payments-api", "ledger-db", "notify", "catalog-kv"] as const;

export type ServiceName = (typeof SERVICES)[number];

/**
 * `email-api` is a dependency `notify` calls, but per spec §6 it emits no internal
 * span — only its latency/error outcome folds into the calling step's timing and propagation.
 */
export const EXTERNAL_SERVICE = "email-api";

/** Cloudflare-native product each service is modeled after — drives UI sublabels and node icons. */
export type ServiceKind = "worker" | "d1" | "kv" | "queue" | "external";

/** Kind for every one of the seven service names (six internal + the external dependency). */
export const SERVICE_KIND: Readonly<Record<string, ServiceKind>> = {
  "edge-gateway": "worker",
  "checkout-edge": "worker",
  "payments-api": "worker",
  "ledger-db": "d1",
  "catalog-kv": "kv",
  notify: "queue",
  "email-api": "external",
};

export interface Latency {
  mu: number;
  sigma: number;
}

/**
 * One node in a flow's call tree. Shape matches the brief exactly (`{service, operation,
 * latency, errorRate, children}`) — symptom-only error message templates and the async-branch
 * marker live *alongside* the step defs below (`ERROR_LOG_MESSAGES`, `ASYNC_STEP_KEYS`), keyed
 * by `${service}:${operation}`, rather than as extra fields on `Step` itself.
 *
 * Step objects are immutable data; a leaf may be shared by several parents (e.g. both payments-api
 * operations hit the same ledger-db steps) — the generator never mutates them.
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
// Latency `mu` is log-space, so `exp(mu)` is the operation's median duration in ms.

const paymentsDbQueryStep: Step = {
  service: "ledger-db",
  operation: "query_ledger",
  latency: { mu: Math.log(12), sigma: 0.45 },
  errorRate: 0.003,
  children: [],
};

const paymentsDbUpdateStep: Step = {
  service: "ledger-db",
  operation: "update_ledger",
  latency: { mu: Math.log(18), sigma: 0.5 },
  errorRate: 0.004,
  children: [],
};

const paymentsChargeStep: Step = {
  service: "payments-api",
  operation: "charge",
  latency: { mu: Math.log(25), sigma: 0.35 },
  errorRate: 0.002,
  // Read the ledger, then write the charge — both ledger-db operations on every charge.
  children: [paymentsDbQueryStep, paymentsDbUpdateStep],
};

const paymentsRefundStep: Step = {
  service: "payments-api",
  operation: "refund",
  latency: { mu: Math.log(30), sigma: 0.4 },
  errorRate: 0.003,
  children: [paymentsDbQueryStep, paymentsDbUpdateStep],
};

const emailProviderStep: Step = {
  service: EXTERNAL_SERVICE,
  operation: "send",
  latency: { mu: Math.log(90), sigma: 0.5 },
  errorRate: 0.003,
  children: [],
};

const notificationsRenderStep: Step = {
  service: "notify",
  operation: "render_template",
  latency: { mu: Math.log(3), sigma: 0.25 },
  errorRate: 0.001,
  children: [],
};

const notificationsSendStep: Step = {
  service: "notify",
  operation: "send_email",
  latency: { mu: Math.log(6), sigma: 0.3 },
  errorRate: 0.002,
  // Render the template (internal sub-operation), then call the external provider.
  children: [notificationsRenderStep, emailProviderStep],
};

const checkoutGetCartStep: Step = {
  service: "checkout-edge",
  operation: "get_cart",
  latency: { mu: Math.log(7), sigma: 0.3 },
  errorRate: 0.001,
  children: [],
};

const checkoutPlaceOrderStep: Step = {
  service: "checkout-edge",
  operation: "place_order",
  latency: { mu: Math.log(15), sigma: 0.4 },
  errorRate: 0.002,
  // Two children: the synchronous payments-api chain, and the async notify branch (see
  // ASYNC_STEP_KEYS below). The async branch starts inside place_order's window but does not
  // extend it, and its errors do NOT bubble up to checkout-edge/edge-gateway.
  children: [paymentsChargeStep, notificationsSendStep],
};

const checkoutRefundOrderStep: Step = {
  service: "checkout-edge",
  operation: "refund_order",
  latency: { mu: Math.log(12), sigma: 0.35 },
  errorRate: 0.002,
  children: [paymentsRefundStep],
};

const catalogListStep: Step = {
  service: "catalog-kv",
  operation: "list_products",
  latency: { mu: Math.log(40), sigma: 0.45 },
  errorRate: 0.002,
  children: [],
};

const catalogGetStep: Step = {
  service: "catalog-kv",
  operation: "get_product",
  latency: { mu: Math.log(15), sigma: 0.35 },
  errorRate: 0.0015,
  children: [],
};

// edge-gateway is the entry point for every flow. It exposes exactly three operations
// (route_checkout, route_browse, get_status) — the refund flow enters through route_checkout
// (edge-gateway routes both order placement and refunds to checkout-edge), keeping every service
// within spec §6's "2-3 operations" band.

const gatewayCheckoutEntry: Step = {
  service: "edge-gateway",
  operation: "route_checkout",
  latency: { mu: Math.log(8), sigma: 0.35 },
  errorRate: 0.002,
  // Fetch the cart, then place the order.
  children: [checkoutGetCartStep, checkoutPlaceOrderStep],
};

const gatewayRefundEntry: Step = {
  service: "edge-gateway",
  operation: "route_checkout", // same (service, operation) profile as gatewayCheckoutEntry
  latency: { mu: Math.log(8), sigma: 0.35 },
  errorRate: 0.002,
  children: [checkoutRefundOrderStep],
};

const gatewayBrowseEntry: Step = {
  service: "edge-gateway",
  operation: "route_browse",
  latency: { mu: Math.log(6), sigma: 0.3 },
  errorRate: 0.002,
  // List products, then view one — exercises both catalog-kv operations per browse.
  children: [catalogListStep, catalogGetStep],
};

const gatewayStatusEntry: Step = {
  service: "edge-gateway",
  operation: "get_status",
  latency: { mu: Math.log(4), sigma: 0.25 },
  errorRate: 0.0015,
  children: [],
};

/**
 * Flows: checkout ~15%, browse ~70%, status ~15% (spec §6), plus a rare `refund` flow (~2%;
 * weights are normalized by `generator.ts`) that exercises checkout-edge.refund_order /
 * payments-api.refund so every service genuinely has 2-3 operations with distinct profiles.
 */
export const FLOWS: Flow[] = [
  { name: "checkout", weight: 0.15, entry: gatewayCheckoutEntry },
  { name: "browse", weight: 0.7, entry: gatewayBrowseEntry },
  { name: "status", weight: 0.15, entry: gatewayStatusEntry },
  { name: "refund", weight: 0.02, entry: gatewayRefundEntry },
];

/**
 * Symptom-only log message for when a step is the one with its own intrinsic error (spec §6
 * telemetry honesty calibration: realistic-sounding, but never names the injected root cause —
 * no deploy/version/scenario references). Keyed by `stepKey`. Note `edge-gateway:route_checkout`
 * covers both gateway entry Steps that share that operation.
 */
export const ERROR_LOG_MESSAGES: Readonly<Record<string, string>> = {
  [stepKey(gatewayCheckoutEntry)]: "request handling failed: unexpected client disconnect",
  [stepKey(gatewayBrowseEntry)]: "request handling failed: unexpected client disconnect",
  [stepKey(gatewayStatusEntry)]: "request handling failed: unexpected client disconnect",
  [stepKey(checkoutGetCartStep)]: "cart lookup failed: session state missing",
  [stepKey(checkoutPlaceOrderStep)]: "checkout processing failed: invalid cart state",
  [stepKey(checkoutRefundOrderStep)]: "refund processing failed: order state conflict",
  [stepKey(paymentsChargeStep)]: "payment authorization failed: card issuer declined",
  [stepKey(paymentsRefundStep)]: "refund request failed: settlement batch not found",
  [stepKey(paymentsDbQueryStep)]: "D1_ERROR: too many queued queries — 25 in flight, acquire timed out after 5000ms",
  [stepKey(paymentsDbUpdateStep)]: "D1_ERROR: database is locked — ledger write retried 3 times, giving up",
  [stepKey(notificationsSendStep)]: "email send failed: connection reset by peer",
  [stepKey(notificationsRenderStep)]: "template render error: missing field 'order_id'",
  [stepKey(emailProviderStep)]: "upstream 503 from provider",
  [stepKey(catalogListStep)]: "KV list failed: cursor expired mid-pagination",
  [stepKey(catalogGetStep)]: "KV get failed: read timed out at edge cache",
};

/**
 * Keys of steps whose failures are fire-and-forget from the caller's perspective — the brief's
 * "async branch" (checkout-edge -> notify -> email-api). An async step's span starts
 * within its parent's window but the parent does not wait for it: no duration contribution and
 * no error propagation to the parent (spec §6 scenario 2: "notify degrades; checkout-edge
 * unaffected").
 */
export const ASYNC_STEP_KEYS: ReadonlySet<string> = new Set([stepKey(notificationsSendStep)]);
