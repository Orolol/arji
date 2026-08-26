/**
 * The divided Review column: a "Ready to merge" section over an "In review"
 * one, a Merge button on the ready cards, and the blocking reason on the
 * others.
 *
 * Membership is asserted the way the feature promises it: never through a
 * drag, always by changing the epic's derived signal and re-rendering.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Board } from "@/components/kanban/Board";
import type { KanbanEpic } from "@/lib/types/kanban";
import {
  sortReviewColumn,
  type MergeReadiness,
} from "@/lib/kanban/merge-readiness";

const mockKanbanState = vi.hoisted(() => ({
  board: {
    columns: {
      backlog: [] as KanbanEpic[],
      todo: [] as KanbanEpic[],
      in_progress: [] as KanbanEpic[],
      review: [] as KanbanEpic[],
      done: [] as KanbanEpic[],
      released: [] as KanbanEpic[],
    },
    releaseGroups: [],
  },
  refresh: vi.fn(),
  moveEpic: vi.fn(),
}));

vi.mock("@/hooks/useKanban", () => ({
  useKanban: () => ({
    board: mockKanbanState.board,
    loading: false,
    refresh: mockKanbanState.refresh,
    moveEpic: mockKanbanState.moveEpic,
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PointerSensor: class PointerSensor {},
  KeyboardSensor: class KeyboardSensor {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCorners: vi.fn(),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { tabIndex: 0 },
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
  sortableKeyboardCoordinates: vi.fn(),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

vi.mock("@/components/kanban/ReleasedColumn", () => ({
  ReleasedColumn: () => <div data-testid="released-column" />,
}));

const READY: MergeReadiness = { ready: true, blocker: null, openFindings: 0 };
const FINDINGS: MergeReadiness = {
  ready: false,
  blocker: "open_findings",
  openFindings: 2,
};
const STALE: MergeReadiness = {
  ready: false,
  blocker: "stale_review",
  openFindings: 0,
};
const CONFLICT: MergeReadiness = {
  ready: false,
  blocker: "merge_conflict",
  openFindings: 0,
};

let epicSeq = 0;
function makeEpic(overrides?: Partial<KanbanEpic>): KanbanEpic {
  epicSeq += 1;
  return {
    id: `epic-${epicSeq}`,
    projectId: "proj-1",
    title: `Epic ${epicSeq}`,
    description: "Has a description",
    priority: 1,
    status: "review",
    position: epicSeq,
    branchName: `feature/epic-${epicSeq}`,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    confidence: null,
    evidence: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    type: "feature",
    linkedEpicId: null,
    images: null,
    readableId: null,
    releaseId: null,
    usCount: 1,
    usDone: 0,
    latestCommentId: null,
    latestCommentAuthor: null,
    latestCommentCreatedAt: null,
    ...overrides,
  };
}

/**
 * Seed the Review column the way `useKanban` always hands it over: sorted
 * merge-ready-first. The Board slices its sections out of that array rather
 * than re-permuting it, so feeding it an unsorted column here would test a
 * state the hook cannot produce. `setRawReviewColumn` exists for the one case
 * that deliberately does.
 */
function setReviewColumn(review: KanbanEpic[], rest?: Partial<Record<string, KanbanEpic[]>>) {
  setRawReviewColumn(sortReviewColumn(review), rest);
}

function setRawReviewColumn(
  review: KanbanEpic[],
  rest?: Partial<Record<string, KanbanEpic[]>>
) {
  mockKanbanState.board = {
    columns: {
      backlog: [],
      todo: [],
      in_progress: [],
      review,
      done: [],
      released: [],
      ...rest,
    },
    releaseGroups: [],
  } as typeof mockKanbanState.board;
}

function renderBoard(props?: Partial<Parameters<typeof Board>[0]>) {
  return render(
    <Board projectId="proj-1" onEpicClick={vi.fn()} {...props} />
  );
}

const readySection = () => screen.getByTestId("column-section-review-ready");
const inReviewSection = () =>
  screen.getByTestId("column-section-review-in-review");

beforeEach(() => {
  localStorage.clear();
  epicSeq = 0;
  vi.clearAllMocks();
  setReviewColumn([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Review column sections", () => {
  it("splits ready tickets from the rest, with counts on each header", () => {
    const ready = makeEpic({ title: "Ready one", mergeReadiness: READY });
    const waiting = makeEpic({ title: "Still cooking", mergeReadiness: FINDINGS });
    setReviewColumn([waiting, ready]);

    renderBoard();

    expect(within(readySection()).getByText("Ready one")).toBeInTheDocument();
    expect(
      within(inReviewSection()).getByText("Still cooking")
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("column-section-header-review-ready")).getByText("1")
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByTestId("column-section-header-review-in-review")
      ).getByText("1")
    ).toBeInTheDocument();
  });

  it("labels the two sections", () => {
    setReviewColumn([makeEpic({ mergeReadiness: READY })]);
    renderBoard();
    expect(screen.getByText("Ready to merge")).toBeInTheDocument();
    expect(screen.getByText("In review")).toBeInTheDocument();
  });

  it("says so when nothing has cleared review yet", () => {
    setReviewColumn([makeEpic({ mergeReadiness: FINDINGS })]);
    renderBoard();
    expect(
      within(readySection()).getByText("Nothing cleared review yet.")
    ).toBeInTheDocument();
  });

  it("moves a ticket between sections when its signal changes, not by dragging", () => {
    const epic = makeEpic({ title: "Shifting", mergeReadiness: FINDINGS });
    setReviewColumn([epic]);
    const { rerender } = renderBoard();

    expect(within(inReviewSection()).getByText("Shifting")).toBeInTheDocument();

    // The next poll returns the same ticket, now cleared.
    setReviewColumn([{ ...epic, mergeReadiness: READY }]);
    rerender(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(within(readySection()).getByText("Shifting")).toBeInTheDocument();
    expect(within(inReviewSection()).queryByText("Shifting")).toBeNull();
  });

  it("renders the array it was given, even if a card is out of order", () => {
    // The invariant `useKanban` maintains can lapse for one refresh — an
    // optimistic drop whose readiness has not been recomputed. When it does,
    // the render order must still equal the array order, because that array
    // is what drag indices are computed against. Mis-grouping for a beat is
    // the acceptable cost; a drag persisted to the wrong rank is not.
    const blocked = makeEpic({ title: "Out of order", mergeReadiness: FINDINGS });
    const ready = makeEpic({ title: "Cleared", mergeReadiness: READY });
    setRawReviewColumn([blocked, ready]);

    renderBoard();

    const cards = screen
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(cards).toEqual(["Out of order", "Cleared"]);
    // Grouping degrades gracefully: the ready card is filed below until the
    // next refresh re-sorts the column.
    expect(within(inReviewSection()).getByText("Cleared")).toBeInTheDocument();
  });

  it("leaves the other columns undivided", () => {
    setReviewColumn([makeEpic({ mergeReadiness: READY })], {
      todo: [makeEpic({ status: "todo", mergeReadiness: undefined })],
    });
    renderBoard();
    expect(screen.queryByTestId("column-section-todo-ready")).toBeNull();
  });
});

describe("Merge affordances on Review cards", () => {
  it("offers Merge on a ready card only", () => {
    const ready = makeEpic({ mergeReadiness: READY });
    const waiting = makeEpic({ mergeReadiness: FINDINGS });
    setReviewColumn([ready, waiting]);

    renderBoard();

    expect(screen.getByTestId(`epic-merge-${ready.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`epic-merge-${waiting.id}`)).toBeNull();
  });

  it("does not offer Merge on a ticket outside Review", () => {
    const todo = makeEpic({ status: "todo", mergeReadiness: READY });
    setReviewColumn([], { todo: [todo] });
    renderBoard();
    expect(screen.queryByTestId(`epic-merge-${todo.id}`)).toBeNull();
  });

  it("stands down while an agent is running on the ticket", () => {
    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    renderBoard({
      activeAgentActivities: {
        [ready.id]: {
          sessionId: "sess-1",
          actionType: "review",
          agentName: "Reviewer",
          provider: "claude-code",
        },
      },
    });
    expect(screen.queryByTestId(`epic-merge-${ready.id}`)).toBeNull();
  });

  it("names the blocking reason on the cards that are not ready", () => {
    const findings = makeEpic({ mergeReadiness: FINDINGS });
    const stale = makeEpic({ mergeReadiness: STALE });
    const conflict = makeEpic({ mergeReadiness: CONFLICT });
    setReviewColumn([findings, stale, conflict]);

    renderBoard();

    expect(
      screen.getByTestId(`epic-merge-blocked-${findings.id}`)
    ).toHaveTextContent("2 open findings");
    expect(
      screen.getByTestId(`epic-merge-blocked-${stale.id}`)
    ).toHaveTextContent("Review outdated — new commit since");
    expect(
      screen.getByTestId(`epic-merge-blocked-${conflict.id}`)
    ).toHaveTextContent("Merge conflict — resolve before merging");
  });

  it("offers Resolve merge on a card the activity log says conflicted", () => {
    const conflict = makeEpic({ mergeReadiness: CONFLICT });
    setReviewColumn([conflict]);
    renderBoard();
    expect(
      screen.getByTestId(`epic-resolve-merge-${conflict.id}`)
    ).toBeInTheDocument();
  });

  it("merges through the existing approve route and refreshes the board", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { approved: true, merged: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    const onMergeSuccess = vi.fn();
    renderBoard({ onMergeSuccess });

    await userEvent.click(screen.getByTestId(`epic-merge-${ready.id}`));

    await waitFor(() => expect(onMergeSuccess).toHaveBeenCalledWith(ready.id));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/proj-1/epics/${ready.id}/approve`,
      { method: "POST" }
    );
    expect(mockKanbanState.refresh).toHaveBeenCalled();
  });

  it("shows the conflict and offers Resolve merge when the merge is refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "Merge failed: CONFLICT (content) in lib/db/schema.ts.",
        mergeFailed: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    const onMergeSuccess = vi.fn();
    renderBoard({ onMergeSuccess });

    await userEvent.click(screen.getByTestId(`epic-merge-${ready.id}`));

    await waitFor(() =>
      expect(screen.getByTestId(`epic-merge-error-${ready.id}`)).toHaveTextContent(
        /CONFLICT \(content\)/
      )
    );
    expect(
      screen.getByTestId(`epic-resolve-merge-${ready.id}`)
    ).toBeInTheDocument();
    expect(onMergeSuccess).not.toHaveBeenCalled();
  });

  it("does not offer Resolve merge when a workflow guard refused, not git", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Review comments are still open" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    renderBoard();

    await userEvent.click(screen.getByTestId(`epic-merge-${ready.id}`));

    await waitFor(() =>
      expect(
        screen.getByTestId(`epic-merge-error-${ready.id}`)
      ).toHaveTextContent("Review comments are still open")
    );
    expect(screen.queryByTestId(`epic-resolve-merge-${ready.id}`)).toBeNull();
  });

  it("dispatches the resolution flow from the conflict card", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { sessionId: "sess-9", resolved: false } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const conflict = makeEpic({ mergeReadiness: CONFLICT });
    setReviewColumn([conflict]);
    const onMergeAgentDispatched = vi.fn();
    renderBoard({ onMergeAgentDispatched });

    await userEvent.click(screen.getByTestId(`epic-resolve-merge-${conflict.id}`));

    await waitFor(() =>
      expect(onMergeAgentDispatched).toHaveBeenCalledWith(conflict.id, "sess-9")
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/proj-1/epics/${conflict.id}/resolve-merge`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("stands down while a session is merely QUEUED on the ticket", () => {
    // A queued build raises no agent chip, but merging removes the epic's
    // worktree — the queued session would start into a directory that is
    // already gone. The approve route refuses the same case with a 409.
    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    renderBoard({ busyEpicIds: new Set([ready.id]) });

    expect(screen.queryByTestId(`epic-merge-${ready.id}`)).toBeNull();
  });

  it("explains the missing button when a queued session raises no agent chip", () => {
    // `busyEpicIds` is queued-or-running across every session type;
    // `activeAgentActivity` is running build/review/merge only. In the gap —
    // a queued build, a running grading or QA session — the card would sit in
    // the accented "Ready to merge" section with no button, no chip and no
    // blocker line, and the user would have nothing to read.
    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    renderBoard({ busyEpicIds: new Set([ready.id]) });

    expect(screen.queryByTestId(`epic-merge-${ready.id}`)).toBeNull();
    expect(
      screen.getByTestId(`epic-merge-blocked-${ready.id}`)
    ).toHaveTextContent("An agent is working on this epic");
  });

  it("keeps the real blocker when a busy ticket also has one", () => {
    const findings = makeEpic({ mergeReadiness: FINDINGS });
    setReviewColumn([findings]);
    renderBoard({ busyEpicIds: new Set([findings.id]) });

    expect(
      screen.getByTestId(`epic-merge-blocked-${findings.id}`)
    ).toHaveTextContent("2 open findings");
  });

  it("defers to the agent line when one is actually running", () => {
    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    renderBoard({
      busyEpicIds: new Set([ready.id]),
      activeAgentActivities: {
        [ready.id]: {
          sessionId: "sess-1",
          actionType: "review",
          agentName: "Reviewer",
          provider: "claude-code",
        },
      },
    });

    // The activity chip already says what is happening; a second line would
    // just be noise.
    expect(screen.queryByTestId(`epic-merge-blocked-${ready.id}`)).toBeNull();
    expect(screen.getByTestId(`epic-activity-${ready.id}`)).toBeInTheDocument();
  });

  it("withholds Resolve merge from a busy ticket too", () => {
    const conflict = makeEpic({ mergeReadiness: CONFLICT });
    setReviewColumn([conflict]);
    renderBoard({ busyEpicIds: new Set([conflict.id]) });

    expect(screen.queryByTestId(`epic-resolve-merge-${conflict.id}`)).toBeNull();
    // The reason still shows — it is true, and it is not a click.
    expect(
      screen.getByTestId(`epic-merge-blocked-${conflict.id}`)
    ).toHaveTextContent("Merge conflict");
  });

  it("lets the user dismiss a merge error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Review comments are still open" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    renderBoard();

    await userEvent.click(screen.getByTestId(`epic-merge-${ready.id}`));
    await waitFor(() =>
      expect(screen.getByTestId(`epic-merge-error-${ready.id}`)).toBeInTheDocument()
    );

    await userEvent.click(
      screen.getByTestId(`epic-merge-error-dismiss-${ready.id}`)
    );

    await waitFor(() =>
      expect(screen.queryByTestId(`epic-merge-error-${ready.id}`)).toBeNull()
    );
    // The card is ready again, so Merge is back and no stale failure sits
    // next to it.
    expect(screen.getByTestId(`epic-merge-${ready.id}`)).toBeInTheDocument();
  });

  it("stops offering Resolve merge when the resolve failed for a non-git reason", async () => {
    const fetchMock = vi
      .fn()
      // 1. The merge itself: git refused, so Resolve merge is offered.
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Merge failed: CONFLICT", mergeFailed: true }),
      })
      // 2. Resolve merge: an agent is busy — clicking again would hit the
      //    same wall, so the button must not be re-offered.
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: "Another agent is already running for this epic.",
          code: "AGENT_ALREADY_RUNNING",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    renderBoard();

    await userEvent.click(screen.getByTestId(`epic-merge-${ready.id}`));
    await waitFor(() =>
      expect(
        screen.getByTestId(`epic-resolve-merge-${ready.id}`)
      ).toBeInTheDocument()
    );

    await userEvent.click(screen.getByTestId(`epic-resolve-merge-${ready.id}`));

    await waitFor(() =>
      expect(
        screen.getByTestId(`epic-merge-error-${ready.id}`)
      ).toHaveTextContent("Another agent is already running")
    );
    expect(screen.queryByTestId(`epic-resolve-merge-${ready.id}`)).toBeNull();
  });

  it("does not fire a second merge while the first is in flight", async () => {
    // The executor runs synchronously, so `release` is wired before the first
    // click; the initialiser is there to keep it callable for the type checker.
    let release: () => void = () => {};
    const pending = new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true,
          json: async () => ({ data: { approved: true, merged: true } }),
        });
    });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchMock);

    const ready = makeEpic({ mergeReadiness: READY });
    setReviewColumn([ready]);
    renderBoard();

    const button = screen.getByTestId(`epic-merge-${ready.id}`);
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await userEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Let the in-flight request settle inside the test, so its state update
    // does not land after teardown.
    release();
    await waitFor(() => expect(mockKanbanState.refresh).toHaveBeenCalled());
  });
});
