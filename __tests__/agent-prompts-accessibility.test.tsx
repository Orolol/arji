import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/useAgentConfig", () => ({
  useAgentPrompts: () => ({
    data: [
      {
        agentType: "build",
        systemPrompt: "Build the requested change.",
        source: "builtin",
        scope: "global",
      },
      {
        agentType: "chat",
        systemPrompt: "Help with the project.",
        source: "global",
        scope: "global",
      },
      {
        agentType: "ticket_build",
        systemPrompt: "Build this ticket.",
        source: "project",
        scope: "project-1",
      },
    ],
    loading: false,
    updatePrompt: vi.fn(async () => true),
    resetPrompt: vi.fn(async () => true),
  }),
}));

import { AgentPromptsTab } from "@/components/agent-config/AgentPromptsTab";

describe("advanced prompt settings", () => {
  it("translates storage sources into user-facing scope labels", () => {
    render(<AgentPromptsTab scope="project" projectId="project-1" />);

    expect(screen.getAllByText("Arij default").length).toBeGreaterThan(0);
    expect(screen.getByText("All projects")).toBeTruthy();
    expect(screen.getByText("This project")).toBeTruthy();
    expect(screen.queryByText(/^builtin$|^global$|^project$/)).toBeNull();
  });

  it("gives an expanded prompt a label, an explicit hint and disclosure semantics", () => {
    render(<AgentPromptsTab scope="global" />);

    const buildToggle = screen.getByRole("button", {
      name: /^Build Arij default$/i,
    });
    expect(buildToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(buildToggle);

    expect(buildToggle).toHaveAttribute("aria-expanded", "true");
    expect(buildToggle).toHaveAttribute("aria-controls", "agent-prompt-build-panel");
    expect(screen.getByLabelText("Instructions")).toBeTruthy();
    expect(
      screen.getByText(/current instructions already work; edit them only/i),
    ).toBeTruthy();
  });
});
