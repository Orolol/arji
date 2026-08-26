import { describe, expect, it } from "vitest";
import {
  aggregateGradingStatus,
  buildGradingFixSection,
  findCriterionGrading,
  parseAcceptanceCriteria,
  parseGradingEntries,
} from "@/lib/grading/report";

const entries = [
  {
    storyId: "s1",
    criterion: "- [ ] SSE refreshes the card",
    status: "missed" as const,
    evidence: "No completion event was observed.",
  },
  {
    storyId: "s1",
    criterion: "Badges render",
    status: "partial" as const,
    evidence: "Only the detail badge exists.",
  },
];

describe("grading report helpers", () => {
  it("parses reports defensively and aggregates missed over partial over met", () => {
    expect(parseGradingEntries(JSON.stringify(entries))).toEqual(entries);
    expect(parseGradingEntries("not-json")).toBeNull();
    expect(parseGradingEntries([{ ...entries[0], status: "pass" }])).toBeNull();
    expect(aggregateGradingStatus(entries)).toBe("missed");
    expect(aggregateGradingStatus([{ ...entries[0], status: "met" }])).toBe(
      "met",
    );
    expect(aggregateGradingStatus([])).toBeNull();
  });

  it("matches a stored verbatim checklist item to its displayed criterion", () => {
    expect(
      parseAcceptanceCriteria("- [ ] SSE refreshes the card\n2. Badges render"),
    ).toEqual(["SSE refreshes the card", "Badges render"]);
    expect(
      findCriterionGrading(entries, "s1", "SSE refreshes the card")?.status,
    ).toBe("missed");
  });

  it("injects the exact missed criterion and evidence into a fix section", () => {
    const section = buildGradingFixSection({
      reportId: "r1",
      summary: "One gap remains.",
      missed: [entries[0]],
    });
    expect(section).toContain("SSE refreshes the card");
    expect(section).toContain("No completion event was observed.");
    expect(section).toContain("One gap remains.");
  });
});
