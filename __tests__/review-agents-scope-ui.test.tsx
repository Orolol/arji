import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const reviewHooks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

vi.mock("@/hooks/useAgentConfig", () => ({
  useReviewAgents: () => ({
    data: [
      {
        id: "shared-1",
        name: "Shared reviewer",
        systemPrompt: "Review every project.",
        scope: "global",
        source: "global",
        position: 0,
        isEnabled: 1,
        createdAt: null,
        updatedAt: null,
      },
      {
        id: "project-1",
        name: "Project reviewer",
        systemPrompt: "Review this project.",
        scope: "project-1",
        source: "project",
        position: 1,
        isEnabled: 1,
        createdAt: null,
        updatedAt: null,
      },
    ],
    loading: false,
    createAgent: reviewHooks.createAgent,
    updateAgent: reviewHooks.updateAgent,
    deleteAgent: reviewHooks.deleteAgent,
  }),
}));

import { ReviewAgentsTab } from "@/components/agent-config/ReviewAgentsTab";

beforeEach(() => {
  vi.clearAllMocks();
  reviewHooks.createAgent.mockResolvedValue(true);
  reviewHooks.updateAgent.mockResolvedValue(true);
  reviewHooks.deleteAgent.mockResolvedValue(true);
});

describe("review-agent scope UI", () => {
  it("labels inherited reviewers in user language and prevents project-level edits", () => {
    render(<ReviewAgentsTab scope="project" projectId="project-1" />);

    const sharedName = screen.getByDisplayValue("Shared reviewer") as HTMLInputElement;
    const sharedCard = sharedName.closest(".rounded-lg") as HTMLElement;
    expect(sharedName).toBeDisabled();
    expect(within(sharedCard).getByText("Shared across projects")).toBeTruthy();
    expect(within(sharedCard).queryByRole("button", { name: /Delete/i })).toBeNull();

    const projectName = screen.getByDisplayValue("Project reviewer") as HTMLInputElement;
    const projectCard = projectName.closest(".rounded-lg") as HTMLElement;
    expect(projectName).not.toBeDisabled();
    expect(within(projectCard).getByText("Editable here")).toBeTruthy();
    expect(within(projectCard).getByRole("button", { name: /Delete/i })).toBeTruthy();
  });

  it("shows a creation failure and lets a new user retry", async () => {
    reviewHooks.createAgent.mockResolvedValue(false);
    render(<ReviewAgentsTab scope="global" />);

    fireEvent.click(screen.getByRole("button", { name: /Add Review Agent/i }));
    fireEvent.change(
      screen.getByLabelText("Name", { selector: "#new-review-agent-name" }),
      { target: { value: "Security review" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Could not create this review agent/i,
    );
    expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled();
  });
});
