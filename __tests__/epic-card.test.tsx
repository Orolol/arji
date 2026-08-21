import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EpicCard } from "@/components/kanban/EpicCard";
import type { KanbanEpicAgentActivity } from "@/lib/types/kanban";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

const baseEpic = {
  id: "epic-1",
  projectId: "proj-1",
  title: "Epic title",
  description: null,
  priority: 1,
  status: "todo",
  position: 0,
  branchName: null,
  prNumber: null,
  prUrl: null,
  prStatus: null,
  confidence: null,
  evidence: null,
  createdAt: "2026-02-12T00:00:00.000Z",
  updatedAt: "2026-02-12T00:00:00.000Z",
  usCount: 3,
  usDone: 1,
  type: "feature",
  linkedEpicId: null,
  images: null,
  readableId: null,
  releaseId: null,
};

describe("EpicCard", () => {
  function renderWithAction(actionType: KanbanEpicAgentActivity["actionType"]) {
    render(
      <EpicCard
        epic={baseEpic}
        view={{
          activity: {
            sessionId: "sess-123",
            actionType,
            agentName: "Codex agent abc123",
          },
        }}
      />
    );
  }

  it("renders build activity icon with accessible metadata", () => {
    renderWithAction("build");
    expect(
      screen.getByLabelText("Build active: Codex agent abc123")
    ).toBeInTheDocument();
    expect(screen.getByTestId("epic-activity-epic-1")).toBeInTheDocument();
  });

  it("renders review activity icon with accessible metadata", () => {
    renderWithAction("review");
    expect(
      screen.getByLabelText("Review active: Codex agent abc123")
    ).toBeInTheDocument();
  });

  it("renders merge activity icon with accessible metadata", () => {
    renderWithAction("merge");
    expect(
      screen.getByLabelText("Merge active: Codex agent abc123")
    ).toBeInTheDocument();
  });

  it("hides activity icon when there is no active agent action", () => {
    render(<EpicCard epic={baseEpic} />);
    expect(screen.queryByTestId("epic-activity-epic-1")).not.toBeInTheDocument();
  });

  it("renders unread AI indicator with accessibility label", () => {
    render(<EpicCard epic={baseEpic} view={{ unreadAi: true }} />);
    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();
    expect(screen.getByLabelText("Unread AI update")).toBeInTheDocument();
  });

  it("supports activity and unread indicators together with deterministic slots", () => {
    render(
      <EpicCard
        epic={baseEpic}
        view={{
          unreadAi: true,
          activity: {
            sessionId: "sess-123",
            actionType: "review",
            agentName: "Claude Code agent abc123",
          },
        }}
      />
    );

    expect(screen.getByTestId("epic-activity-epic-1")).toBeInTheDocument();
    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();
  });

  it("flags delivered epics that still have unfinished stories", () => {
    render(
      <EpicCard
        epic={{ ...baseEpic, status: "done", usCount: 4, usDone: 2 }}
      />
    );

    expect(
      screen.getByTestId("epic-incomplete-stories-epic-1")
    ).toHaveTextContent("2 stories left");
  });

  it("does not show the unfinished-story warning before delivery", () => {
    render(<EpicCard epic={{ ...baseEpic, usCount: 4, usDone: 2 }} />);
    expect(
      screen.queryByTestId("epic-incomplete-stories-epic-1")
    ).not.toBeInTheDocument();
  });
});
