/**
 * The overlay's GIT band and the two mutations that live beside it.
 *
 * `useEpicMutations` is deliberately NOT mocked here: its three subtleties are
 * exactly what this file exists to pin — a conflict signalled in either of two
 * response shapes, a `conflictFiles` list that stays undefined rather than
 * becoming empty, and the in-flight ref that makes a double-confirmed delete
 * fire one DELETE.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";

import { TicketOverlay } from "@/components/ticket/TicketOverlay";
import { AGENT_ALREADY_RUNNING_CODE } from "@/lib/agents/concurrency-shared";
import type { AgentRequestError } from "@/lib/agents/client-error";

const mockUseEpicDetail = vi.hoisted(() => vi.fn());
const mockUseTicketComments = vi.hoisted(() => vi.fn());
const mockUseAgentDispatch = vi.hoisted(() => vi.fn());
const mockUseEpicPr = vi.hoisted(() => vi.fn());
const mockUseGitHubConfig = vi.hoisted(() => vi.fn());
const mockUseEpicDependencies = vi.hoisted(() => vi.fn());
const mockUseProjectEpicsList = vi.hoisted(() => vi.fn());
const mockUseNamedAgentsList = vi.hoisted(() => vi.fn());
const mockFindUnifiedSession = vi.hoisted(() => vi.fn());

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
vi.mock("@/hooks/useEpicDependencies", () => ({
  useEpicDependencies: (...args: unknown[]) => mockUseEpicDependencies(...args),
}));
vi.mock("@/hooks/useProjectEpicsList", () => ({
  useProjectEpicsList: (...args: unknown[]) => mockUseProjectEpicsList(...args),
}));
vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: (...args: unknown[]) => mockUseNamedAgentsList(...args),
}));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => ({ status: "connected", pollTick: 0 }),
}));
vi.mock("@/lib/agent-sessions/session-list", () => ({
  findUnifiedSession: (...args: unknown[]) =>
    mockFindUnifiedSession(...args),
}));
vi.mock("@/components/review/DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));
vi.mock("@/components/chat/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/shared/AgentDispatchDialog", () => ({
  AgentDispatchDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: () => void;
  }) =>
    open ? (
      <button type="button" data-testid="dispatch-confirm" onClick={onConfirm}>
        Dispatch Agent
      </button>
    ) : null,
}));

/* ------------------------------------------------------------------ */

const DIFF_PAYLOAD = {
  data: {
    files: [
      {
        hunks: [
          { lines: [{ type: "add" }, { type: "add" }, { type: "del" }] },
        ],
      },
      { hunks: [{ lines: [{ type: "add" }] }] },
    ],
  },
};

type Route = { status?: number; body: unknown };

let routes: Array<[RegExp, (init?: RequestInit) => Route]>;
let fetchMock: ReturnType<typeof vi.fn>;
let refresh: ReturnType<typeof vi.fn>;
let resolveMerge: ReturnType<typeof vi.fn>;

function respond(url: string, init?: RequestInit): Route {
  for (const [pattern, handler] of routes) {
    if (pattern.test(url)) return handler(init);
  }
  return { body: { data: null } };
}

function setEpic(overrides: Record<string, unknown> = {}) {
  mockUseEpicDetail.mockReturnValue({
    epic: {
      id: "epic-1",
      title: "Streaming session logs over SSE",
      description: null,
      priority: 2,
      status: "to_merge",
      branchName: "arij/arj-122-sse-logs",
      prNumber: null,
      prUrl: null,
      prStatus: null,
      type: "feature",
      linkedEpicId: null,
      images: null,
      readableId: "ARJ-122",
      createdAt: null,
      updatedAt: null,
      ...overrides,
    },
    userStories: [],
    loading: false,
    updateEpic: vi.fn().mockResolvedValue({ ok: true }),
    refresh,
    setPolling: vi.fn(),
  });
}

function renderSubject(
  overrides?: Partial<ComponentProps<typeof TicketOverlay>>,
) {
  return render(
    <TicketOverlay
      projectId="proj-1"
      epicId="epic-1"
      open
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

function agentBusyError(withSessionUrl: boolean): AgentRequestError {
  const err = new Error(
    "An agent is already running on this ticket",
  ) as AgentRequestError;
  err.code = AGENT_ALREADY_RUNNING_CODE;
  err.activeSessionId = "sess-99";
  if (withSessionUrl) err.sessionUrl = "/projects/other/sessions/sess-99";
  return err;
}

beforeEach(() => {
  refresh = vi.fn();
  resolveMerge = vi.fn().mockResolvedValue({ clean: false });
  routes = [
    [/\/diff$/, () => ({ body: DIFF_PAYLOAD })],
    [/\/api\/projects\/proj-1$/, () => ({ body: { data: { name: "Arij" } } })],
  ];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const route = respond(String(url), init);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  setEpic();
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
    resolveMerge,
    refreshSessions: vi.fn(),
  });
  mockUseEpicPr.mockReturnValue({
    pr: null,
    loading: false,
    error: null,
    createPr: vi.fn(),
    syncPr: vi.fn(),
  });
  mockUseGitHubConfig.mockReturnValue({ isConfigured: false });
  mockUseEpicDependencies.mockReturnValue({ predecessors: [], successors: [] });
  mockUseProjectEpicsList.mockReturnValue({ epics: [] });
  mockUseNamedAgentsList.mockReturnValue({ agents: [] });
  mockFindUnifiedSession.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("GIT band", () => {
  it("shows the branch chip and the isolated-worktree tail", () => {
    renderSubject();
    expect(screen.getByText("arij/arj-122-sse-logs")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-diffstat")).toHaveTextContent(
      "isolated worktree",
    );
  });

  it("collapses the whole band to its label line without a branch", () => {
    setEpic({ branchName: null });
    renderSubject();

    expect(screen.getByText("Git")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-diffstat")).toBeNull();
    expect(screen.queryByTestId("ticket-open-diff")).toBeNull();
    expect(screen.queryByTestId("ticket-merge")).toBeNull();
  });

  it("shows em-dashes, never zeros, until the deferred diff resolves", async () => {
    renderSubject();
    // Before the deferred fetch lands.
    expect(screen.getByTestId("ticket-diffstat")).toHaveTextContent(
      "— · — files · isolated worktree",
    );
    await waitFor(() =>
      expect(screen.getByTestId("ticket-diffstat")).toHaveTextContent(
        "+3−1 · 2 files · isolated worktree",
      ),
    );
  });

  it("keeps the em-dashes when the diff route fails", async () => {
    routes.unshift([/\/diff$/, () => ({ status: 500, body: { error: "boom" } })]);
    renderSubject();

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/diff"))).toBe(
        true,
      ),
    );
    expect(screen.getByTestId("ticket-diffstat")).toHaveTextContent(
      "— · — files",
    );
    expect(screen.getByTestId("ticket-diffstat").textContent).not.toContain("0");
  });

  it("never fetches the expensive diff route without a branch", async () => {
    setEpic({ branchName: null });
    renderSubject();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith("/diff")),
    ).toBe(false);
  });

  it("hides Create PR until GitHub is configured", () => {
    const { unmount } = renderSubject();
    expect(screen.queryByTestId("ticket-create-pr")).toBeNull();
    // Diff is then the row's only button, which is fine.
    expect(screen.getByTestId("ticket-open-diff")).toBeInTheDocument();
    unmount();

    mockUseGitHubConfig.mockReturnValue({ isConfigured: true });
    renderSubject();
    expect(screen.getByTestId("ticket-create-pr")).toBeInTheDocument();
  });

  it("becomes a link to the PR once one exists", () => {
    mockUseGitHubConfig.mockReturnValue({ isConfigured: true });
    mockUseEpicPr.mockReturnValue({
      pr: { number: 42, url: "https://github.test/pr/42" },
      loading: false,
      error: null,
      createPr: vi.fn(),
      syncPr: vi.fn(),
    });
    renderSubject();

    const link = screen.getByTestId("ticket-pr-link");
    expect(link).toHaveTextContent("PR #42");
    expect(link).toHaveAttribute("href", "https://github.test/pr/42");
    expect(screen.getByTestId("ticket-sync-pr")).toBeInTheDocument();
  });

  it("swaps the body for the diff view and back", async () => {
    renderSubject();
    fireEvent.click(screen.getByTestId("ticket-open-diff"));
    expect(await screen.findByTestId("diff-viewer")).toBeInTheDocument();
    // The header stays pinned throughout.
    expect(screen.getByTestId("ticket-overlay-header")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("ticket-diff-back"));
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("merge", () => {
  it("refreshes on the success path and closes the overlay", async () => {
    routes.unshift([/\/merge$/, () => ({ body: { data: { merged: true } } })]);
    const onClose = vi.fn();
    const onMerged = vi.fn();
    renderSubject({ onClose, onMerged });

    fireEvent.click(screen.getByTestId("ticket-merge"));

    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Unconditionally, outside any branch.
    expect(refresh).toHaveBeenCalled();
  });

  it("refreshes on the failure path too, and keeps the overlay open", async () => {
    routes.unshift([
      /\/merge$/,
      () => ({ status: 409, body: { error: "Merge conflict with main" } }),
    ]);
    const onClose = vi.fn();
    renderSubject({ onClose });

    fireEvent.click(screen.getByTestId("ticket-merge"));

    await waitFor(() =>
      expect(screen.getByTestId("ticket-merge-error")).toHaveTextContent(
        "Merge conflict with main",
      ),
    );
    expect(refresh).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reads a conflict from reason:"conflict"', async () => {
    routes.unshift([
      /\/merge$/,
      () => ({
        status: 409,
        body: {
          error: "Merge conflict with main",
          reason: "conflict",
          conflictFiles: ["lib/tax/export.ts", "lib/tax/rates.ts"],
        },
      }),
    ]);
    renderSubject();

    fireEvent.click(screen.getByTestId("ticket-merge"));

    expect(await screen.findByText("CONFLICT")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-conflict-files")).toHaveTextContent(
      "lib/tax/export.ts, lib/tax/rates.ts",
    );
    expect(screen.getByTestId("ticket-resolve-merge")).toBeInTheDocument();
  });

  it("reads a conflict from mergeFailed:true as well — both shapes are live", async () => {
    routes.unshift([
      /\/merge$/,
      () => ({
        status: 409,
        body: { error: "Merge failed", mergeFailed: true },
      }),
    ]);
    renderSubject();

    fireEvent.click(screen.getByTestId("ticket-merge"));

    expect(await screen.findByText("CONFLICT")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-resolve-merge")).toBeInTheDocument();
    // No list is not an empty list: nothing is invented.
    expect(screen.queryByTestId("ticket-conflict-files")).toBeNull();
  });

  it("shows no Resolve affordance for a plain (non-conflict) failure", async () => {
    routes.unshift([
      /\/merge$/,
      () => ({ status: 500, body: { error: "Failed to merge" } }),
    ]);
    renderSubject();

    fireEvent.click(screen.getByTestId("ticket-merge"));

    await waitFor(() =>
      expect(screen.getByTestId("ticket-merge-error")).toBeInTheDocument(),
    );
    expect(screen.queryByText("CONFLICT")).toBeNull();
    expect(screen.queryByTestId("ticket-resolve-merge")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("resolve merge", () => {
  async function openResolveDialog() {
    routes.unshift([
      /\/merge$/,
      () => ({
        status: 409,
        body: { error: "Merge conflict with main", reason: "conflict" },
      }),
    ]);
    fireEvent.click(screen.getByTestId("ticket-merge"));
    const resolve = await screen.findByTestId("ticket-resolve-merge");
    fireEvent.click(resolve);
    return screen.findByTestId("dispatch-confirm");
  }

  it("closes the overlay when the agent resolved the conflict cleanly", async () => {
    resolveMerge.mockResolvedValue({ clean: true });
    const onClose = vi.fn();
    const onMerged = vi.fn();
    renderSubject({ onClose, onMerged });

    fireEvent.click(await openResolveDialog());

    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the stale merge error when a resolution is merely launched", async () => {
    resolveMerge.mockResolvedValue({ clean: false });
    renderSubject();

    fireEvent.click(await openResolveDialog());

    // A launched resolution is not an error state: the agent is on it now.
    await waitFor(() =>
      expect(screen.queryByTestId("ticket-merge-error")).toBeNull(),
    );
  });

  it("routes a 409 to onAgentConflict with the server's session url", async () => {
    resolveMerge.mockRejectedValue(agentBusyError(true));
    const onAgentConflict = vi.fn();
    renderSubject({ onAgentConflict });

    fireEvent.click(await openResolveDialog());

    await waitFor(() =>
      expect(onAgentConflict).toHaveBeenCalledWith({
        message: "An agent is already running on this ticket",
        sessionUrl: "/projects/other/sessions/sess-99",
      }),
    );
  });

  it("falls back to a built session url when the server omits one", async () => {
    resolveMerge.mockRejectedValue(agentBusyError(false));
    const onAgentConflict = vi.fn();
    renderSubject({ onAgentConflict });

    fireEvent.click(await openResolveDialog());

    await waitFor(() =>
      expect(onAgentConflict).toHaveBeenCalledWith({
        message: "An agent is already running on this ticket",
        sessionUrl: "/projects/proj-1/sessions/sess-99",
      }),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("delete", () => {
  function deleteCalls() {
    return fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url) === "/api/projects/proj-1/epics/epic-1" &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
  }

  it("confirms behind the permanent-delete dialog before deleting", async () => {
    routes.unshift([
      /\/epics\/epic-1$/,
      (init) =>
        init?.method === "DELETE"
          ? { body: { data: { deleted: true } } }
          : { body: { data: null } },
    ]);
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    renderSubject({ onDeleted, onClose });

    fireEvent.click(screen.getByText("Delete ticket"));
    expect(await screen.findByText("Delete Epic")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Permanently delete this epic and all related user stories.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(deleteCalls()).toHaveLength(1);
  });

  it("fires ONE DELETE for a double-clicked confirm", async () => {
    let resolveDelete: (() => void) | undefined;
    routes.unshift([
      /\/epics\/epic-1$/,
      (init) => {
        if (init?.method !== "DELETE") return { body: { data: null } };
        return { body: { data: { deleted: true } } };
      },
    ]);
    // Hold the first DELETE open so the second click lands while it is
    // in flight — the exact race `deleteInFlightRef` exists for.
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        String(url) === "/api/projects/proj-1/epics/epic-1" &&
        init?.method === "DELETE"
      ) {
        await new Promise<void>((r) => {
          resolveDelete = r;
        });
      }
      return original(url, init);
    });

    renderSubject();
    fireEvent.click(screen.getByText("Delete ticket"));
    const confirm = await screen.findByRole("button", {
      name: "Confirm Delete",
    });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(deleteCalls()).toHaveLength(1));

    resolveDelete?.();
    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
  });

  it("surfaces a delete failure without closing the overlay", async () => {
    routes.unshift([
      /\/epics\/epic-1$/,
      (init) =>
        init?.method === "DELETE"
          ? { status: 500, body: { error: "Failed to delete epic" } }
          : { body: { data: null } },
    ]);
    const onClose = vi.fn();
    renderSubject({ onClose });

    fireEvent.click(screen.getByText("Delete ticket"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm Delete" }),
    );

    expect(await screen.findByText("Failed to delete epic")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
