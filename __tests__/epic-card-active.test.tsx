import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock dnd-kit
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
      toString: () => null,
    },
  },
}));

import { EpicCard } from "@/components/kanban/EpicCard";

const baseEpic = {
  id: "epic-1",
  projectId: "proj-1",
  title: "Test Epic",
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
  it("renders without activity indicator by default", () => {
    render(<EpicCard epic={baseEpic} />);

    expect(screen.getByText("Test Epic")).toBeInTheDocument();
    expect(screen.queryByTestId("epic-activity-epic-1")).not.toBeInTheDocument();
  });

  it("renders activity indicator metadata for build action", () => {
    render(
      <EpicCard
        epic={baseEpic}
        view={{
          activity: {
            sessionId: "sess-1",
            actionType: "build",
            agentName: "Claude Code agent 123abc",
          },
        }}
      />
    );

    expect(screen.getByText("Test Epic")).toBeInTheDocument();
    const indicator = screen.getByTestId("epic-activity-epic-1");
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveAttribute(
      "aria-label",
      "Build active: Claude Code agent 123abc"
    );
    // The component uses a Tooltip (not a title attribute) for the full label
  });

  it("renders user story count", () => {
    render(<EpicCard epic={baseEpic} />);

    expect(screen.getByText("1/3 US")).toBeInTheDocument();
  });

  it("renders error badge when failedSession is provided and no active agent", () => {
    render(
      <EpicCard
        epic={baseEpic}
        view={{
          failedSession: {
            sessionId: "sess-fail-1",
            error: "Process exited with code 1",
            agentType: "build",
          },
        }}
      />
    );

    const errorBadge = screen.getByTestId("epic-error-epic-1");
    expect(errorBadge).toBeInTheDocument();
    // The failure line is the entry point to the detail (the session view).
    expect(errorBadge).toHaveAttribute(
      "aria-label",
      "Agent session failed — open session view for details"
    );
  });

  it("does not render error badge when activeAgentActivity is present even with failedSession", () => {
    render(
      <EpicCard
        epic={baseEpic}
        view={{
          failedSession: {
            sessionId: "sess-fail-1",
            error: "Process exited with code 1",
            agentType: "build",
          },
          activity: {
            sessionId: "sess-active-1",
            actionType: "build",
            agentName: "Claude Code agent abc123",
          },
        }}
      />
    );

    expect(screen.queryByTestId("epic-error-epic-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("epic-retry-epic-1")).not.toBeInTheDocument();
  });

  it("renders retry button and calls onRetryBuild when clicked", () => {
    const onRetry = vi.fn();

    render(
      <EpicCard
        epic={baseEpic}
        view={{
          failedSession: {
            sessionId: "sess-fail-1",
            error: "Process exited with code 1",
            agentType: "build",
          },
          onRetryBuild: onRetry,
        }}
      />
    );

    const retryBtn = screen.getByTestId("epic-retry-epic-1");
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).toHaveAttribute("aria-label", "Retry failed agent session");

    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not render retry button when onRetryBuild is not provided", () => {
    render(
      <EpicCard
        epic={baseEpic}
        view={{
          failedSession: {
            sessionId: "sess-fail-1",
            error: "Process exited with code 1",
            agentType: "build",
          },
        }}
      />
    );

    expect(screen.getByTestId("epic-error-epic-1")).toBeInTheDocument();
    expect(screen.queryByTestId("epic-retry-epic-1")).not.toBeInTheDocument();
  });
});
