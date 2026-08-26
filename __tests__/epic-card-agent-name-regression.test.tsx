/**
 * Regression: EpicCard must show the named agent's name, not the provider label.
 * Bug: "On affiche le nom du provider au lieu du nom de l'agent"
 * The activity chip previously rendered providerLabel(provider) (e.g. "Oh My Pi")
 * instead of the resolved agentName (e.g. "Muse").
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => null } },
}));

import { EpicCard } from "@/components/kanban/EpicCard";

const baseEpic = {
  id: "epic-1",
  projectId: "proj-1",
  title: "Test Epic",
  description: null,
  priority: 1,
  status: "in_progress",
  position: 0,
  branchName: null,
  prNumber: null,
  prUrl: null,
  prStatus: null,
  confidence: null,
  evidence: null,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  usCount: 3,
  usDone: 1,
  type: "feature",
  linkedEpicId: null,
  images: null,
  readableId: null,
  releaseId: null,
} as const;

describe("EpicCard shows agent name not provider label", () => {
  it("displays the named agent name on the activity chip instead of the provider label", () => {
    render(
      <EpicCard
        epic={baseEpic}
        view={{
          activity: {
            sessionId: "sess-1",
            actionType: "build",
            agentName: "Muse",
            provider: "oh-my-pi",
          },
        }}
      />,
    );
    const indicator = screen.getByTestId("epic-activity-epic-1");
    // Must show the agent name
    expect(indicator).toHaveTextContent("Muse");
    // Must NOT show the provider label instead
    expect(indicator).not.toHaveTextContent("Oh My Pi");
    // The activity label ("Build") is still present
    expect(indicator).toHaveTextContent("Build");
  });

  it("falls back to agentName even when provider is claude-code", () => {
    render(
      <EpicCard
        epic={{ ...baseEpic, id: "epic-2" }}
        view={{
          activity: {
            sessionId: "sess-2",
            actionType: "review",
            agentName: "MyReviewer",
            provider: "claude-code",
          },
        }}
      />,
    );
    const indicator = screen.getByTestId("epic-activity-epic-2");
    expect(indicator).toHaveTextContent("MyReviewer");
    expect(indicator).not.toHaveTextContent("Claude Code");
  });
});
