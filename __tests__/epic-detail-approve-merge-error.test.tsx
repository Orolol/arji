import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EpicDetail } from "@/components/kanban/EpicDetail";

const mockUseEpicDetail = vi.hoisted(() => vi.fn());
const mockUseTicketComments = vi.hoisted(() => vi.fn());
const mockUseAgentDispatch = vi.hoisted(() => vi.fn());
const mockUseEpicPr = vi.hoisted(() => vi.fn());
const mockUseGitHubConfig = vi.hoisted(() => vi.fn());
const mockUseGitStatus = vi.hoisted(() => vi.fn());
const mockUseProvidersAvailable = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEpicDetail", () => ({
  useEpicDetail: (...args: unknown[]) => mockUseEpicDetail(...args),
}));

vi.mock("@/hooks/useTicketComments", () => ({
  useTicketComments: (...args: unknown[]) => mockUseTicketComments(...args),
}));

vi.mock("@/hooks/useAgentDispatch", () => ({
  useAgentDispatch: (...args: unknown[]) => mockUseAgentDispatch(...args),
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

vi.mock("@/hooks/useProvidersAvailable", () => ({
  useProvidersAvailable: (...args: unknown[]) => mockUseProvidersAvailable(...args),
}));

// Expose the merge pathway directly: the real bar's completion action is the
// merge (the merge IS the approval), and it catches onComplete rejections
// into onActionError.
vi.mock("@/components/shared/AgentActionsBar", () => ({
  AgentActionsBar: ({
    onComplete,
    onActionError,
  }: {
    onComplete: () => Promise<unknown>;
    onActionError?: (error: unknown) => void;
  }) => (
    <button
      data-testid="mock-merge"
      onClick={() => {
        Promise.resolve(onComplete()).catch((error) => onActionError?.(error));
      }}
    >
      Merge
    </button>
  ),
}));

vi.mock("@/components/epic/UserStoryQuickActions", () => ({
  UserStoryQuickActions: () => <div data-testid="story-quick-actions" />,
}));

vi.mock("@/components/dependencies/DependencyEditor", () => ({
  DependencyEditor: () => <div data-testid="dependency-editor" />,
}));

vi.mock("@/components/kanban/epic-detail/WhatTheAgentDid", () => ({
  WhatTheAgentDid: () => <div data-testid="what-the-agent-did" />,
}));

const MERGE_FAILURE_MESSAGE =
  "Merge failed: conflict in lib/foo.ts. The ticket stays in to_merge — resolve the conflict (Resolve with Agent) and merge again.";

describe("EpicDetail merge failure", () => {
  const refresh = vi.fn();
  /** Per-test script for the POST .../merge endpoint. */
  let mergeResponses: Array<{ ok: boolean; status: number; body: unknown }>;

  beforeEach(() => {
    vi.restoreAllMocks();
    refresh.mockClear();
    mergeResponses = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/merge")) {
        const scripted = mergeResponses.shift() ?? {
          ok: true,
          status: 200,
          body: { data: { merged: true, commitHash: "abc" } },
        };
        return {
          ok: scripted.ok,
          status: scripted.status,
          json: async () => scripted.body,
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;

    mockUseEpicDetail.mockReturnValue({
      epic: {
        id: "epic-1",
        title: "Payments",
        description: "Epic details",
        priority: 1,
        // The merge is offered from the merge boundary.
        status: "to_merge",
        branchName: "epic/epic-1",
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
      refresh,
      setPolling: vi.fn(),
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
      sendToGrading: vi.fn(),
      resolveMerge: vi.fn(),
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
      lastFetchedAt: null,
      lastFetchError: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
      push: vi.fn(),
      pushing: false,
    });
    mockUseProvidersAvailable.mockReturnValue({
      codexAvailable: true,
      codexInstalled: true,
    });
  });

  function renderSubject() {
    render(
      <EpicDetail
        projectId="proj-1"
        epicId="epic-1"
        open={true}
        onClose={vi.fn()}
      />,
    );
  }

  it("shows the server's merge failure message and still refreshes", async () => {
    mergeResponses.push({
      ok: false,
      status: 409,
      body: {
        error: MERGE_FAILURE_MESSAGE,
        reason: "conflict",
        mergeFailed: true,
      },
    });

    renderSubject();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("mock-merge"));

    await waitFor(() => {
      expect(screen.getByText(MERGE_FAILURE_MESSAGE)).toBeInTheDocument();
    });
    // The epic stayed in to_merge server-side — the board must reflect reality.
    expect(refresh).toHaveBeenCalled();
  });

  it("clears a stale merge error when the merge succeeds", async () => {
    mergeResponses.push({
      ok: false,
      status: 409,
      body: {
        error: MERGE_FAILURE_MESSAGE,
        reason: "conflict",
        mergeFailed: true,
      },
    });

    renderSubject();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("mock-merge"));
    await waitFor(() => {
      expect(screen.getByText(MERGE_FAILURE_MESSAGE)).toBeInTheDocument();
    });

    // Next attempt lands (the scripted queue is empty, so the default
    // success response applies).
    await user.click(screen.getByTestId("mock-merge"));
    await waitFor(() => {
      expect(screen.queryByText(MERGE_FAILURE_MESSAGE)).not.toBeInTheDocument();
    });
  });
});
