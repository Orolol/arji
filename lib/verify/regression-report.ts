/**
 * Client-safe wire format for the bug-regression verify report
 * (lib/pipeline/verify.ts writes it, the ticket UI reads it).
 *
 * A verify report is persisted as an ordinary ticket comment whose content
 * starts with a stable HTML-comment marker followed by one fenced JSON
 * block. The marker keeps the payload invisible in any renderer that shows
 * raw markdown, and {@link parseRegressionReportComment} gives the UI a
 * typed read so it can render the dedicated red/green block instead of the
 * JSON blob. No db / server imports — same convention as
 * lib/verify/regression-constants.ts.
 */

import type { RegressionFailureReason } from "./regression-constants";

/** Stable prefix identifying a ticket comment as a regression report. */
export const REGRESSION_REPORT_MARKER = "<!-- arij:regression-report -->";

export interface RegressionReportPayload {
  regression: {
    status: "passed" | "failed";
    reason: RegressionFailureReason | null;
    testFiles: string[];
    /** Human-readable detail (command tail or why detection stopped). */
    detail?: string | null;
    checkedAt: string;
  };
}

const REPORT_REASON_LABELS: Record<RegressionFailureReason, string> = {
  no_test_in_diff:
    "no test file in the branch diff — write a test that reproduces the bug and commit it with the fix",
  test_fails_on_branch:
    "the regression test fails on the branch — the fix does not work yet",
  test_passes_on_base:
    "the test already passes without the fix — it does not reproduce the bug",
  command_error: "the regression command could not be executed",
};

export function regressionReasonLabel(
  reason: RegressionFailureReason | null
): string {
  return reason ? REPORT_REASON_LABELS[reason] : "";
}

/** Formats one regression-check result as the persisted ticket comment. */
export function formatRegressionReportComment(
  payload: RegressionReportPayload
): string {
  const { regression } = payload;
  const lines = [
    REGRESSION_REPORT_MARKER,
    "## Verify report — mandatory regression test (red → green)",
    "",
    regression.status === "passed"
      ? "**PASSED** — the branch's test files are green on the branch and red on the merge-base."
      : `**FAILED** — ${regressionReasonLabel(regression.reason ?? "command_error")}`,
    "",
    `- Test files detected: ${
      regression.testFiles.length > 0
        ? regression.testFiles.map((f) => `\`${f}\``).join(", ")
        : "none"
    }`,
    `- Checked at: ${regression.checkedAt}`,
  ];
  if (regression.detail) {
    lines.push("", "```", regression.detail.trim(), "```");
  }
  lines.push("", "```json");
  lines.push(JSON.stringify(payload, null, 2));
  lines.push("```");
  return lines.join("\n");
}

/**
 * Parses a ticket comment into its structured report, or null when the
 * comment is not a regression report.
 */
export function parseRegressionReportComment(
  content: string | null | undefined
): RegressionReportPayload | null {
  if (!content || !content.includes(REGRESSION_REPORT_MARKER)) return null;
  const fenceIndex = content.lastIndexOf("```json");
  if (fenceIndex === -1) return null;
  const start = content.indexOf("{", fenceIndex);
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object") return null;
    const r = (parsed as { regression?: unknown }).regression;
    if (!r || typeof r !== "object") return null;
    const { status, reason, testFiles, detail, checkedAt } = r as {
      status?: unknown;
      reason?: unknown;
      testFiles?: unknown;
      detail?: unknown;
      checkedAt?: unknown;
    };
    if (status !== "passed" && status !== "failed") return null;
    if (!Array.isArray(testFiles)) return null;

    const validReason =
      reason === "no_test_in_diff" ||
      reason === "test_passes_on_base" ||
      reason === "test_fails_on_branch" ||
      reason === "command_error" ||
      reason === null
        ? reason
        : null;

    if (status === "failed" && !validReason) return null;

    return {
      regression: {
        status,
        reason: status === "passed" ? null : validReason,
        testFiles: testFiles.filter((f): f is string => typeof f === "string"),
        detail: typeof detail === "string" ? detail : null,
        checkedAt:
          typeof checkedAt === "string" ? checkedAt : new Date().toISOString(),
      },
    };
  } catch {
    // Malformed payload — treat as a plain comment.
  }
  return null;
}
/**
 * Prompt section appended to a fix dispatch after a failed regression
 * gate — the exact failure reason, verbatim, so the agent repairs the real
 * problem instead of guessing.
 */
export function buildRegressionFixSection(payload: RegressionReportPayload): string {
  const { regression } = payload;
  const files =
    regression.testFiles.length > 0
      ? regression.testFiles.map((f) => `- \`${f}\``).join("\n")
      : "- (none detected)";
  return `## Mandatory regression test failed (red → green rule)

The mechanical regression gate rejected this bug-fix branch:

**Reason:** ${regressionReasonLabel(regression.reason ?? "command_error")}

Test files detected on the branch:
${files}
${regression.detail ? `\nCommand output:\n\n\`\`\`\n${regression.detail.trim().slice(0, 2000)}\n\`\`\`\n` : ""}
Fix the branch so that:
1. Its diff contains at least one test file matching the project's test patterns (\`**/*.test.*\`, \`**/*.spec.*\`, \`**/__tests__/**\` by default);
2. That test PASSES on the branch (with your fix applied);
3. That test FAILS when only the test file is applied without your fix — i.e. it genuinely reproduces the bug.

Commit the test file(s) together with the fix.`;
}
