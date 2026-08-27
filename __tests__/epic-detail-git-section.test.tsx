import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { EpicDetail } from "@/components/kanban/EpicDetail";
import { EpicGitSection } from "@/components/kanban/epic-detail/EpicGitSection";
import type { VerificationReport } from "@/lib/verify/verify-constants";
import type { MergeReadiness } from "@/lib/kanban/merge-readiness";
// Radix tooltips need a provider + hover to reveal their content; render the
// content inline instead so the freshness tooltip copy is directly assertable.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

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

vi.mock("@/components/shared/AgentActionsBar", () => ({
  AgentActionsBar: () => <div data-testid="epic-actions" />,
}));

vi.mock("@/components/epic/UserStoryQuickActions", () => ({
  UserStoryQuickActions: () => <div data-testid="story-quick-actions" />,
}));

vi.mock("@/components/story/CommentThread", () => ({
  CommentThread: () => <div data-testid="comment-thread" />,
}));

vi.mock("@/components/dependencies/DependencyEditor", () => ({
  DependencyEditor: () => <div data-testid="dependency-editor" />,
}));

vi.mock("@/components/review/DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));

const baseEpic = {
  id: "epic-1",
  title: "Payments",
  description: "Epic details",
  priority: 1,
  status: "review",
  branchName: "feature/payments",
  prNumber: null,
  prUrl: null,
  prStatus: null,
  type: "feature",
  linkedEpicId: null,
  images: null,
  readableId: null,
  mergeReadiness: null as MergeReadiness | null,
};
const mockAddUserStory = vi.fn();

function setupHooks(
  epicOverrides?: Partial<typeof baseEpic>,
  verificationReport: VerificationReport | null = null,
) {
  mockUseEpicDetail.mockReturnValue({
    epic: { ...baseEpic, ...epicOverrides },
    userStories: [
      {
        id: "us-1",
        epicId: "epic-1",
        title: "Checkout flow",
        description: null,
        acceptanceCriteria: null,
        status: "todo",
        position: 0,
        createdAt: "2026-01-01",
      },
    ],
    verificationReport,
    loading: false,
    updateEpic: vi.fn(),
    addUserStory: mockAddUserStory,
    updateUserStory: vi.fn(),
    deleteUserStory: vi.fn(),
    refresh: vi.fn(),
    setVerificationReport: vi.fn(),
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
  mockUseProvidersAvailable.mockReturnValue({
    codexAvailable: true,
    codexInstalled: true,
  });
}

function renderSubject(overrides?: Partial<ComponentProps<typeof EpicDetail>>) {
  const onClose = vi.fn();
  const onMerged = vi.fn();

  render(
    <EpicDetail
      projectId="proj-1"
      epicId="epic-1"
      open={true}
      onClose={onClose}
      onMerged={onMerged}
      {...overrides}
    />,
  );

  return { onClose, onMerged };
}

describe("EpicDetail git section", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAddUserStory.mockReset();
    setupHooks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;
  });

  it("shows the branch name and merge button for a review epic", () => {
    renderSubject();
    expect(screen.getByText("feature/payments")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Merge into main" }),
    ).toBeInTheDocument();
  });

  it("hides the git section when the epic has no branch", () => {
    setupHooks({ branchName: null as unknown as string });
    renderSubject();
    expect(
      screen.queryByRole("button", { name: "Merge into main" }),
    ).toBeNull();
  });

  it("hides the merge button outside review/done status", () => {
    setupHooks({ status: "in_progress" });
    renderSubject();
    expect(screen.getByText("feature/payments")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Merge into main" }),
    ).toBeNull();
  });

  it("renders the latest deterministic verification report in EpicDetail", () => {
    setupHooks(undefined, {
      id: "verify-1",
      projectId: "proj-1",
      epicId: "epic-1",
      agentSessionId: null,
      status: "fail",
      startedAt: "2026-08-25T12:00:00.000Z",
      finishedAt: "2026-08-25T12:00:01.000Z",
      commands: [
        {
          name: "test",
          command: "npm test",
          exitCode: 1,
          durationMs: 1_000,
          tail: "one regression failed",
        },
      ],
    });

    renderSubject();

    expect(screen.getByTestId("verification-report")).toHaveTextContent(
      "Checks failed"
    );
    expect(screen.getByTestId("verification-command-test")).toHaveTextContent(
      "FAIL"
    );
  });

  it("posts to the merge endpoint and closes on success", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/merge") && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { merged: true } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: [] }),
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { onClose, onMerged } = renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Merge into main" }));

    await waitFor(() => {
      expect(onMerged).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    const mergeCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/api/projects/proj-1/epics/epic-1/merge"),
    );
    expect(mergeCalls).toHaveLength(1);
  });

  it("shows the merge error, conflicted files, and resolve-with-agent button on conflict", async () => {
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/merge") && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          json: async () => ({
            error: "Merge conflict in main",
            reason: "conflict",
            conflictFiles: ["src/a.ts", "src/b.ts"],
            mergeFailed: true,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: [] }),
      });
    }) as unknown as typeof fetch;

    const { onClose, onMerged } = renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Merge into main" }));

    await waitFor(() => {
      expect(screen.getByText("Merge conflict in main")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "Resolve with Agent" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Conflicted files:/)).toBeInTheDocument();
    expect(screen.getByText(/src\/a\.ts, src\/b\.ts/)).toBeInTheDocument();
    expect(onMerged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the error but does not offer resolve-with-agent on generic 500 failure", async () => {
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/merge") && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          json: async () => ({
            error: "Git repository corrupted",
            reason: "error",
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: [] }),
      });
    }) as unknown as typeof fetch;

    renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Merge into main" }));

    await waitFor(() => {
      expect(screen.getByText("Git repository corrupted")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Resolve with Agent" }),
    ).toBeNull();
  });

  it("shows the error but does not offer resolve-with-agent on conflict-markers", async () => {
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/merge") && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          json: async () => ({
            error: "Unresolved conflict markers in branch",
            reason: "conflict-markers",
            mergeFailed: false,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: [] }),
      });
    }) as unknown as typeof fetch;

    renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Merge into main" }));

    await waitFor(() => {
      expect(
        screen.getByText("Unresolved conflict markers in branch"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Resolve with Agent" }),
    ).toBeNull();
  });
  it("shows merge conflict error and resolve-with-agent button on initial load when merge conflict is persisted", () => {
    setupHooks({
      status: "review",
      mergeReadiness: {
        ready: false,
        blocker: "merge_conflict",
        openFindings: 0,
      },
    });

    renderSubject();

    expect(
      screen.getByText("Merge conflict — resolve before merging"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resolve with Agent" }),
    ).toBeInTheDocument();
  });

  it("threads fetch freshness from useGitStatus into the git section", () => {
    mockUseGitHubConfig.mockReturnValue({ isConfigured: true });
    mockUseGitStatus.mockReturnValue({
      ahead: 0,
      behind: 0,
      lastFetchedAt: Date.now() - 3 * 60 * 1000,
      lastFetchError: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
      push: vi.fn(),
      pushing: false,
    });
    renderSubject();
    expect(screen.getByText(/^Synced /)).toBeInTheDocument();
    const tooltips = screen.getAllByTestId("tooltip-content");
    expect(
      tooltips.some((tooltip) =>
        tooltip.textContent?.includes("Last successful fetch from the remote"),
      ),
    ).toBe(true);
  });
});

describe("EpicGitSection fetch freshness", () => {
  const baseProps: ComponentProps<typeof EpicGitSection> = {
    projectId: "proj-1",
    branchName: "feature/payments",
    epicStatus: "in_progress",
    githubConfigured: true,
    isRunning: false,
    ahead: 1,
    behind: 2,
    gitStatusLoading: false,
    gitStatusError: null,
    onRefreshGitStatus: vi.fn(),
    onPush: vi.fn(),
    pushing: false,
    pr: null,
    prLoading: false,
    prError: null,
    onCreatePr: vi.fn(),
    onSyncPr: vi.fn(),
    merging: false,
    mergeError: null,
    onMerge: vi.fn(),
    resolvingMerge: false,
    onOpenResolveMerge: vi.fn(),
  };

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;
  });

  it('shows "Synced Xm ago" next to the ahead/behind counters', () => {
    render(
      <EpicGitSection
        {...baseProps}
        lastFetchedAt={Date.now() - 3 * 60 * 1000}
        lastFetchError={null}
      />,
    );

    expect(screen.getByText("Synced 3m ago")).toBeInTheDocument();
    expect(
      screen.getByText("Last successful fetch from the remote"),
    ).toBeInTheDocument();
  });

  it("renders no freshness label when the API reported nothing", () => {
    render(<EpicGitSection {...baseProps} />);

    expect(screen.queryByText(/^Synced /)).toBeNull();
    expect(screen.queryByText("Never synced")).toBeNull();
  });

  it("tooltips the fetch error and falls back to Never synced", () => {
    render(
      <EpicGitSection
        {...baseProps}
        lastFetchedAt={null}
        lastFetchError="network unreachable"
      />,
    );

    expect(screen.getByText("Never synced")).toBeInTheDocument();
    expect(
      screen.getByText("Could not fetch from remote: network unreachable"),
    ).toBeInTheDocument();
  });

  it("keeps the last known sync time when a later fetch fails", () => {
    render(
      <EpicGitSection
        {...baseProps}
        lastFetchedAt={Date.now() - 2 * 60 * 60 * 1000}
        lastFetchError="network unreachable"
      />,
    );

    expect(screen.getByText("Synced 2h ago")).toBeInTheDocument();
    expect(
      screen.getByText("Could not fetch from remote: network unreachable"),
    ).toBeInTheDocument();
  });

  it("hides the freshness label while the status is loading", () => {
    render(
      <EpicGitSection
        {...baseProps}
        gitStatusLoading={true}
        lastFetchedAt={Date.now()}
      />,
    );

    expect(screen.getByText("Checking...")).toBeInTheDocument();
    expect(screen.queryByText(/^Synced /)).toBeNull();
  });
});

describe("EpicDetail user stories section", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAddUserStory.mockReset();
    setupHooks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;
  });

  it("lists user stories with a link to the story page", () => {
    renderSubject();
    expect(screen.getByText("User Stories (1)")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Checkout flow" });
    expect(link).toHaveAttribute("href", "/projects/proj-1/stories/us-1");
  });

  it("adds a trimmed user story on Enter and clears the input", () => {
    renderSubject();
    // The composer is revealed by the "Add a story" link in the 3a panel.
    fireEvent.click(screen.getByRole("button", { name: "Add a story" }));
    const input = screen.getByPlaceholderText("Add user story...");
    fireEvent.change(input, { target: { value: "  New story  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockAddUserStory).toHaveBeenCalledWith("New story");
    expect(input).toHaveValue("");
  });

  it("hides the user stories section for bug epics", () => {
    setupHooks({ type: "bug" });
    renderSubject();
    expect(screen.queryByText(/User Stories/)).toBeNull();
    expect(screen.queryByPlaceholderText("Add user story...")).toBeNull();
  });
});
