/**
 * Root-cause grading for the eval harness — extracted from `eval.ts` so the rubric is unit-testable
 * (`test/unit/grade.test.ts` pins real production reports as fixtures). Pure string logic, no I/O:
 * importable from both the tsx-run eval script and the workers-pool vitest suite.
 *
 * Grading model: `must` keyword groups (ANY-of within a group, ALL groups required) over
 * `summary + root_cause`; `mustNotBlame` terms checked over `root_cause` ONLY — a correct report
 * may (should!) mention a red herring in order to rule it out, and the summary routinely narrates
 * symptoms in blamed-sounding language.
 */

export const SCENARIOS = ["bad-deploy", "dependency-outage", "latency-creep", "traffic-spike"] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export interface Grade {
  /** ANY-of within a group, ALL groups required, over summary + root_cause. */
  must: string[][];
  /** None of these may appear in root_cause.hypothesis/mechanism (cause attribution). */
  mustNotBlame?: string[];
}

export const GRADES: Record<ScenarioId, Grade> = {
  "bad-deploy": { must: [["deploy", "v2.4.1"], ["payments"], ["pool", "latency", "connection"]] },
  "dependency-outage": { must: [["email"], ["notifications"]], mustNotBlame: ["checkout"] },
  "latency-creep": {
    must: [["payments-db", "database"], ["latency", "slow", "p95", "creep", "degrad"]],
    mustNotBlame: ["deploy"],
  },
  "traffic-spike": { must: [["traffic", "load", "spike", "volume"]], mustNotBlame: ["bug", "deploy"] },
};

/** The report fields the rubric reads — structurally the agent's `submit_report` payload subset. */
export interface GradableReport {
  summary?: string;
  root_cause?: { hypothesis?: string; mechanism?: string };
}

/** Words that, near a `mustNotBlame` term, mark the mention as EXCULPATORY ("checkout remains
 * healthy", "not a payments deploy", "the traffic spike is not a bug") rather than an accusation.
 * A correct report routinely names other services to rule them out — a bare substring match
 * mis-scores those as blame (observed on dependency-outage, where the report says "checkout/gateway
 * remain healthy since the email send is fire-and-forget"). A term counts as "blamed" only if at
 * least one of its occurrences has NO exoneration marker within `EXONERATION_WINDOW` chars. */
const EXONERATION_MARKERS = [
  // Direct exoneration ("checkout remains healthy", "not a payments deploy")
  "not ", "n't", "no change", "unaffected", "healthy", "remain", "fine", "isolated", "unrelated",
  "ruled out", "rule out", "best-effort", "fire-and-forget", "non-blocking", "downstream", "cascade",
  "symptom", "rather than", "instead of", "red herring", "unchanged",
  // Corroboration/correlation, NOT causal attribution ("the surge is consistent with the deploy
  // timing"). Noting that a deploy coincided is exactly what an analyst should do; it is not
  // blaming the deploy as the root cause.
  "consistent with", "correlat", "coincid", "alongside", "at the same time", "around the same", "timing",
];
const EXONERATION_WINDOW = 80;

/** Causal-attribution phrases that DEFEAT an exoneration marker in the same window: blame and
 * correlation vocabulary routinely co-occur ("the surge's timing proves the deploy caused the
 * outage"), and without this override any correlation word within 80 chars would launder an
 * explicit blame into a rule-out. Constrained by the real-report fixtures in
 * test/unit/grade.test.ts: "because of" (not bare "because" — DEPENDENCY_OUTAGE_REAL uses an
 * exculpatory "Because checkout... treats the send as non-blocking"), and no "drove"/"drive"
 * (TRAFFIC_SPIKE_REAL's passing report says the surge "drove ~3-5x normal load"). */
const CAUSAL_OVERRIDES = [
  "caused", "root cause", "due to", "because of", "introduced", "triggered", "roll back", "rolled back", "blame",
];

/** True if EVERY occurrence of `term` in `text` sits near an exoneration marker with no causal
 * phrase alongside it (i.e. the term is only ever mentioned to rule it out, never blamed). */
function onlyExculpatory(text: string, term: string): boolean {
  let idx = text.indexOf(term);
  if (idx === -1) return false; // not present at all — caller handles that separately
  while (idx !== -1) {
    const lo = Math.max(0, idx - EXONERATION_WINDOW);
    const hi = Math.min(text.length, idx + term.length + EXONERATION_WINDOW);
    const window = text.slice(lo, hi);
    const exonerated =
      EXONERATION_MARKERS.some((m) => window.includes(m)) && !CAUSAL_OVERRIDES.some((c) => window.includes(c));
    if (!exonerated) return false; // a blame-context occurrence
    idx = text.indexOf(term, idx + term.length);
  }
  return true;
}

export function gradeReport(scenario: ScenarioId, report: GradableReport): { pass: boolean; detail: string } {
  const grade = GRADES[scenario];
  const rootCause = `${report.root_cause?.hypothesis ?? ""} ${report.root_cause?.mechanism ?? ""}`.toLowerCase();
  const haystack = `${report.summary ?? ""} ${rootCause}`.toLowerCase();

  const missing = grade.must.filter((group) => !group.some((kw) => haystack.includes(kw)));
  // A term is "blamed" only if it appears AND is not purely exculpatory (see onlyExculpatory).
  const blamed = (grade.mustNotBlame ?? []).filter((kw) => rootCause.includes(kw) && !onlyExculpatory(rootCause, kw));

  if (missing.length === 0 && blamed.length === 0) return { pass: true, detail: "root cause correct" };
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.map((g) => g.join("|")).join(" AND ")}`);
  if (blamed.length > 0) parts.push(`blames: ${blamed.join(", ")}`);
  return { pass: false, detail: parts.join("; ") };
}
