import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EpicCard } from "@/components/kanban/EpicCard";
import type { KanbanEpic } from "@/lib/types/kanban";

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

const epic: KanbanEpic = {
  id: "epic-1",
  projectId: "proj-1",
  title: "Epic title",
  description: "Some description",
  priority: 1,
  status: "in_progress",
  position: 0,
  branchName: "feature/x",
  prNumber: null,
  prUrl: null,
  prStatus: null,
  confidence: null,
  evidence: null,
  createdAt: "2026-02-12T00:00:00.000Z",
  updatedAt: "2026-02-12T00:00:00.000Z",
  usCount: 2,
  usDone: 0,
  type: "feature",
  linkedEpicId: null,
  images: null,
  readableId: "E-proj-003",
  releaseId: null,
} as KanbanEpic;

const fullError =
  "The agent session failed without any error message and without any output — the process exited (or was lost) without writing stderr or text. The full process capture is at /app/data/sessions/sess-fail/logs.json.";

describe("EpicCard — failed session signal (AC2)", () => {
  function renderFailedCard(onRetryBuild = vi.fn()) {
    return render(
      <EpicCard
        epic={epic}
        view={{
          failedSession: {
            sessionId: "sess-fail",
            error: fullError,
            agentType: "build",
          },
          onRetryBuild,
        }}
      />
    );
  }

  it("shows the full failure reason on the card, not a bare label", () => {
    renderFailedCard();

    const failureLine = screen.getByTestId("epic-error-epic-1");
    expect(failureLine).toBeInTheDocument();
    // The exact message from the session row — never "Agent error" alone.
    expect(failureLine.textContent).toContain("Session failed");
    expect(failureLine.textContent).toContain(
      "failed without any error message and without any output"
    );
  });

  it("keeps the complete text on hover (title) even though the visible line is clamped", () => {
    renderFailedCard();

    const failureLine = screen.getByTestId("epic-error-epic-1");
    expect(failureLine.getAttribute("title")).toBe(fullError);
  });

  it("is one click away from the session view: the failure line links to it", () => {
    renderFailedCard();

    const failureLine = screen.getByTestId("epic-error-epic-1");
    // The signal itself is the entry point to the detail.
    expect(failureLine.tagName).toBe("A");
    expect(failureLine.getAttribute("href")).toBe(
      "/projects/proj-1/sessions/sess-fail"
    );
  });

  it("still offers the explicit View log link and the retry action", () => {
    const onRetryBuild = vi.fn();
    renderFailedCard(onRetryBuild);

    const viewLog = screen.getByTestId("epic-view-log-epic-1");
    expect(viewLog.getAttribute("href")).toBe(
      "/projects/proj-1/sessions/sess-fail"
    );

    fireEvent.click(screen.getByTestId("epic-retry-epic-1"));
    expect(onRetryBuild).toHaveBeenCalledTimes(1);
  });
});