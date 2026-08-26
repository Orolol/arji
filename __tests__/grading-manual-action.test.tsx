import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentActionsBar } from "@/components/shared/AgentActionsBar";

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="grading-agent-select" />,
}));
vi.mock("@/components/shared/SessionPicker", () => ({
  SessionPicker: () => null,
}));
vi.mock("@/components/documents/MentionTextarea", () => ({
  MentionTextarea: () => <textarea />,
}));

describe("manual acceptance grading action", () => {
  it("is available for review epics and dispatches the grading callback", async () => {
    const onSendToGrading = vi.fn(async () => undefined);
    render(
      <AgentActionsBar
        projectId="project-1"
        target={{
          kind: "epic",
          epic: { id: "epic-1", title: "Grading", status: "review" },
        }}
        dispatching={false}
        isRunning={false}
        onSendToDev={vi.fn(async () => undefined)}
        onSendToReview={vi.fn(async () => undefined)}
        onSendToGrading={onSendToGrading}
        onApprove={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Grade Criteria" }));
    expect(
      screen.getByRole("heading", { name: "Acceptance Criteria Grading" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run Grading" }));

    await waitFor(() => expect(onSendToGrading).toHaveBeenCalledWith(null));
  });
});
