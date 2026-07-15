import { describe, expect, it } from "vitest";
import { validateReport } from "../../src/agent/report-schema";
import { buildSeedStory } from "../../src/sim/seed-incident";

// Locks seed/schema alignment permanently (Task 5.2 fix): the seeded incident's hand-authored
// report must always pass the exact same structural validation a live `submit_report` tool call
// goes through, so the UI's rich report/timeline/evidence rendering never has to special-case it.

const NOW = Date.UTC(2026, 0, 6, 12, 0, 0);

describe("seed-incident report schema alignment", () => {
  it("buildSeedStory's raw report passes validateReport", () => {
    const story = buildSeedStory(NOW);
    expect(() => validateReport(story.report)).not.toThrow();
  });

  it("buildSeedStory's embedded report (what incidents.report_json actually stores) also passes validateReport", () => {
    const story = buildSeedStory(NOW);
    expect(() => validateReport(story.embeddedReport)).not.toThrow();
  });

  it("only the trace-citing evidence entry carries the embedded decoration", () => {
    const story = buildSeedStory(NOW);
    const decorated = story.embeddedReport.evidence.filter((e) => e.embedded !== undefined);
    expect(decorated).toHaveLength(1);
    expect(decorated[0]?.trace_id).not.toBeNull();
    expect(decorated[0]?.embedded).toMatchObject({ truncated: false });

    // The raw (pre-embed) report step content must NOT carry `.embedded` -- mirrors
    // `agent/loop.ts` recording the report before `embedEvidence` ever runs.
    expect(story.report.evidence.every((e) => e.embedded === undefined)).toBe(true);
  });

  it("the report step's content is the raw, not embedded, report", () => {
    const story = buildSeedStory(NOW);
    const reportStep = story.steps.find((s) => s.kind === "report");
    expect(reportStep?.content).toEqual(story.report);
  });

  it("every tool_call/tool_result step matches agent/loop.ts's live shape and a real agent/tools.ts tool name", () => {
    const story = buildSeedStory(NOW);
    const REAL_TOOL_NAMES = new Set(["query_metrics", "search_logs", "find_traces", "get_trace", "list_deploys", "get_incidents"]);

    for (const step of story.steps) {
      if (step.kind === "tool_call") {
        const content = step.content as { tool_use_id: string; name: string; input: unknown };
        expect(typeof content.tool_use_id).toBe("string");
        expect(REAL_TOOL_NAMES.has(content.name)).toBe(true);
      }
      if (step.kind === "tool_result") {
        const content = step.content as { tool_use_id: string; name: string; output: unknown; is_error: boolean };
        expect(typeof content.tool_use_id).toBe("string");
        expect(REAL_TOOL_NAMES.has(content.name)).toBe(true);
        expect(typeof content.is_error).toBe("boolean");
      }
    }
  });

  it("is deterministic given nowMs (same input -> identical story, no wall-clock reads)", () => {
    const a = buildSeedStory(NOW);
    const b = buildSeedStory(NOW);
    expect(a).toEqual(b);
  });
});
