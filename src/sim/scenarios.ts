/**
 * Fault scenarios (spec §6, the chaos-panel table). Each scenario is a pure mapping from "which
 * scenario is active, how long has it been active" to the `FaultEffects` the generator already
 * knows how to apply (see `src/sim/generator.ts`'s `walkStep`) plus the `Deploy` events it should
 * emit — this module holds no generation logic of its own.
 *
 * Key format note: `FaultEffects.latencyMult` / `errorRateOverride` are keyed by plain **service**
 * name, matching `step.service` as read by `generator.ts` (`effects.latencyMult.get(step.service)`
 * etc.) — there is no per-operation granularity in the generator today, so an override on
 * `"payments-api"` reaches both `payments-api.charge` and `payments-api.refund`.
 *
 * Honesty calibration (spec §6): every string here that the agent could observe through the query
 * layer (log messages, deploy notes) stays symptom-only — never names a scenario, "deploy", a
 * version, or the word "fault"/"chaos"/"inject".
 */

import type { Deploy } from "../telemetry/types";
import type { FaultEffects } from "./generator";
import { ERROR_LOG_MESSAGES, EXTERNAL_SERVICE } from "./topology";

export type ScenarioId = "bad-deploy" | "dependency-outage" | "latency-creep" | "traffic-spike";

/** Active fault, or `null` when the world is running clean (no chaos triggered / after Restore). */
export type FaultState = { scenario: ScenarioId; startedMs: number } | null;

/** No fault: every generator knob at its baseline value. */
export function identityEffects(): FaultEffects {
  return { latencyMult: new Map(), errorRateOverride: new Map(), trafficMult: 1 };
}

/** Looks up a symptom string already established in `topology.ts` for a real baseline error,
 * failing fast (at module load) rather than silently drifting if that key is ever renamed —
 * scenarios must reuse *established* phrasing, not invent new tells. */
function establishedLogMessage(stepKeyStr: string): string {
  const message = ERROR_LOG_MESSAGES[stepKeyStr];
  if (message === undefined) {
    throw new Error(`scenarios.ts: no established ERROR_LOG_MESSAGES entry for "${stepKeyStr}"`);
  }
  return message;
}

// --- Scenario constants (spec §6 fault-scenario table) -----------------------------------------

/** Bad deploy: cascading effects start 30s after the deploy event, not at the deploy itself —
 * the agent must correlate the deploy timestamp with the *later* regression onset. */
const BAD_DEPLOY_ONSET_MS = 30_000;
const BAD_DEPLOY_LATENCY_MULT = 6;
const BAD_DEPLOY_ERROR_RATE = 0.25;
const BAD_DEPLOY_ERROR_TYPE = "pool_exhausted";
/** Reuses the exact phrasing already established for `ledger-db:query_ledger`'s baseline
 * pool-exhaustion error — sounds like a real resource exhaustion, never names the deploy. */
const BAD_DEPLOY_LOG_MESSAGE = establishedLogMessage("ledger-db:query_ledger");

const DEPENDENCY_OUTAGE_ERROR_RATE = 1;
const DEPENDENCY_OUTAGE_ERROR_TYPE = "upstream_unavailable";
/** Reuses the email-api step's own established symptom string. */
const DEPENDENCY_OUTAGE_LOG_MESSAGE = establishedLogMessage(`${EXTERNAL_SERVICE}:send`);

const LATENCY_CREEP_RAMP_MS = 4 * 60_000;
const LATENCY_CREEP_MAX_MULT = 4;

const TRAFFIC_SPIKE_MULT = 5;

/** Benign red-herring deploy, always emitted once any scenario starts (spec §6: "60-120s after
 * any scenario starts"; pinned to a fixed 90s offset here so effects/deploys stay deterministic
 * for tests and the eval harness). */
const RED_HERRING_DELAY_MS = 90_000;

// --- effectsFor ----------------------------------------------------------------------------------

/** `nowMs` is the simulated clock; `fault === null` (no chaos active, or after Restore world)
 * always yields identity effects. */
export function effectsFor(fault: FaultState, nowMs: number): FaultEffects {
  if (fault === null) return identityEffects();
  const elapsedMs = nowMs - fault.startedMs;

  switch (fault.scenario) {
    case "bad-deploy": {
      if (elapsedMs < BAD_DEPLOY_ONSET_MS) return identityEffects();
      return {
        latencyMult: new Map([["payments-api", BAD_DEPLOY_LATENCY_MULT]]),
        errorRateOverride: new Map([
          [
            "payments-api",
            { rate: BAD_DEPLOY_ERROR_RATE, errorType: BAD_DEPLOY_ERROR_TYPE, logMessage: BAD_DEPLOY_LOG_MESSAGE },
          ],
        ]),
        // The checkout-edge-timeout / edge-gateway-5xx cascade is NOT modeled here — it comes free
        // from the generator's own downstream-error propagation once "payments-api" reports an error.
        trafficMult: 1,
      };
    }

    case "dependency-outage": {
      return {
        latencyMult: new Map(),
        errorRateOverride: new Map([
          [
            EXTERNAL_SERVICE,
            {
              rate: DEPENDENCY_OUTAGE_ERROR_RATE,
              errorType: DEPENDENCY_OUTAGE_ERROR_TYPE,
              logMessage: DEPENDENCY_OUTAGE_LOG_MESSAGE,
            },
          ],
        ]),
        trafficMult: 1,
      };
    }

    case "latency-creep": {
      // Linear ramp x1 -> x4 over LATENCY_CREEP_RAMP_MS, then holds at x4 (spec §6: "ramps ...
      // then hold"). Clamping elapsedMs into [0, RAMP_MS] before dividing keeps this well-defined
      // for nowMs at or before startedMs too.
      const rampProgress = Math.min(1, Math.max(0, elapsedMs / LATENCY_CREEP_RAMP_MS));
      const mult = 1 + (LATENCY_CREEP_MAX_MULT - 1) * rampProgress;
      return {
        latencyMult: new Map([["ledger-db", mult]]),
        errorRateOverride: new Map(),
        trafficMult: 1,
      };
    }

    case "traffic-spike": {
      return {
        latencyMult: new Map(),
        errorRateOverride: new Map(),
        trafficMult: TRAFFIC_SPIKE_MULT,
      };
    }

    default: {
      const _exhaustive: never = fault.scenario;
      throw new Error(`effectsFor: unhandled scenario ${String(_exhaustive)}`);
    }
  }
}

// --- deployEventsFor -----------------------------------------------------------------------------

/** Derived from scenario+version (not startedMs) so re-triggering the same scenario reproduces
 * the same id and the SimulatorDO's insert dedupes idempotently (deploys.id is a PRIMARY KEY). */
function deployId(scenario: ScenarioId, service: string, version: string): string {
  return `deploy-${scenario}-${service}-${version}`;
}

/** `fault === null` emits nothing. Otherwise always includes the benign red-herring `catalog-kv`
 * deploy, plus (bad-deploy only) the real `payments-api@v2.4.1` deploy that the agent must
 * correlate with the regression onset 30s later. Deploy notes are ordinary, non-revealing release
 * notes — they never hint that one of the two is the actual cause. */
export function deployEventsFor(fault: FaultState): Deploy[] {
  if (fault === null) return [];
  const { scenario, startedMs } = fault;
  const deploys: Deploy[] = [];

  if (scenario === "bad-deploy") {
    deploys.push({
      id: deployId(scenario, "payments-api", "v2.4.1"),
      service: "payments-api",
      version: "v2.4.1",
      ts_ms: startedMs,
      note: "routine release",
    });
  }

  deploys.push({
    id: deployId(scenario, "catalog-kv", "v1.8.3"),
    service: "catalog-kv",
    version: "v1.8.3",
    ts_ms: startedMs + RED_HERRING_DELAY_MS,
    note: "routine release",
  });

  return deploys;
}

// --- SCENARIOS (chaos panel + eval) ---------------------------------------------------------------

/** Human-facing metadata for the chaos panel and the eval harness — not telemetry the agent
 * consumes, so (unlike log messages / deploy notes above) it may describe the mechanism plainly. */
export const SCENARIOS: Record<ScenarioId, { label: string; description: string; expectedDetection: string }> = {
  "bad-deploy": {
    label: "Bad Worker deploy",
    description:
      "A payments-api Worker release quietly regresses latency and reliability starting 30s after ship, cascading into checkout-edge timeouts and edge-gateway 5xxs.",
    expectedDetection:
      "Correlates the payments-api deploy event's timestamp with the regression's later onset (not the red-herring catalog-kv deploy), and traces the cascade from payments-api through checkout-edge to edge-gateway.",
  },
  "dependency-outage": {
    label: "Dependency outage",
    description:
      "The external email API becomes fully unavailable; notify sends fail, but checkout completes normally.",
    expectedDetection:
      "Scopes the blast radius to notify/email-api only, and concludes checkout/customer impact is low rather than over-escalating.",
  },
  "latency-creep": {
    label: "Latency creep (slow burn: ~5 min)",
    description:
      "ledger-db (D1) latency ramps up gradually over about 4 minutes with no sharp edge and no change in error rate.",
    expectedDetection:
      "Recognizes a gradual drift trend in ledger-db latency (not a step change) and attributes it to the database tier.",
  },
  "traffic-spike": {
    label: "Traffic spike",
    description: "Edge traffic jumps 5x; latency rises broadly across services with no underlying defect.",
    expectedDetection:
      "Attributes elevated latency to load volume proportionally across services, and does not misidentify a code or deploy culprit.",
  },
};
