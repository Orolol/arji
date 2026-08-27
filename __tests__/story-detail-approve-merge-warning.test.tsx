import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPush = vi.hoisted(() => vi.fn());
const mockUseStoryDetail = vi.hoisted(() => vi.fn());
const mockUseTicketComments = vi.hoisted(() => vi.fn());
const mockUseAgentDispatch = vi.hoisted(() => vi.fn());
const mockUseProvidersAvailable = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useParams: () => ({
    projectId: "proj-1",
    storyId: "story-1",
  }),
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock("@/hooks/useStoryDetail", () => ({
  useStoryDetail: (...args: unknown[]) => mockUseStoryDetail(...args),
}));

vi.mock("@/hooks/useTicketComments", () => ({
  useTicketComments: (...args: unknown[]) => mockUseTicketComments(...args),
}));

vi.mock("@/hooks/useAgentDispatch", () => ({
  useAgentDispatch: (...args: unknown[]) => mockUseAgentDispatch(...args),
}));

vi.mock("@/hooks/useProvidersAvailable", () => ({
  useProvidersAvailable: (...args: unknown[]) => mockUseProvidersAvailable(...args),
}));

vi.mock("@/components/story/StoryDetailPanel", () => ({
  StoryDetailPanel: () => <div data-testid="story-detail-panel" />,
}));

vi.mock("@/components/story/CommentThread", () => ({
  CommentThread: () => <div data-testid="comment-thread" />,
}));

// Mirror the real bar's completion pathway: rejections from onComplete are
// caught and routed to onActionError.
vi.mock("@/components/shared/AgentActionsBar", () => ({
  AgentActionsBar: ({
    onComplete,
    onActionError,
  }: {
    onComplete: () => Promise<unknown>;
    onActionError?: (error: unknown) => void;
  }) => (
    <button
      data-testid="mock-approve"
      onClick={() => {
        Promise.resolve(onComplete()).catch((error) => onActionError?.(error));
      }}
    >
      Approve
    </button>
  ),
}));

import StoryDetailPage from "@/app/projects/[projectId]/stories/[storyId]/page";

describe("Story detail approve reporting", () => {
  const merge = vi.fn();
  const refresh = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockClear();
    merge.mockReset();
    refresh.mockClear();
    mockUseStoryDetail.mockReturnValue({
      story: {
        id: "story-1",
        epicId: "epic-1",
        title: "Story title",
        description: "Story description",
        acceptanceCriteria: "- [ ] done",
        status: "review",
        position: 0,
        createdAt: new Date().toISOString(),
        epic: {
          id: "epic-1",
          title: "Epic title",
          description: "Epic description",
          status: "review",
          branchName: "epic/epic-1",
          projectId: "proj-1",
        },
      },
      loading: false,
      updateStory: vi.fn(),
      refresh,
    });
    mockUseTicketComments.mockReturnValue({
      comments: [],
      loading: false,
      addComment: vi.fn(),
    });
    mockUseAgentDispatch.mockReturnValue({
      activeSession: null,
      dispatching: false,
      isRunning: false,
      sendToDev: vi.fn(),
      sendToReview: vi.fn(),
      merge,
    });
    mockUseProvidersAvailable.mockReturnValue({
      codexAvailable: true,
      codexInstalled: true,
    });
  });

  it("refreshes after a clean approve without any merge warning", async () => {
    // Story approval closes the story only — `merged: false` with
    // `epicComplete: true` is the normal last-story response (the epic
    // closes through its own merge), never something to warn about.
    merge.mockResolvedValue({
      approved: true,
      epicComplete: true,
      merged: false,
    });

    render(<StoryDetailPage />);
    fireEvent.click(screen.getByTestId("mock-approve"));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    expect(screen.queryByText(/merge failed/i)).not.toBeInTheDocument();
  });

  it("shows a toast when approve rejects", async () => {
    merge.mockRejectedValue(new Error("Approve failed: story is not in review"));

    render(<StoryDetailPage />);
    fireEvent.click(screen.getByTestId("mock-approve"));

    await waitFor(() => {
      expect(
        screen.getByText("Approve failed: story is not in review"),
      ).toBeInTheDocument();
    });
  });

  it("routes an agent-already-running rejection to a toast with the session link", async () => {
    const conflict = Object.assign(
      new Error("Another agent is already running for this story."),
      {
        code: "AGENT_ALREADY_RUNNING",
        activeSessionId: "sess-42",
      },
    );
    merge.mockRejectedValue(conflict);

    render(<StoryDetailPage />);
    fireEvent.click(screen.getByTestId("mock-approve"));

    await waitFor(() => {
      expect(
        screen.getByText("Another agent is already running for this story."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Open session")).toHaveAttribute(
      "href",
      "/projects/proj-1/sessions/sess-42",
    );
  });
});
