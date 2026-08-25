import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketCommentContent } from "@/components/verify/TicketCommentContent";
import {
  formatRegressionReportComment,
  REGRESSION_REPORT_MARKER,
} from "@/lib/verify/regression-report";

vi.mock("@/components/chat/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}));

describe("TicketCommentContent", () => {
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

    render(<TicketCommentContent content={comment} />);

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

    render(<TicketCommentContent content={comment} />);

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

    render(<TicketCommentContent content={comment} />);

    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("delegates ordinary comments to MarkdownContent", () => {
    const comment = "This is a regular comment by a developer.";

    render(<TicketCommentContent content={comment} />);

    expect(screen.queryByTestId("regression-report-block")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-content")).toHaveTextContent(
      "This is a regular comment by a developer."
    );
  });

  it("keeps an agent's own prose when its comment quotes a regression report", () => {
    // Report comments are ordinary ticket comments and are replayed verbatim
    // into later prompts, so an agent quoting one back is reachable: only the
    // report region may be replaced by the block.
    const report = formatRegressionReportComment({
      regression: {
        status: "failed",
        reason: "test_passes_on_base",
        testFiles: ["src/repro.test.ts"],
        detail: null,
        checkedAt: "2026-08-25T12:00:00.000Z",
      },
    });
    const comment = `I re-read the gate verdict below.\n\n${report}\n\nRewriting the test so it actually reproduces the bug.`;

    render(<TicketCommentContent content={comment} />);

    expect(screen.getByTestId("regression-report-block")).toBeInTheDocument();
    const markdown = screen.getAllByTestId("markdown-content");
    const rendered = markdown.map((n) => n.textContent).join(" ");
    expect(rendered).toContain("I re-read the gate verdict below.");
    expect(rendered).toContain("Rewriting the test so it actually reproduces the bug.");
  });

  it("delegates malformed regression reports to MarkdownContent without crashing", () => {
    const malformed = `${REGRESSION_REPORT_MARKER}\n\`\`\`json\n{ invalid json\n\`\`\``;

    render(<TicketCommentContent content={malformed} />);

    expect(screen.queryByTestId("regression-report-block")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-content")).toBeInTheDocument();
  });
});
