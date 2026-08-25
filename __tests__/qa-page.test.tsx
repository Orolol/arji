import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

const navigation = vi.hoisted(() => ({
  query: "",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

vi.mock("@/hooks/useQaReports", () => ({
  useQaReports: () => ({
    reports: [
      {
        id: "report-default",
        projectId: "proj-1",
        status: "completed",
        agentSessionId: "session-default",
        namedAgentId: null,
        promptUsed: null,
        customPromptId: null,
        reportContent: "Default report",
        summary: "Default report",
        checkType: "tech_check",
        createdAt: "2026-08-25T09:00:00.000Z",
        completedAt: "2026-08-25T09:01:00.000Z",
      },
      {
        id: "report-linked",
        projectId: "proj-1",
        status: "completed",
        agentSessionId: "session-linked",
        namedAgentId: null,
        promptUsed: null,
        customPromptId: null,
        reportContent: "Linked report",
        summary: "Linked report",
        checkType: "failure_digest",
        createdAt: "2026-08-25T10:00:00.000Z",
        completedAt: "2026-08-25T10:01:00.000Z",
      },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/qa/ReportDetail", () => ({
  ReportDetail: ({ reportId }: { reportId: string | null }) => (
    <div data-testid="report-detail">{reportId}</div>
  ),
}));

vi.mock("@/components/qa/StartQaCheckDialog", () => ({
  StartQaCheckDialog: () => null,
}));

describe("QA report deep links", () => {
  beforeEach(() => {
    navigation.query = "reportId=report-linked&keep=1";
    navigation.replace.mockReset();
  });

  it("selects the linked report and consumes the transient query parameter", async () => {
    const { default: QAPage } = await import("@/app/projects/[projectId]/qa/page");
    render(<QAPage />);

    await waitFor(() => {
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      );
    });
    expect(navigation.replace).toHaveBeenCalledWith(
      "/projects/proj-1/qa?keep=1",
    );
  });

  it("handles a source link opened while the QA page is already mounted", async () => {
    navigation.query = "";
    const { default: QAPage } = await import("@/app/projects/[projectId]/qa/page");
    const { rerender } = render(<QAPage />);

    expect(screen.getByTestId("report-detail")).toHaveTextContent(
      "report-default",
    );

    navigation.query = "reportId=report-linked";
    rerender(<QAPage />);

    await waitFor(() => {
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      );
    });
    expect(navigation.replace).toHaveBeenCalledWith("/projects/proj-1/qa");
  });
});
