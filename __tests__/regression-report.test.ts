import { describe, it, expect } from "vitest";
import {
  REGRESSION_REPORT_MARKER,
  formatRegressionReportComment,
  parseRegressionReportComment,
  buildRegressionFixSection,
  regressionReasonLabel,
} from "@/lib/verify/regression-report";

/**
 * Wire-format coverage for the verify report: the persisted ticket comment
 * must round-trip through the parser (UI contract) and the fix prompt must
 * carry the exact normalized failure reason.
 */

const PASSED = {
  regression: {
    status: "passed" as const,
    reason: null,
    testFiles: ["src/bug.test.js"],
    detail: null,
    checkedAt: "2026-08-25T00:00:00.000Z",
  },
};

const FAILED = {
  regression: {
    status: "failed" as const,
    reason: "no_test_in_diff" as const,
    testFiles: [],
    detail: "the branch diff contains no file matching the project's test patterns",
    checkedAt: "2026-08-25T00:00:00.000Z",
  },
};

describe("format + parse round trip", () => {
  it("round-trips a passed report", () => {
    const comment = formatRegressionReportComment(PASSED);
    expect(comment.startsWith(REGRESSION_REPORT_MARKER)).toBe(true);
    expect(parseRegressionReportComment(comment)).toEqual(PASSED);
  });

  it("round-trips a failed report", () => {
    const comment = formatRegressionReportComment(FAILED);
    expect(parseRegressionReportComment(comment)).toEqual(FAILED);
  });


  it("returns null for plain comments and malformed payloads", () => {
    expect(parseRegressionReportComment("just a normal comment")).toBeNull();
    expect(parseRegressionReportComment(null)).toBeNull();
    expect(
      parseRegressionReportComment(
        `${REGRESSION_REPORT_MARKER}\n\`\`\`json\n{not json\n\`\`\``
      )
    ).toBeNull();
    // Structurally invalid: no regression object.
    expect(
      parseRegressionReportComment(
        `${REGRESSION_REPORT_MARKER}\n\`\`\`json\n{}\n\`\`\``
      )
    ).toBeNull();
  });
});

describe("buildRegressionFixSection", () => {
  it("injects the exact failure reason and detected files", () => {
    const section = buildRegressionFixSection({
      regression: {
        status: "failed",
        reason: "test_passes_on_base",
        testFiles: ["src/a.test.ts"],
        detail: null,
        checkedAt: "2026-08-25T00:00:00.000Z",
      },
    });

    expect(section).toContain(regressionReasonLabel("test_passes_on_base"));
    expect(section).toContain("`src/a.test.ts`");
    expect(section).toContain("**/*.test.*");
  });

  it("includes command output when present", () => {
    const section = buildRegressionFixSection(FAILED);
    expect(section).toContain(FAILED.regression.detail);
  });
});
