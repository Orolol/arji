import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { EpicUserStoriesSection } from "@/components/kanban/epic-detail/EpicUserStoriesSection";
import { EpicCard } from "@/components/kanban/EpicCard";
import type { KanbanEpic } from "@/lib/types/kanban";

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="grading-evidence">{children}</span>
  ),
}));

vi.mock("@/components/epic/UserStoryQuickActions", () => ({
  UserStoryQuickActions: () => null,
}));

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
  CSS: { Transform: { toString: () => undefined } },
}));

const noop = vi.fn();

describe("acceptance grading badges", () => {
  it("shows one status per story criterion and exposes evidence on hover", () => {
    render(
      <EpicUserStoriesSection
        projectId="project-1"
        userStories={[
          {
            id: "story-1",
            title: "Outcome badges",
            status: "review",
            acceptanceCriteria:
              "- [ ] Detail shows each criterion\n- [ ] SSE refreshes badges",
          },
        ]}
        gradingReport={{
          id: "report-1",
          epicId: "epic-1",
          agentSessionId: "grader-1",
          summary: "One criterion remains.",
          createdAt: "2026-08-25T12:00:00.000Z",
          gradings: [
            {
              storyId: "story-1",
              criterion: "- [ ] Detail shows each criterion",
              status: "met",
              evidence: "EpicUserStoriesSection renders the rubric list.",
            },
            {
              storyId: "story-1",
              criterion: "SSE refreshes badges",
              status: "missed",
              evidence: "No completion refresh was wired.",
            },
          ],
        }}
        newStoryTitle=""
        onNewStoryTitleChange={noop}
        onAddStory={noop}
        onUpdateStory={noop}
        onDeleteStory={noop}
        onRefresh={noop}
        actionsLocked={false}
      />,
    );

    expect(screen.getByText("Detail shows each criterion")).toBeInTheDocument();
    expect(screen.getByLabelText("Met")).toBeInTheDocument();
    expect(screen.getByLabelText("Missed")).toBeInTheDocument();
    expect(screen.getByText("EpicUserStoriesSection renders the rubric list.")).toBeInTheDocument();
    expect(screen.getByText("No completion refresh was wired.")).toBeInTheDocument();
  });

  it("shows the latest aggregate state on the Kanban card", () => {
    const epic: KanbanEpic = {
      id: "epic-1",
      projectId: "project-1",
      title: "Structured grading",
      description: "Display the latest result.",
      priority: 1,
      status: "review",
      position: 0,
      branchName: null,
      prNumber: null,
      prUrl: null,
      prStatus: null,
      confidence: null,
      evidence: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      type: "feature",
      linkedEpicId: null,
      images: null,
      readableId: "E-1",
      releaseId: null,
      usCount: 1,
      usDone: 0,
      gradingStatus: "partial",
      gradingSummary: "One criterion is only partially demonstrated.",
    };

    render(<EpicCard epic={epic} />);

    expect(screen.getByTestId("epic-grading-epic-1")).toHaveTextContent(
      "Criteria partial",
    );
    expect(
      screen.getByText("One criterion is only partially demonstrated."),
    ).toBeInTheDocument();
  });
});
