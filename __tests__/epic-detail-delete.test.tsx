import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { EpicDetail } from "@/components/kanban/EpicDetail";

const mockUseEpicDetail = vi.hoisted(() => vi.fn());
const mockUseEpicComments = vi.hoisted(() => vi.fn());
const mockUseEpicAgent = vi.hoisted(() => vi.fn());
const mockUseEpicPr = vi.hoisted(() => vi.fn());
const mockUseGitHubConfig = vi.hoisted(() => vi.fn());
const mockUseGitStatus = vi.hoisted(() => vi.fn());
const mockUseCodexAvailable = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEpicDetail", () => ({
  useEpicDetail: (...args: unknown[]) => mockUseEpicDetail(...args),
}));

vi.mock("@/hooks/useEpicComments", () => ({
  useEpicComments: (...args: unknown[]) => mockUseEpicComments(...args),
}));

vi.mock("@/hooks/useEpicAgent", () => ({
  useEpicAgent: (...args: unknown[]) => mockUseEpicAgent(...args),
}));

vi.mock("@/hooks/useEpicPr", () => ({
  useEpicPr: (...args: unknown[]) => mockUseEpicPr(...args),
}));

vi.mock("@/hooks/useGitHubConfig", () => ({
  useGitHubConfig: (...args: unknown[]) => mockUseGitHubConfig(...args),
}));

vi.mock("@/hooks/useGitStatus", () => ({
  useGitStatus: (...args: unknown[]) => mockUseGitStatus(...args),
}));

vi.mock("@/hooks/useCodexAvailable", () => ({
  useCodexAvailable: (...args: unknown[]) => mockUseCodexAvailable(...args),
}));

vi.mock("@/components/epic/EpicActions", () => ({
  EpicActions: () => <div data-testid="epic-actions" />,
}));

vi.mock("@/components/epic/UserStoryQuickActions", () => ({
  UserStoryQuickActions: () => <div data-testid="story-quick-actions" />,
}));

vi.mock("@/components/story/CommentThread", () => ({
  CommentThread: () => <div data-testid="comment-thread" />,
}));

describe("EpicDetail delete flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUseEpicDetail.mockReturnValue({
      epic: {
        id: "epic-1",
        title: "Payments",
        description: "Epic details",
        priority: 1,
        status: "todo",
        branchName: null,
        prNumber: null,
        prUrl: null,
        prStatus: null,
        type: "feature",
        linkedEpicId: null,
        images: null,
      },
      userStories: [],
      loading: false,
      updateEpic: vi.fn(),
      addUserStory: vi.fn(),
      updateUserStory: vi.fn(),
      deleteUserStory: vi.fn(),
      refresh: vi.fn(),
      setPolling: vi.fn(),
    });
    mockUseEpicComments.mockReturnValue({
      comments: [],
      loading: false,
      addComment: vi.fn(),
    });
    mockUseEpicAgent.mockReturnValue({
      activeSession: null,
      dispatching: false,
      isRunning: false,
      sendToDev: vi.fn(),
      sendToReview: vi.fn(),
      resolveMerge: vi.fn(),
      approve: vi.fn(),
    });
    mockUseEpicPr.mockReturnValue({
      pr: null,
      loading: false,
      error: null,
      createPr: vi.fn(),
      syncPr: vi.fn(),
    });
    mockUseGitHubConfig.mockReturnValue({ isConfigured: false });
    mockUseGitStatus.mockReturnValue({
      ahead: 0,
      behind: 0,
      loading: false,
      error: null,
      refresh: vi.fn(),
      push: vi.fn(),
      pushing: false,
    });
    mockUseCodexAvailable.mockReturnValue({
      codexAvailable: true,
      codexInstalled: true,
    });
  });

  function renderSubject(overrides?: Partial<ComponentProps<typeof EpicDetail>>) {
    const onClose = vi.fn();
    const onDeleted = vi.fn();

    render(
      <EpicDetail
        projectId="proj-1"
        epicId="epic-1"
        open={true}
        onClose={onClose}
        onDeleted={onDeleted}
        {...overrides}
      />,
    );

    return { onClose, onDeleted };
  }

  it("shows confirmation dialog with irreversible warning", () => {
    renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Delete Epic" }));
    expect(screen.getByRole("heading", { name: "Delete Epic" })).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  it("submits exactly one delete request while in-flight", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch = vi.fn().mockReturnValue(fetchPromise) as unknown as typeof fetch;

    const { onClose, onDeleted } = renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Delete Epic" }));
    const confirmButton = screen.getByRole("button", { name: "Confirm Delete" });

    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(confirmButton).toBeDisabled();

    resolveFetch?.({
      ok: true,
      json: async () => ({ data: { deleted: true } }),
    });

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("shows backend error when delete fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Delete blocked by dependency" }),
    }) as unknown as typeof fetch;

    const { onClose, onDeleted } = renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Delete Epic" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

    await waitFor(() => {
      expect(screen.getByText("Delete blocked by dependency")).toBeInTheDocument();
    });
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
