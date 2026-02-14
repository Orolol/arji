import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { StartTechCheckDialog } from "@/components/qa/StartTechCheckDialog";
import { ReportDetail } from "@/components/qa/ReportDetail";

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="named-agent-select">NamedAgentSelect</div>,
}));

describe("StartTechCheckDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/qa/prompts") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: "prompt-1", name: "Security", prompt: "Check security" }],
            }),
        }) as Promise<Response>;
      }

      if (url.includes("/api/projects/proj-1/qa/check") && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { reportId: "report-1", sessionId: "session-1" },
            }),
        }) as Promise<Response>;
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }) as Promise<Response>;
    }) as typeof fetch;
  });

  it("starts a tech check and calls onStarted callback", async () => {
    const onStarted = vi.fn();

    render(
      <StartTechCheckDialog
        projectId="proj-1"
        open
        onOpenChange={vi.fn()}
        onStarted={onStarted}
      />,
    );

    const textarea = await screen.findByPlaceholderText("Add custom QA instructions...");
    fireEvent.change(textarea, { target: { value: "Focus on architecture." } });

    fireEvent.click(screen.getByRole("button", { name: "Start Tech Check" }));

    await waitFor(() => {
      expect(onStarted).toHaveBeenCalledWith({
        reportId: "report-1",
        sessionId: "session-1",
      });
    });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const startCall = calls.find((call) => String(call[0]).includes("/qa/check"));
    expect(startCall).toBeDefined();
    const body = JSON.parse(String((startCall?.[1] as RequestInit)?.body ?? "{}"));
    expect(body.customPrompt).toBe("Focus on architecture.");
  });
});

describe("ReportDetail", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/api/projects/proj-1/qa/reports/report-1") && !url.includes("create-epics")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                id: "report-1",
                projectId: "proj-1",
                status: "completed",
                summary: "Summary",
                reportContent: "## Findings\n\n- Item",
                createdAt: "2026-02-14T10:00:00.000Z",
                completedAt: "2026-02-14T10:05:00.000Z",
              },
            }),
        }) as Promise<Response>;
      }

      if (url.includes("/create-epics") && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { epics: [{ id: "epic-1", title: "Epic from QA" }] },
            }),
        }) as Promise<Response>;
      }

      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: "Unhandled request" }),
      }) as Promise<Response>;
    }) as typeof fetch;
  });

  it("renders report content and creates epics", async () => {
    const onCreateEpics = vi.fn();

    render(
      <ReportDetail
        projectId="proj-1"
        reportId="report-1"
        onCreateEpics={onCreateEpics}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Findings")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Epics From Report" }));

    await waitFor(() => {
      expect(onCreateEpics).toHaveBeenCalledWith([
        { id: "epic-1", title: "Epic from QA" },
      ]);
    });
  });
});
