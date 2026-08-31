/**
 * The five capabilities the frame-6a rewrite dropped, and the write paths that
 * never stopped existing behind them.
 *
 * Each test here is a regression guard for "the API still works, the UI to
 * reach it is gone": bug screenshots that can be uploaded but not viewed,
 * dependencies that can be stored but not edited, a story route with no link
 * into it, a grading dispatch with no button, and a transition log nothing
 * renders.
 *
 * The shadcn dropdown is replaced with an inline renderer, as in
 * `ticket-overlay.test.tsx`: Radix's popper cannot be driven from jsdom, and
 * what matters here is WHICH options exist and what clicking one sends.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

import { TicketOverlay } from "@/components/ticket/TicketOverlay";

const mockUseEpicDetail = vi.hoisted(() => vi.fn());
const mockUseTicketComments = vi.hoisted(() => vi.fn());
const mockUseAgentDispatch = vi.hoisted(() => vi.fn());
const mockUseEpicPr = vi.hoisted(() => vi.fn());
const mockUseGitHubConfig = vi.hoisted(() => vi.fn());
const mockUseEpicDependencies = vi.hoisted(() => vi.fn());
const mockUseProjectEpicsList = vi.hoisted(() => vi.fn());
const mockUseNamedAgentsList = vi.hoisted(() => vi.fn());
const mockUseEpicActivity = vi.hoisted(() => vi.fn());
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
vi.mock("@/hooks/useEpicActivity", () => ({
  useEpicActivity: (...args: unknown[]) => mockUseEpicActivity(...args),
}));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => ({ status: "connected", pollTick: 0 }),
}));
vi.mock("@/lib/agent-sessions/session-list", () => ({
  fetchUnifiedSessions: (...args: unknown[]) => mockFetchUnifiedSessions(...args),
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

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect?.()}
    >
      {children}
    </button>
  ),
}));

function epicFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "epic-1",
    title: "Streaming session logs over SSE",
    description: "Diffuser les logs de session en continu.",
    priority: 2,
    status: "review",
    branchName: null,
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
  };
}

let saveDependencies: ReturnType<typeof vi.fn>;
let sendToGrading: ReturnType<typeof vi.fn>;

function setEpic(
  overrides: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  mockUseEpicDetail.mockReturnValue({
    epic: epicFixture(overrides),
    userStories: [],
    loading: false,
    updateEpic: vi.fn().mockResolvedValue({ ok: true }),
    refresh: vi.fn(),
    setPolling: vi.fn(),
    gradingReport: null,
    ...extra,
  });
}

function renderSubject() {
  return render(
    <TicketOverlay projectId="proj-1" epicId="epic-1" open onClose={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.endsWith("/activity")
      ? { data: [] }
      : { data: { name: "Arij" } };
    return new Response(JSON.stringify(body), { status: 200 });
  });

  saveDependencies = vi.fn().mockResolvedValue(true);
  sendToGrading = vi.fn().mockResolvedValue({});

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
    sendToGrading,
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
    saving: false,
    error: null,
    saveDependencies,
  });
  mockUseProjectEpicsList.mockReturnValue({ epics: [] });
  mockUseNamedAgentsList.mockReturnValue({ agents: [] });
  mockUseEpicActivity.mockReturnValue({ entries: [], refresh: vi.fn() });
  mockFetchUnifiedSessions.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("bug screenshots", () => {
  const IMAGES = JSON.stringify([
    "data/uploads/proj-1/shot-a.png",
    "data/uploads/proj-1/shot-b.png",
  ]);

  it("renders the attached screenshots as thumbnails", () => {
    setEpic({ images: IMAGES });
    renderSubject();

    const block = screen.getByTestId("ticket-images");
    expect(within(block).getAllByRole("img")).toHaveLength(2);
    expect(within(block).getByRole("img", { name: "shot-a.png" })).toHaveAttribute(
      "src",
      "/api/projects/proj-1/uploads/shot-a.png",
    );
    // Plural label with two, so the kicker is not a lie.
    expect(within(block).getByText("Screenshots")).toBeInTheDocument();
  });

  it("opens one full size in the shared lightbox", () => {
    setEpic({ images: IMAGES });
    renderSubject();

    expect(screen.queryByTestId("image-lightbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open shot-b.png" }));
    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();
  });

  it("closes only the lightbox on Escape, never the ticket behind it", () => {
    const onClose = vi.fn();
    setEpic({ images: IMAGES });
    render(
      <TicketOverlay projectId="proj-1" epicId="epic-1" open onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open shot-a.png" }));
    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("image-lightbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hands Escape back to the ticket once the lightbox is gone", () => {
    const onClose = vi.fn();
    setEpic({ images: IMAGES });
    render(
      <TicketOverlay projectId="proj-1" epicId="epic-1" open onClose={onClose} />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for a ticket whose images column is unusable", () => {
    // Not this project's upload directory: the path is refused, not shown broken.
    setEpic({ images: JSON.stringify(["data/uploads/other-proj/x.png"]) });
    renderSubject();
    expect(screen.queryByTestId("ticket-images")).toBeNull();
  });

  it("still draws the description card for an image-only bug report", () => {
    setEpic({ images: IMAGES, description: null, priority: null, createdAt: null });
    renderSubject();
    expect(screen.getByTestId("ticket-description")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-images")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */

describe("dependency editing", () => {
  beforeEach(() => {
    mockUseProjectEpicsList.mockReturnValue({
      epics: [
        { id: "epic-1", readableId: "ARJ-122", title: "Self" },
        { id: "epic-2", readableId: "ARJ-9", title: "Session store" },
        { id: "epic-3", readableId: "ARJ-31", title: "Board export" },
      ],
    });
  });

  function editorMenu() {
    return within(screen.getByTestId("ticket-dependency-editor"));
  }

  it("offers every other ticket of the project, never this one", () => {
    renderSubject();
    const labels = editorMenu()
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(labels.some((text) => text?.includes("ARJ-9"))).toBe(true);
    expect(labels.some((text) => text?.includes("ARJ-31"))).toBe(true);
    expect(labels.some((text) => text?.includes("ARJ-122"))).toBe(false);
  });

  it("adds a WAITS ON edge through the write path the panel used to own", async () => {
    renderSubject();
    fireEvent.click(editorMenu().getByRole("menuitem", { name: /ARJ-9/ }));
    await waitFor(() =>
      expect(saveDependencies).toHaveBeenCalledWith(["epic-2"]),
    );
  });

  it("drops an edge the ticket already has, keeping the others", async () => {
    mockUseEpicDependencies.mockReturnValue({
      predecessors: [
        { id: "d1", ticketId: "epic-1", dependsOnTicketId: "epic-2" },
        { id: "d2", ticketId: "epic-1", dependsOnTicketId: "epic-3" },
      ],
      successors: [],
      saving: false,
      error: null,
      saveDependencies,
    });
    renderSubject();

    fireEvent.click(editorMenu().getByRole("menuitem", { name: /ARJ-9/ }));
    await waitFor(() =>
      expect(saveDependencies).toHaveBeenCalledWith(["epic-3"]),
    );
  });

  it("surfaces the route's refusal — a cycle — inside the band", () => {
    mockUseEpicDependencies.mockReturnValue({
      predecessors: [],
      successors: [],
      saving: false,
      error: "Dependency cycle detected",
      saveDependencies,
    });
    renderSubject();
    expect(screen.getByTestId("ticket-dependency-error")).toHaveTextContent(
      "Dependency cycle detected",
    );
  });

  it("disables the editor when the project has no other ticket", () => {
    mockUseProjectEpicsList.mockReturnValue({
      epics: [{ id: "epic-1", readableId: "ARJ-122", title: "Self" }],
    });
    renderSubject();
    expect(
      within(screen.getByTestId("ticket-dependency-editor")).getByRole("button", {
        name: /Edit/,
      }),
    ).toBeDisabled();
  });
});

/* ------------------------------------------------------------------ */

describe("story detail link", () => {
  it("links each story to the story surface, the route's only door", () => {
    setEpic({}, {
      userStories: [
        { id: "story-1", title: "First", status: "todo", acceptanceCriteria: null },
        { id: "story-2", title: "Second", status: "done", acceptanceCriteria: "a" },
      ],
    });
    renderSubject();

    const links = screen.getAllByTestId("ticket-story-link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/projects/proj-1/stories/story-1",
      "/projects/proj-1/stories/story-2",
    ]);
  });

  it("draws no link row when there are no stories", () => {
    renderSubject();
    expect(screen.queryAllByTestId("ticket-story-link")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("acceptance grading", () => {
  const REPORT = {
    id: "g1",
    epicId: "epic-1",
    agentSessionId: null,
    summary: "One criterion still missing evidence.",
    createdAt: null,
    gradings: [
      { storyId: "s1", criterion: "a", status: "met", evidence: "e" },
      { storyId: "s1", criterion: "b", status: "missed", evidence: "e" },
    ],
  };

  it("dispatches grading from the AGENTS band", async () => {
    renderSubject();
    fireEvent.click(screen.getByTestId("ticket-grade"));
    await waitFor(() => expect(sendToGrading).toHaveBeenCalledWith(null));
  });

  it("locks the grade action while a session owns the ticket", () => {
    mockUseAgentDispatch.mockReturnValue({
      activeSession: { id: "s1", status: "running" },
      dispatching: false,
      isRunning: true,
      sendToDev: vi.fn(),
      sendToReview: vi.fn(),
      sendToGrading,
      resolveMerge: vi.fn(),
      refreshSessions: vi.fn(),
    });
    renderSubject();
    expect(screen.getByTestId("ticket-grade")).toBeDisabled();
  });

  it("stamps the report's verdict, worst status winning", () => {
    setEpic({}, { gradingReport: REPORT });
    renderSubject();
    expect(screen.getByText("GRADED · MISSED")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-grading-summary")).toHaveTextContent(
      "One criterion still missing evidence.",
    );
  });

  it("stamps a clean pass when every criterion is met", () => {
    setEpic({}, {
      gradingReport: {
        ...REPORT,
        gradings: [{ storyId: "s1", criterion: "a", status: "met", evidence: "e" }],
      },
    });
    renderSubject();
    expect(screen.getByText("GRADED · MET")).toBeInTheDocument();
  });

  it("shows no stamp at all for an ungraded ticket — never a fabricated verdict", () => {
    renderSubject();
    expect(screen.queryByText(/^GRADED/)).toBeNull();
    expect(screen.queryByTestId("ticket-grading-summary")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("ticket activity in the agent band", () => {
  const transition = (
    id: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    projectId: "proj-1",
    epicId: "epic-1",
    fromStatus: "review",
    toStatus: "to_merge",
    actor: "user" as const,
    reason: null,
    sessionId: null,
    createdAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  });

  it("renders status transitions the session log never carried", async () => {
    mockUseEpicActivity.mockReturnValue({
      entries: [transition("a1")],
      refresh: vi.fn(),
    });
    renderSubject();

    const timeline = await screen.findByTestId("ticket-agent-timeline");
    expect(timeline).toHaveTextContent("you · Review → To Merge");
  });

  it("polls the transition log only while a session is live", () => {
    renderSubject();
    expect(mockUseEpicActivity).toHaveBeenLastCalledWith(
      "proj-1",
      "epic-1",
      false,
    );
  });

  it("expands a collapsed burst of automatic transitions in place", async () => {
    mockUseEpicActivity.mockReturnValue({
      entries: [
        transition("a1", { actor: "system" }),
        transition("a2", {
          actor: "system",
          fromStatus: "to_merge",
          toStatus: "done",
          createdAt: "2026-08-28T10:00:10.000Z",
        }),
      ],
      refresh: vi.fn(),
    });
    renderSubject();

    const group = await screen.findByTestId("ticket-activity-group");
    expect(group).toHaveTextContent("2 automatic transitions");
    expect(group).not.toHaveTextContent("To Merge → Done");

    fireEvent.click(screen.getByTestId("ticket-activity-group-toggle"));
    expect(group).toHaveTextContent("system · To Merge → Done");
  });

  it("keeps the band collapsed to its label line with nothing recorded", async () => {
    renderSubject();
    await waitFor(() => expect(mockFetchUnifiedSessions).toHaveBeenCalled());
    expect(screen.queryByTestId("ticket-agent-timeline")).toBeNull();
    expect(screen.getByText("What the agent is doing")).toBeInTheDocument();
  });
});
