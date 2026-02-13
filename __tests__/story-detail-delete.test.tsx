import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPush = vi.hoisted(() => vi.fn());
const mockUseStoryDetail = vi.hoisted(() => vi.fn());
const mockUseComments = vi.hoisted(() => vi.fn());
const mockUseTicketAgent = vi.hoisted(() => vi.fn());
const mockUseCodexAvailable = vi.hoisted(() => vi.fn());

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

vi.mock("@/hooks/useComments", () => ({
  useComments: (...args: unknown[]) => mockUseComments(...args),
}));

vi.mock("@/hooks/useTicketAgent", () => ({
  useTicketAgent: (...args: unknown[]) => mockUseTicketAgent(...args),
}));

vi.mock("@/hooks/useCodexAvailable", () => ({
  useCodexAvailable: (...args: unknown[]) => mockUseCodexAvailable(...args),
}));

vi.mock("@/components/story/StoryDetailPanel", () => ({
  StoryDetailPanel: () => <div data-testid="story-detail-panel" />,
}));

vi.mock("@/components/story/CommentThread", () => ({
  CommentThread: () => <div data-testid="comment-thread" />,
}));

vi.mock("@/components/story/StoryActions", () => ({
  StoryActions: () => <div data-testid="story-actions" />,
}));

import StoryDetailPage from "@/app/projects/[projectId]/stories/[storyId]/page";

describe("Story detail delete flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockClear();
    mockUseStoryDetail.mockReturnValue({
      story: {
        id: "story-1",
        epicId: "epic-1",
        title: "Story title",
        description: "Story description",
        acceptanceCriteria: "- [ ] done",
        status: "todo",
        position: 0,
        createdAt: new Date().toISOString(),
        epic: {
          id: "epic-1",
          title: "Epic title",
          description: "Epic description",
          status: "todo",
          branchName: null,
          projectId: "proj-1",
        },
      },
      loading: false,
      updateStory: vi.fn(),
      refresh: vi.fn(),
    });
    mockUseComments.mockReturnValue({
      comments: [],
      loading: false,
      addComment: vi.fn(),
    });
    mockUseTicketAgent.mockReturnValue({
      activeSession: null,
      dispatching: false,
      isRunning: false,
      sendToDev: vi.fn(),
      sendToReview: vi.fn(),
      approve: vi.fn(),
    });
    mockUseCodexAvailable.mockReturnValue({
      codexAvailable: true,
      codexInstalled: true,
    });
  });

  it("opens confirmation dialog with irreversible warning", () => {
    render(<StoryDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Delete User Story" }));

    expect(
      screen.getByRole("heading", { name: "Delete User Story" }),
    ).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  it("submits one delete request and redirects on success", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch = vi.fn().mockReturnValue(fetchPromise) as unknown as typeof fetch;

    render(<StoryDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Delete User Story" }));
    const confirmButton = screen.getByRole("button", { name: "Confirm Delete" });

    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(confirmButton).toBeDisabled();

    resolveFetch?.({
      ok: true,
      json: async () => ({ data: { deleted: true, epicId: "epic-1" } }),
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/projects/proj-1?deleted=story");
    });
  });

  it("shows failure feedback when backend delete fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Failed to delete story: blocked" }),
    }) as unknown as typeof fetch;

    render(<StoryDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Delete User Story" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to delete story: blocked")).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });
});
