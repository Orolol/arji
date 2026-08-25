import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RegressionReportBlock } from "@/components/verify/RegressionReportBlock";
import {
  formatRegressionReportComment,
  REGRESSION_REPORT_MARKER,
} from "@/lib/verify/regression-report";

vi.mock("@/components/chat/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}));

describe("RegressionReportBlock", () => {
  it("renders a passed regression report correctly", () => {
    const comment = formatRegressionReportComment({
      regression: {
        status: "passed",
        reason: null,
        testFiles: ["src/auth.test.ts", "src/login.spec.ts"],
        detail: null,
        checkedAt: "2026-08-25T12:00:00.000Z",
      },
    });

    render(<RegressionReportBlock content={comment} />);

    const block = screen.getByTestId("regression-report-block");
    expect(block).toBeInTheDocument();
    expect(screen.getByText(/PASSED/i)).toBeInTheDocument();
    expect(screen.getByText("src/auth.test.ts, src/login.spec.ts")).toBeInTheDocument();
    expect(screen.queryByText(/Reason:/i)).not.toBeInTheDocument();
  });

  it("renders a failed regression report with reason, test files, and command detail", () => {
    const comment = formatRegressionReportComment({
      regression: {
        status: "failed",
        reason: "test_fails_on_branch",
        testFiles: ["src/repro.test.ts"],
        detail: "Error: expected true to be false\n    at Test.run",
        checkedAt: "2026-08-25T12:00:00.000Z",
      },
    });

    render(<RegressionReportBlock content={comment} />);

    const block = screen.getByTestId("regression-report-block");
    expect(block).toBeInTheDocument();
    expect(screen.getByText(/FAILED/i)).toBeInTheDocument();
    expect(screen.getByText(/Reason:/i)).toBeInTheDocument();
    expect(screen.getByText(/the regression test fails on the branch/i)).toBeInTheDocument();
    expect(screen.getByText("src/repro.test.ts")).toBeInTheDocument();
    expect(screen.getByText(/Error: expected true to be false/i)).toBeInTheDocument();
  });

  it("renders 'none' when no test files were detected in a failure", () => {
    const comment = formatRegressionReportComment({
      regression: {
        status: "failed",
        reason: "no_test_in_diff",
        testFiles: [],
        detail: null,
        checkedAt: "2026-08-25T12:00:00.000Z",
      },
    });

    render(<RegressionReportBlock content={comment} />);

    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("delegates ordinary comments to MarkdownContent", () => {
    const comment = "This is a regular comment by a developer.";

    render(<RegressionReportBlock content={comment} />);

    expect(screen.queryByTestId("regression-report-block")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-content")).toHaveTextContent(
      "This is a regular comment by a developer."
    );
  });

  it("delegates malformed regression reports to MarkdownContent without crashing", () => {
    const malformed = `${REGRESSION_REPORT_MARKER}\n\`\`\`json\n{ invalid json\n\`\`\``;

    render(<RegressionReportBlock content={malformed} />);

    expect(screen.queryByTestId("regression-report-block")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-content")).toBeInTheDocument();
  });
});
