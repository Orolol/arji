/**
 * The frame-6a ticket overlay: header, the workflow-aware status control,
 * derived-state reset, the polling gate, the non-live collapse, and the three
 * equivalent ways to close.
 *
 * The shadcn dropdown is replaced with an inline renderer: Radix's popper
 * cannot be driven from jsdom, and what these tests are about is WHICH
 * options exist and how they are labelled — not the portal.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";

import { TicketOverlay } from "@/components/ticket/TicketOverlay";
import {
  REASON_MERGE_REQUIRED,
  REASON_RELEASED_SYSTEM_ONLY,
  REASON_SESSION_RUNNING,
} from "@/lib/kanban/status-transitions";

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
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    title,
    onSelect,
  }: {
    children: ReactNode;
    disabled?: boolean;
    title?: string;
    onSelect?: () => void;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={() => onSelect?.()}
    >
      {children}
    </button>
  ),
}));

const RUNNING_SESSION = {
  id: "sess-a41f2c",
  epicId: "epic-1",
  userStoryId: null,
  status: "running",
  type: "build",
  mode: "build",
  label: "running vitest — 34/61 passed",
  namedAgentName: "Opus Builder",
  startedAt: new Date(Date.now() - 252_000).toISOString(),
  cancellable: true,
};

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

let updateEpic: ReturnType<typeof vi.fn>;
let setPolling: ReturnType<typeof vi.fn>;

function setEpic(overrides: Record<string, unknown> = {}, stories: unknown[] = []) {
  mockUseEpicDetail.mockReturnValue({
    epic: epicFixture(overrides),
    userStories: stories,
    loading: false,
    updateEpic,
    refresh: vi.fn(),
    setPolling,
  });
}

function setDispatch(overrides: Record<string, unknown> = {}) {
  mockUseAgentDispatch.mockReturnValue({
    activeSession: null,
    dispatching: false,
    isRunning: false,
    sendToDev: vi.fn(),
    sendToReview: vi.fn(),
    resolveMerge: vi.fn(),
    refreshSessions: vi.fn(),
    ...overrides,
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

/** The status pill's own menu, isolated from the AGENTS band's. */
function statusMenu() {
  return within(screen.getByTestId("ticket-status-control"));
}

beforeEach(() => {
  // A FRESH Response per call, never one shared instance: a Response body can
  // only be read once, and the overlay reads several endpoints on open (the
  // project, the transition log, …). Sharing one made whichever consumer came
  // second silently see a spent body.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.endsWith("/activity")
      ? { data: [] }
      : { data: { name: "Arij" } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  updateEpic = vi.fn().mockResolvedValue({ ok: true });
  setPolling = vi.fn();
  setEpic();
  mockUseTicketComments.mockReturnValue({
    comments: [],
    loading: false,
    addComment: vi.fn(),
  });
  setDispatch();
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
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("TicketOverlay header", () => {
  it("shows the project and ticket chips and the title", async () => {
    renderSubject();
    await waitFor(() => expect(screen.getByText("ARIJ")).toBeInTheDocument());
    expect(screen.getByText("ARJ-122")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Streaming session logs over SSE" }),
    ).toBeInTheDocument();
  });

  it("falls back to the id tail when the ticket has no readable id", () => {
    setEpic({ readableId: null, id: "abcdef123456" });
    renderSubject({ epicId: "abcdef123456" });
    expect(screen.getByText("123456")).toBeInTheDocument();
  });

  it("renders the LIVE stamp, the chrono and Stop only while a session runs", () => {
    setDispatch({ activeSession: RUNNING_SESSION, isRunning: true });
    const { container } = renderSubject();

    expect(screen.getByText("LIVE · BUILD")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="chrono"]')).not.toBeNull();
    expect(screen.getByTestId("ticket-overlay-stop")).toBeInTheDocument();
  });

  it("omits the stamp, the chrono and Stop when nothing is running", () => {
    const { container } = renderSubject();

    expect(container.querySelector('[data-slot="stamp"]')).toBeNull();
    expect(container.querySelector('[data-slot="chrono"]')).toBeNull();
    expect(screen.queryByTestId("ticket-overlay-stop")).toBeNull();
    // And no "0s" placeholder in its place.
    expect(container.textContent).not.toMatch(/\b0s\b/);
  });

  it("hides Stop for a session the server says cannot be cancelled", () => {
    setDispatch({
      activeSession: { ...RUNNING_SESSION, cancellable: false },
      isRunning: true,
    });
    renderSubject();

    expect(screen.getByText("LIVE · BUILD")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-overlay-stop")).toBeNull();
  });

  it("reads the agent action through the three-way session-shape fallback", () => {
    setDispatch({
      // No `type`: the legacy/registry shape only carries `mode`.
      activeSession: { ...RUNNING_SESSION, type: undefined, mode: "merge" },
      isRunning: true,
    });
    renderSubject();
    expect(screen.getByText("LIVE · MERGE")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */

describe("TicketOverlay status control", () => {
  it("shows the BARE column label in the closed trigger, never '(current)'", () => {
    renderSubject();
    // Regression guard for the Radix SelectValue portal bug: the items carry
    // a "(current)" marker, and the trigger must not inherit it.
    const trigger = statusMenu().getAllByRole("button")[0];
    expect(trigger).toHaveTextContent("Review");
    expect(trigger.textContent).not.toContain("(current)");
  });

  it("renders every board column, so the menu doubles as a map", () => {
    renderSubject();
    const items = statusMenu()
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    for (const label of [
      "Backlog",
      "To Do",
      "In Progress",
      "Review",
      "To Merge",
      "Done",
      "Released",
    ]) {
      expect(items.some((text) => text?.startsWith(label))).toBe(true);
    }
  });

  it("disables → Done with the merge-gate reason where the edge exists", () => {
    // The merge gate is the reason only where the structural edge is real:
    // to_merge → done. The merge IS the approval, so the option is offered
    // and explained rather than hidden.
    setEpic({ status: "to_merge" });
    renderSubject();

    const done = statusMenu().getByRole("menuitem", { name: /^Done/ });
    expect(done).toBeDisabled();
    expect(done).toHaveAttribute("title", REASON_MERGE_REQUIRED);
  });

  it("disables Released as a system-only destination from any column", () => {
    renderSubject();
    const released = statusMenu().getByRole("menuitem", { name: /^Released/ });
    expect(released).toBeDisabled();
    expect(released).toHaveAttribute("title", REASON_RELEASED_SYSTEM_ONLY);
  });

  it("locks an in_progress ticket while its session is live", () => {
    setEpic({ status: "in_progress" });
    setDispatch({ activeSession: RUNNING_SESSION, isRunning: true });
    renderSubject();

    const review = statusMenu().getByRole("menuitem", { name: /^Review/ });
    expect(review).toBeDisabled();
    expect(review).toHaveAttribute("title", REASON_SESSION_RUNNING);
  });

  it("never marks the current option with a reason tooltip", () => {
    renderSubject();
    const current = statusMenu().getByRole("menuitem", { name: /^Review/ });
    expect(current).not.toHaveAttribute("title");
    expect(current.textContent).toContain("(current)");
  });

  it("surfaces the workflow engine's rejection inline", async () => {
    updateEpic.mockResolvedValue({
      ok: false,
      error: "Review must be completed first",
    });
    renderSubject();

    fireEvent.click(statusMenu().getByRole("menuitem", { name: /^To Merge/ }));

    await waitFor(() =>
      expect(screen.getByTestId("ticket-status-error")).toHaveTextContent(
        "Review must be completed first",
      ),
    );
    expect(updateEpic).toHaveBeenCalledWith({ status: "to_merge" });
  });

  it("keeps priority changeable from the same menu", async () => {
    renderSubject();
    fireEvent.click(statusMenu().getByRole("menuitem", { name: /^Critical/ }));
    await waitFor(() => expect(updateEpic).toHaveBeenCalledWith({ priority: 3 }));
  });
});

/* ------------------------------------------------------------------ */

describe("TicketOverlay derived state", () => {
  it("clears the status error and the reply draft when the ticket changes", async () => {
    updateEpic.mockResolvedValue({ ok: false, error: "Nope" });
    const { rerender } = renderSubject();

    fireEvent.click(statusMenu().getByRole("menuitem", { name: /^To Merge/ }));
    await waitFor(() =>
      expect(screen.getByTestId("ticket-status-error")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("ticket-reply-input"), {
      target: { value: "half-written reply" },
    });

    rerender(
      <TicketOverlay
        projectId="proj-1"
        epicId="epic-2"
        open
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("ticket-status-error")).toBeNull();
    expect(screen.getByTestId("ticket-reply-input")).toHaveValue("");
  });

  it("gates the ticket poll on a running session", () => {
    const { rerender } = renderSubject();
    expect(setPolling).toHaveBeenLastCalledWith(false);

    setDispatch({ activeSession: RUNNING_SESSION, isRunning: true });
    rerender(
      <TicketOverlay
        projectId="proj-1"
        epicId="epic-1"
        open
        onClose={vi.fn()}
      />,
    );
    expect(setPolling).toHaveBeenLastCalledWith(true);
  });
});

/* ------------------------------------------------------------------ */

describe("TicketOverlay non-live collapse", () => {
  it("renders no progress track when no session is running", async () => {
    const { container } = renderSubject();
    await waitFor(() =>
      expect(mockFindUnifiedSession).toHaveBeenCalledTimes(1),
    );
    expect(container.querySelector('[data-slot="progress-track"]')).toBeNull();
    expect(screen.queryByTestId("ticket-agent-timeline")).toBeNull();
    // The band is still there — collapsed to its label line.
    expect(screen.getByText("What the agent is doing")).toBeInTheDocument();
  });

  it("crawls only while a session is live", () => {
    setDispatch({ activeSession: RUNNING_SESSION, isRunning: true });
    const { container } = renderSubject();
    expect(container.querySelector('[data-slot="progress-track"]')).not.toBeNull();
  });

  it("collapses an empty user-stories band to its label line", () => {
    renderSubject();
    expect(screen.getByText("User stories")).toBeInTheDocument();
    expect(screen.queryAllByTestId("ticket-story-row")).toHaveLength(0);
    expect(screen.queryByText(/no stories/i)).toBeNull();
  });

  it("omits the AC chip for a story with no acceptance criteria", () => {
    setEpic({}, [
      { id: "s1", title: "First", status: "done", acceptanceCriteria: "a\nb" },
      { id: "s2", title: "Second", status: "todo", acceptanceCriteria: null },
    ]);
    renderSubject();

    expect(screen.getByText("2 AC")).toBeInTheDocument();
    expect(screen.queryByText("0 AC")).toBeNull();
    expect(screen.queryByText("— AC")).toBeNull();
    expect(screen.getByText("1/2 done")).toBeInTheDocument();
  });

  it("shows an em-dash for an empty dependency relation, never a zero", () => {
    renderSubject();
    const waits = screen.getByTestId("ticket-dependency-waits-on");
    expect(waits).toHaveTextContent("WAITS ON");
    expect(waits).toHaveTextContent("—");
    expect(waits.textContent).not.toContain("0");
  });
});

/* ------------------------------------------------------------------ */

describe("TicketOverlay closing", () => {
  it("closes on the ✕ button", () => {
    const onClose = vi.fn();
    renderSubject({ onClose });
    fireEvent.click(screen.getByTestId("ticket-overlay-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderSubject({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop click but not on a click inside the modal", () => {
    const onClose = vi.fn();
    renderSubject({ onClose });

    fireEvent.click(screen.getByTestId("epic-detail-panel"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("ticket-overlay"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets the delete dialog own Escape while it is up", async () => {
    const onClose = vi.fn();
    renderSubject({ onClose });

    fireEvent.click(screen.getByText("Delete ticket"));
    await screen.findByText("Delete Epic");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
