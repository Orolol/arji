/**
 * Mark-as-read on open.
 *
 * This lives in the overlay, not in any caller, ON PURPOSE: it is what moves
 * the ticket's `ticket_read_cursors` row to now, clearing both the kanban
 * unread dot and the cross-project inbox badge. Owning it here means EVERY
 * path that opens a ticket clears the dot — the desk, the board, the inbox, a
 * deep link, a future command palette. If it moved to a caller, every new
 * entry point would have to remember it, and one of them would not.
 *
 * Ported from the deleted `epic-detail-mark-read.test.tsx`; the request shape
 * (`POST /api/inbox/read` with `{epicId}`) is unchanged, which is what keeps
 * the inbox route's own suites green.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";

import { TicketOverlay } from "@/components/ticket/TicketOverlay";

const mockUseEpicDetail = vi.hoisted(() => vi.fn());
const mockUseTicketComments = vi.hoisted(() => vi.fn());
const mockUseAgentDispatch = vi.hoisted(() => vi.fn());
const mockUseEpicPr = vi.hoisted(() => vi.fn());
const mockUseGitHubConfig = vi.hoisted(() => vi.fn());
const mockUseEpicDependencies = vi.hoisted(() => vi.fn());
const mockUseProjectEpicsList = vi.hoisted(() => vi.fn());
const mockUseNamedAgentsList = vi.hoisted(() => vi.fn());
const mockFetchUnifiedSessions = vi.hoisted(() => vi.fn());

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
  fetchUnifiedSessions: (...args: unknown[]) =>
    mockFetchUnifiedSessions(...args),
}));
vi.mock("@/components/review/DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));
vi.mock("@/components/shared/AgentDispatchDialog", () => ({
  AgentDispatchDialog: () => null,
}));
vi.mock("@/components/chat/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

describe("TicketOverlay mark-read on open", () => {
  // The spy is re-shaped per test (resolve, then reject); `any` keeps the
  // overload noise out of what these tests are actually about.
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    // A fresh Response per call — a body is readable once, and the overlay
    // opens several endpoints at a time.
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("/activity") ? { data: [] } : { data: { ok: true } }
        ),
        { status: 200 }
      )
    );

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
        readableId: "ARJ-1",
        createdAt: null,
        updatedAt: null,
      },
      userStories: [],
      loading: false,
      updateEpic: vi.fn(),
      refresh: vi.fn(),
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
    mockUseEpicDependencies.mockReturnValue({
      predecessors: [],
      successors: [],
    });
    mockUseProjectEpicsList.mockReturnValue({ epics: [] });
    mockUseNamedAgentsList.mockReturnValue({ agents: [] });
    mockFetchUnifiedSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderSubject(
    overrides?: Partial<ComponentProps<typeof TicketOverlay>>
  ) {
    return render(
      <TicketOverlay
        projectId="proj-1"
        epicId="epic-1"
        open
        onClose={vi.fn()}
        {...overrides}
      />
    );
  }

  function markReadCalls() {
    return fetchSpy.mock.calls.filter(
      ([url]: [string]) => url === "/api/inbox/read"
    );
  }

  it("POSTs /api/inbox/read for the epic when opened", async () => {
    renderSubject();

    await waitFor(() => {
      expect(markReadCalls()).toHaveLength(1);
    });
    expect(markReadCalls()[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ epicId: "epic-1" }),
    });
  });

  it("does not mark read when closed or without an epic", async () => {
    const { unmount } = renderSubject({ open: false });
    unmount();
    renderSubject({ epicId: null });

    await new Promise((r) => setTimeout(r, 20));
    expect(markReadCalls()).toHaveLength(0);
  });

  it("marks the new epic read when switching tickets while open", async () => {
    const { rerender } = renderSubject();
    await waitFor(() => expect(markReadCalls()).toHaveLength(1));

    rerender(
      <TicketOverlay
        projectId="proj-1"
        epicId="epic-2"
        open
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(markReadCalls()).toHaveLength(2));
    expect(markReadCalls()[1][1]).toMatchObject({
      body: JSON.stringify({ epicId: "epic-2" }),
    });
  });

  it("counts the comments on the conversation band, and hides the counter at zero", async () => {
    const empty = renderSubject();
    expect(empty.queryByText("2")).toBeNull();
    empty.unmount();

    mockUseTicketComments.mockReturnValue({
      comments: [
        {
          id: "c1",
          epicId: "epic-1",
          author: "agent",
          content: "one",
          agentSessionId: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: "c2",
          epicId: "epic-1",
          author: "user",
          content: "two",
          agentSessionId: null,
          createdAt: new Date().toISOString(),
        },
      ],
      loading: false,
      addComment: vi.fn(),
    });

    const withComments = renderSubject();
    expect(withComments.getByText("2")).toBeInTheDocument();
  });

  it("survives a failing mark-read call", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));

    const { getByTestId } = renderSubject();

    await new Promise((r) => setTimeout(r, 20));
    expect(getByTestId("epic-detail-panel")).toBeInTheDocument();
  });

  it("never renders the literal string the e2e board fixture forbids", () => {
    const { container } = renderSubject();
    // e2e/fixtures/board.ts asserts `Loading...` is absent from the panel.
    expect(container.textContent).not.toContain("Loading...");
  });
});
