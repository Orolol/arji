import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { VerificationReportSection } from "@/components/kanban/epic-detail/VerificationReportSection";
import type { VerificationReport } from "@/lib/verify/verify-constants";

const passingReport: VerificationReport = {
  id: "report-1",
  projectId: "project-1",
  epicId: "epic-1",
  agentSessionId: null,
  status: "pass",
  startedAt: "2026-08-25T12:00:00.000Z",
  finishedAt: "2026-08-25T12:00:02.000Z",
  commands: [
    {
      name: "test",
      command: "npm test",
      exitCode: 0,
      durationMs: 1_250,
      tail: "42 tests passed\n",
    },
    {
      name: "lint",
      command: "npm run lint",
      exitCode: 0,
      durationMs: 750,
      tail: "lint clean\n",
    },
  ],
};

function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 409) {
  return Promise.resolve({
    ok,
    status,
    json: async () => data,
  }) as Promise<Response>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("VerificationReportSection", () => {
  it("shows the latest report with a pass badge and expandable tail for every command", async () => {
    global.fetch = vi
      .fn()
      .mockImplementation(() => jsonResponse({ data: passingReport })) as unknown as typeof fetch;

    render(
      <VerificationReportSection
        projectId="project-1"
        epicId="epic-1"
        report={passingReport}
      />
    );

    expect(await screen.findByTestId("verification-report")).toBeInTheDocument();
    expect(screen.getByTestId("verification-command-test")).toHaveTextContent(
      "test"
    );
    expect(screen.getByTestId("verification-command-test")).toHaveTextContent(
      "PASS"
    );
    expect(screen.getByTestId("verification-command-lint")).toHaveTextContent(
      "PASS"
    );

    const outputSummary = screen.getByText("Output: test");
    const details = outputSummary.closest("details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(outputSummary);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText(/42 tests passed/)).toBeInTheDocument();
  });

  it("marks a failed command and keeps its error tail available", () => {
    const failingReport: VerificationReport = {
      ...passingReport,
      id: "report-fail",
      status: "fail",
      commands: [
        {
          name: "build",
          command: "npm run build",
          exitCode: 1,
          durationMs: 3_200,
          tail: "Type error in app/page.tsx",
        },
      ],
    };

    render(
      <VerificationReportSection
        projectId="project-1"
        epicId="epic-1"
        report={failingReport}
      />
    );

    expect(screen.getByTestId("verification-command-build")).toHaveTextContent(
      "FAIL"
    );
    expect(screen.getByText("Checks failed")).toBeInTheDocument();
    expect(screen.getByText(/Type error in app\/page.tsx/)).toBeInTheDocument();
  });

  it("runs verification manually and replaces the empty state with the returned report", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({ data: passingReport }));
    global.fetch = fetchMock as unknown as typeof fetch;

    function Subject() {
      const [report, setReport] = useState<VerificationReport | null>(null);
      return (
        <VerificationReportSection
          projectId="project-1"
          epicId="epic-1"
          report={report}
          onReportChange={setReport}
        />
      );
    }

    render(<Subject />);

    const runButton = await screen.findByRole("button", {
      name: "Run verification",
    });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/projects/project-1/epics/epic-1/verify",
        { method: "POST" }
      );
    });
    expect(await screen.findByTestId("verification-report")).toHaveTextContent(
      "All checks passed"
    );
  });

  it("surfaces the route's readable no-worktree error", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse(
          { error: "Verification requires an existing epic worktree." },
          false,
          409
        )
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(
      <VerificationReportSection projectId="project-1" epicId="epic-1" />
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Run verification" })
    );

    expect(
      await screen.findByText("Verification requires an existing epic worktree.")
    ).toBeInTheDocument();
  });
});
