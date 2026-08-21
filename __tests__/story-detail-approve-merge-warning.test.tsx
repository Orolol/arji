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

// Mirror the real bar's approve pathway: rejections from onApprove are
// caught and routed to onActionError.
vi.mock("@/components/shared/AgentActionsBar", () => ({
  AgentActionsBar: ({
    onApprove,
    onActionError,
  }: {
    onApprove: () => Promise<unknown>;
    onActionError?: (error: unknown) => void;
  }) => (
    <button
      data-testid="mock-approve"
      onClick={() => {
        Promise.resolve(onApprove()).catch((error) => onActionError?.(error));
      }}
    >
      Approve
    </button>
  ),
}));

import StoryDetailPage from "@/app/projects/[projectId]/stories/[storyId]/page";

describe("Story detail approve merge reporting", () => {
  const approve = vi.fn();
  const refresh = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockClear();
    approve.mockReset();
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
      approve,
    });
    mockUseProvidersAvailable.mockReturnValue({
      codexAvailable: true,
      codexInstalled: true,
    });
  });

  it("surfaces mergeError from a successful approve response as a warning", async () => {
    // Story approved, epic complete, but the epic merge failed (HTTP 200).
    approve.mockResolvedValue({
      approved: true,
      epicComplete: true,
      merged: false,
      mergeError: "conflict in lib/foo.ts",
    });

    render(<StoryDetailPage />);
    fireEvent.click(screen.getByTestId("mock-approve"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Story approved, but the epic merge failed: conflict in lib/foo.ts",
        ),
      ).toBeInTheDocument();
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a toast when approve rejects", async () => {
    approve.mockRejectedValue(new Error("Approve failed: story is not in review"));

    render(<StoryDetailPage />);
    fireEvent.click(screen.getByTestId("mock-approve"));

    await waitFor(() => {
      expect(
        screen.getByText("Approve failed: story is not in review"),
      ).toBeInTheDocument();
    });
  });

  it("does not warn when the approve response merged cleanly", async () => {
    approve.mockResolvedValue({
      approved: true,
      epicComplete: true,
      merged: true,
      commitHash: "abc123",
    });

    render(<StoryDetailPage />);
    fireEvent.click(screen.getByTestId("mock-approve"));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    expect(screen.queryByText(/merge failed/i)).not.toBeInTheDocument();
  });
});
