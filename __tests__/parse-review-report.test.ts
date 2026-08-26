/**
 * Tests for the prose → findings recovery (lib/pipeline/parse-review-report.ts).
 *
 * The four fixtures under __tests__/fixtures/review-reports/ are the VERBATIM
 * reports codex filed on epic E-arij-096 across its four review cycles — the
 * run whose builders never saw a single finding because reviewComments stayed
 * empty. They are the regression bar: if the parser stops recovering all 22
 * findings from them, the context repair has silently come undone.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import {
  parseReviewReport,
  parseLocation,
} from "@/lib/pipeline/parse-review-report";

function fixture(name: string): string {
  return fs.readFileSync(
    path.join(__dirname, "fixtures", "review-reports", name),
    "utf8"
  );
}

/** Cycle → number of `**Severity:**` rows the report actually declares. */
const CYCLES: ReadonlyArray<[string, number]> = [
  ["codex-cycle1.md", 5],
  ["codex-cycle2.md", 5],
  ["codex-cycle3.md", 7],
  ["codex-cycle4.md", 5],
];

describe("parseReviewReport — real codex reports", () => {
  it.each(CYCLES)("recovers every declared finding from %s", (name, count) => {
    const report = fixture(name);
    const findings = parseReviewReport(report);

    expect(findings).toHaveLength(count);
    // Every declared severity row became a finding — nothing silently dropped.
    expect(findings).toHaveLength(
      (report.match(/\*\*Severity:\*\*/g) ?? []).length
    );
  });

  it("anchors every recovered finding to a real-looking file and line", () => {
    for (const [name] of CYCLES) {
      for (const finding of parseReviewReport(fixture(name))) {
        expect(finding.filePath, name).toMatch(/\.\w+$/);
        expect(finding.filePath, name).not.toMatch(/^\//);
        expect(finding.lineNumber, name).toBeGreaterThan(0);
        expect(finding.body.length, name).toBeGreaterThan(0);
      }
    }
  });

  it("keeps bracketed route segments intact in the path", () => {
    // `app/api/projects/[projectId]/bugs/route.ts` defeats a naive
    // markdown-link regex, which truncates the path at `[projectId`.
    const paths = parseReviewReport(fixture("codex-cycle4.md")).map(
      (f) => f.filePath
    );
    expect(paths).toContain("app/api/projects/[projectId]/bugs/route.ts");
  });

  it("reads the severity vocabulary the reports actually use", () => {
    const cycle3 = parseReviewReport(fixture("codex-cycle3.md"));
    expect(cycle3.filter((f) => f.severity === "major")).toHaveLength(6);
    expect(cycle3.filter((f) => f.severity === "minor")).toHaveLength(1);
  });

  it("carries the finding title into the body", () => {
    const cycle4 = parseReviewReport(fixture("codex-cycle4.md"));
    const enterBug = cycle4.find((f) =>
      f.filePath.endsWith("BugCreateDialog.tsx")
    );
    expect(enterBug?.body).toContain("Créations de bug multiples via Entrée");
    // Description prose rides along so the builder gets the reasoning too.
    expect(enterBug?.body).toContain("submitting");
  });

  it("ignores checklist, verification and summary sections", () => {
    // Those blocks carry no `**Severity:**` row, which is the discriminator.
    const findings = parseReviewReport(fixture("codex-cycle4.md"));
    expect(findings.every((f) => !/Évaluation du checklist/.test(f.body))).toBe(
      true
    );
    expect(findings.every((f) => !/Overall Verdict/.test(f.body))).toBe(true);
  });
});

describe("parseReviewReport — shape tolerance", () => {
  it("returns nothing for empty or unstructured reports", () => {
    expect(parseReviewReport("")).toEqual([]);
    expect(parseReviewReport("   \n  ")).toEqual([]);
    expect(
      parseReviewReport("Looks good to me.\n\n**Overall Verdict: Approved**")
    ).toEqual([]);
  });

  it("skips a severity block with no usable location rather than guessing", () => {
    const report = [
      "### 1. Something is wrong",
      "",
      "- **Severity:** Major",
      "- **Description:** No location given.",
    ].join("\n");
    expect(parseReviewReport(report)).toEqual([]);
  });

  it("skips a located block with an unrecognized severity", () => {
    const report = [
      "### 1. Something is wrong",
      "",
      "- **Severity:** Catastrophic",
      "- **Location:** `lib/a.ts:3`",
    ].join("\n");
    expect(parseReviewReport(report)).toEqual([]);
  });

  it("maps Suggestion onto the schema's info severity", () => {
    const report = [
      "### 1. Consider renaming",
      "",
      "- **Severity:** Suggestion",
      "- **Location:** `lib/a.ts:3`",
    ].join("\n");
    expect(parseReviewReport(report)[0].severity).toBe("info");
  });

  it("caps an overlong body at the submit-findings limit", () => {
    const report = [
      "### 1. Verbose finding",
      "",
      "- **Severity:** Major",
      "- **Location:** `lib/a.ts:3`",
      `- **Description:** ${"x".repeat(5000)}`,
    ].join("\n");
    expect(parseReviewReport(report)[0].body.length).toBeLessThanOrEqual(2000);
  });

  it("accepts headings at any depth", () => {
    const report = [
      "#### Deeply nested finding",
      "- **Severity:** Critical",
      "- **Location:** `lib/a.ts:9`",
    ].join("\n");
    const findings = parseReviewReport(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });
});

describe("parseLocation", () => {
  it("prefers the relative label of a markdown link", () => {
    expect(
      parseLocation("[hooks/useImageAttachments.ts:92](/abs/worktree/hooks/useImageAttachments.ts:92)")
    ).toEqual({ filePath: "hooks/useImageAttachments.ts", lineNumber: 92 });
  });

  it("unwraps inline code", () => {
    expect(parseLocation("`components/kanban/EpicDetail.tsx:430`")).toEqual({
      filePath: "components/kanban/EpicDetail.tsx",
      lineNumber: 430,
    });
  });

  it("re-relativizes a bare absolute worktree path", () => {
    expect(
      parseLocation("/home/user/.arij-worktrees/feature-x/lib/db/schema.ts:58")
    ).toEqual({ filePath: "lib/db/schema.ts", lineNumber: 58 });
  });

  it("rejects a location with no line number", () => {
    expect(parseLocation("lib/db/schema.ts")).toBeNull();
    expect(parseLocation("`lib/db/schema.ts`")).toBeNull();
  });

  it("rejects a zero line number", () => {
    // submit-findings requires line >= 1; anchoring at 0 is not a location.
    expect(parseLocation("lib/db/schema.ts:0")).toBeNull();
  });
});
