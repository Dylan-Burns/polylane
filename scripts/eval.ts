/**
 * Watchtower eval harness (plan Task 4.4): drives the DEPLOYED system through all four fault
 * scenarios via the same public HTTP surface the demo UI uses, and grades each investigation's
 * report for root-cause accuracy with required-mention keyword groups.
 *
 * Usage: `pnpm eval [--base https://watchtower.<subdomain>.workers.dev]`
 *
 * Per scenario, sequentially: restore → poll `/api/state` until running + fault-clear + all-green
 * (and no live incident) → inject → poll `/api/incidents` for a NEW incident → poll it to
 * `reported` (12-minute ceiling) → grade → restore → wait for auto-resolve. The verdict table is
 * printed and written to `docs/eval-latest.md`. Exit code 0 iff ≥ 3/4 scenarios pass (the plan's
 * benchmark gate).
 *
 * Grading semantics: `must` groups are ANY-of-within, ALL-of-across, matched case-insensitively
 * over `summary + root_cause.hypothesis + root_cause.mechanism`. `mustNotBlame` matches over the
 * root_cause fields ONLY — a correct report may legitimately mention the red-herring catalog
 * deploy or an impacted service by name while ruling it out; what it must not do is *attribute
 * the cause* to it. The rubric itself lives in `grade.ts` (unit-tested with real report fixtures).
 */

import { gradeReport, SCENARIOS, type ScenarioId } from "./grade";

interface WorldStatusView {
  worldStatus: "unseeded" | "seeding" | "running" | "resetting";
  fault: { scenario: string; startedMs: number } | null;
  generation: number;
}

interface StateResponse {
  health: Record<string, "green" | "amber" | "red">;
  worldStatus: WorldStatusView;
}

interface IncidentView {
  id: string;
  status: "open" | "investigating" | "reported" | "resolved" | "failed";
  severity: string;
  opened_at: number;
  reported_at: number | null;
  resolved_at: number | null;
  report: {
    summary?: string;
    root_cause?: { hypothesis?: string; mechanism?: string };
    failure_reason?: string;
  } | null;
  fingerprints: string[];
}

interface StepView {
  step_no: number;
  kind: string;
  tokens_in: number;
  tokens_out: number;
}

/** Per-scenario ceiling from inject to `reported` (plan: 12 min). */
const REPORTED_TIMEOUT_MS = 12 * 60_000;
/** Ceiling for restore → auto-resolve (spec: healthy-5-min rule; plan benchmark ≤ 6 min + slack). */
const RESOLVE_TIMEOUT_MS = 10 * 60_000;
/** Ceiling for the world to come back healthy between scenarios. */
const HEALTHY_TIMEOUT_MS = 12 * 60_000;
const POLL_MS = 5_000;

function parseArgs(): { base: string } {
  const idx = process.argv.indexOf("--base");
  const base = idx !== -1 ? process.argv[idx + 1] : "https://watchtower.dylanburns.workers.dev";
  if (!base || !base.startsWith("http")) throw new Error("--base must be an http(s) URL");
  return { base: base.replace(/\/$/, "") };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function post(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { method: "POST" });
  return { status: res.status, body: await res.text() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `probe` every POLL_MS until it returns non-null or `timeoutMs` elapses (then throws). */
async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch((err) => {
      console.log(`  [poll ${label}] transient error: ${(err as Error).message}`);
      return null;
    });
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timeout after ${timeoutMs / 1000}s waiting for ${label}`);
    await sleep(POLL_MS);
  }
}

async function fetchIncidents(base: string): Promise<IncidentView[]> {
  const { incidents } = await getJson<{ incidents: IncidentView[] }>(`${base}/api/incidents?from=-24h`);
  return incidents;
}

/** running + no fault + all services green + nothing open/investigating. */
async function waitHealthy(base: string): Promise<void> {
  await waitFor("world healthy", HEALTHY_TIMEOUT_MS, async () => {
    const state = await getJson<StateResponse>(`${base}/api/state`);
    if (state.worldStatus.worldStatus !== "running" || state.worldStatus.fault !== null) return null;
    if (!Object.values(state.health).every((h) => h === "green")) return null;
    const live = (await fetchIncidents(base)).some((i) => i.status === "open" || i.status === "investigating");
    return live ? null : true;
  });
}

interface ScenarioResult {
  scenario: ScenarioId;
  verdict: "PASS" | "FAIL";
  detail: string;
  detectSec: number | null;
  investigationSec: number | null;
  steps: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

async function runScenario(base: string, scenario: ScenarioId): Promise<ScenarioResult> {
  console.log(`\n=== ${scenario} ===`);
  await post(`${base}/api/chaos/restore`);
  console.log("  waiting for healthy world…");
  await waitHealthy(base);

  const priorIds = new Set((await fetchIncidents(base)).map((i) => i.id));
  const injectedAt = Date.now();
  const inject = await post(`${base}/api/chaos/${scenario}`);
  if (inject.status !== 200) {
    return {
      scenario, verdict: "FAIL", detail: `inject → ${inject.status} ${inject.body}`,
      detectSec: null, investigationSec: null, steps: null, tokensIn: null, tokensOut: null,
    };
  }
  console.log("  fault injected; waiting for detection…");

  let result: ScenarioResult;
  try {
    const incident = await waitFor(`new incident (${scenario})`, REPORTED_TIMEOUT_MS, async () => {
      const fresh = (await fetchIncidents(base)).find((i) => !priorIds.has(i.id));
      return fresh ?? null;
    });
    const detectSec = Math.round((incident.opened_at - injectedAt) / 1000);
    console.log(`  incident ${incident.id} opened ${detectSec}s after inject; waiting for report…`);

    const remaining = REPORTED_TIMEOUT_MS - (Date.now() - injectedAt);
    const terminal = await waitFor(`incident ${incident.id} reported`, Math.max(remaining, 60_000), async () => {
      const view = (await fetchIncidents(base)).find((i) => i.id === incident.id);
      if (!view) return null;
      return view.status === "reported" || view.status === "resolved" || view.status === "failed" ? view : null;
    });

    if (terminal.status === "failed" || terminal.report === null) {
      result = {
        scenario, verdict: "FAIL",
        detail: terminal.status === "failed"
          ? `investigation failed: ${terminal.report?.failure_reason ?? "unknown"}`
          : `terminal '${terminal.status}' without a report`,
        detectSec, investigationSec: null, steps: null, tokensIn: null, tokensOut: null,
      };
    } else {
      const { steps } = await getJson<{ steps: StepView[] }>(`${base}/api/incidents/${terminal.id}`);
      const graded = gradeReport(scenario, terminal.report);
      result = {
        scenario,
        verdict: graded.pass ? "PASS" : "FAIL",
        detail: graded.detail,
        detectSec,
        investigationSec: terminal.reported_at !== null ? Math.round((terminal.reported_at - terminal.opened_at) / 1000) : null,
        steps: steps.filter((s) => s.kind === "tool_call").length,
        tokensIn: steps.reduce((a, s) => a + s.tokens_in, 0),
        tokensOut: steps.reduce((a, s) => a + s.tokens_out, 0),
      };
      console.log(`  report graded: ${result.verdict} (${result.detail})`);
    }
  } catch (err) {
    result = {
      scenario, verdict: "FAIL", detail: (err as Error).message,
      detectSec: null, investigationSec: null, steps: null, tokensIn: null, tokensOut: null,
    };
  }

  console.log("  restoring; waiting for auto-resolve…");
  await post(`${base}/api/chaos/restore`);
  try {
    await waitFor("auto-resolve", RESOLVE_TIMEOUT_MS, async () => {
      const live = (await fetchIncidents(base)).some((i) => i.status !== "resolved" && i.status !== "failed");
      return live ? null : true;
    });
  } catch (err) {
    console.log(`  WARNING: ${(err as Error).message} — continuing to next scenario`);
  }
  return result;
}

function renderTable(results: ScenarioResult[]): string {
  const rows = results.map((r) => {
    const verdict = r.verdict === "PASS" ? "✅ PASS" : "❌ FAIL";
    const tokens = r.tokensIn !== null ? `${r.tokensIn} / ${r.tokensOut}` : "—";
    const wall = r.investigationSec !== null ? `${r.investigationSec}s` : "—";
    const detect = r.detectSec !== null ? `${r.detectSec}s` : "—";
    return `| ${r.scenario} | ${verdict} | ${detect} | ${r.steps ?? "—"} | ${tokens} | ${wall} | ${r.detail} |`;
  });
  return [
    "| Scenario | Verdict | Fault→incident | Tool calls | Tokens in / out | Investigation wall | Notes |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

async function main(): Promise<void> {
  const { base } = parseArgs();
  console.log(`Watchtower eval against ${base}`);
  const startedAt = new Date().toISOString();

  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(base, scenario));
  }

  const passed = results.filter((r) => r.verdict === "PASS").length;
  const table = renderTable(results);
  const doc = [
    `# Watchtower eval — ${startedAt}`,
    "",
    `Target: ${base}  •  Result: **${passed}/${results.length} scenarios root-caused correctly** (gate: ≥ 3/4)`,
    "",
    table,
    "",
    "Grading: required-mention keyword groups over `report.summary + report.root_cause` (ANY within a group, ALL groups);",
    "\"must-not-blame\" terms are checked against `root_cause` only, so a report may mention a red herring while ruling it out.",
    "",
  ].join("\n");

  const { writeFile } = await import("node:fs/promises");
  await writeFile(new URL("../docs/eval-latest.md", import.meta.url), doc);

  console.log(`\n${table}\n`);
  console.log(`${passed}/${results.length} passed — ${passed >= 3 ? "GATE MET" : "GATE FAILED"} (written to docs/eval-latest.md)`);
  process.exit(passed >= 3 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
