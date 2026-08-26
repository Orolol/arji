import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Board } from "@/components/kanban/Board";
import type { KanbanEpic, TicketDependencyEdge } from "@/lib/types/kanban";

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
  dependencies: [] as TicketDependencyEdge[],
  refresh: vi.fn(),
  moveEpic: vi.fn(),
}));

const dndHandlers = vi.hoisted(() => ({
  onDragStart: null as
    | ((event: { active: { id: string } }) => void)
    | null,
  onDragEnd: null as
    | ((event: { active: { id: string }; over: { id: string } | null }) => void)
    | null,
  /** dnd-kit fires this INSTEAD of onDragEnd when a drag is aborted. */
  onDragCancel: null as (() => void) | null,
  /** Column the pointer is currently over, mirroring dnd-kit's `isOver`. */
  overColumnId: null as string | null,
}));

vi.mock("@/hooks/useKanban", () => ({
  useKanban: () => ({
    board: mockKanbanState.board,
    loading: false,
    refresh: mockKanbanState.refresh,
    moveEpic: mockKanbanState.moveEpic,
    dependencies: mockKanbanState.dependencies,
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
    onDragCancel,
  }: {
    children: ReactNode;
    onDragStart: (event: { active: { id: string } }) => void;
    onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => void;
    onDragCancel?: () => void;
  }) => {
    dndHandlers.onDragStart = onDragStart;
    dndHandlers.onDragEnd = onDragEnd;
    dndHandlers.onDragCancel = onDragCancel ?? null;
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PointerSensor: class PointerSensor {},
  KeyboardSensor: class KeyboardSensor {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCorners: vi.fn(),
  useDroppable: ({ id }: { id: string }) => ({
    setNodeRef: vi.fn(),
    isOver: dndHandlers.overColumnId === id,
  }),
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

vi.mock("@/components/kanban/ReleasedColumn", () => ({
  ReleasedColumn: () => <div data-testid="released-column" />,
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

function makeEpic(overrides: Partial<KanbanEpic> & { id: string }): KanbanEpic {
  return {
    projectId: "proj-1",
    title: overrides.id,
    description: null,
    priority: 1,
    status: "todo",
    position: 0,
    branchName: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    confidence: null,
    evidence: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
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
    usWithCriteriaCount:
      overrides.usWithCriteriaCount ?? overrides.usCount ?? 1,
  };
}

function setBoard(columns: Partial<Record<string, KanbanEpic[]>>) {
  mockKanbanState.board = {
    columns: {
      backlog: [],
      todo: [],
      in_progress: [],
      review: [],
      done: [],
      released: [],
      ...columns,
    },
    releaseGroups: [],
  } as typeof mockKanbanState.board;
}

function setDependencies(edges: TicketDependencyEdge[]) {
  mockKanbanState.dependencies = edges;
}

/** The EpicCard root: the title is a direct child of the Card. */
function cardOf(title: string): HTMLElement {
  return screen.getByText(title).parentElement as HTMLElement;
}

describe("Kanban board dependency visibility", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setBoard({});
    setDependencies([]);
    mockKanbanState.refresh.mockClear();
    mockKanbanState.moveEpic.mockClear();
    dndHandlers.onDragStart = null;
    dndHandlers.onDragEnd = null;
    dndHandlers.onDragCancel = null;
    dndHandlers.overColumnId = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ranks the To Do execution queue and marks the next ticket", () => {
    const a = makeEpic({ id: "a", title: "Epic A", description: "Plan A" });
    const b = makeEpic({ id: "b", title: "Epic B", description: "Plan B" });
    const c = makeEpic({ id: "c", title: "Epic C", description: "Plan C" });
    setBoard({ todo: [a, b, c] });
    // b waits on a -> blocked -> skipped by the numbering
    setDependencies([{ ticketId: "b", dependsOnTicketId: "a" }]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-queue-rank-a")).toHaveTextContent("#1");
    expect(screen.getByTestId("epic-queue-rank-a")).toHaveTextContent("Next");
    expect(screen.queryByTestId("epic-queue-rank-b")).toBeNull();
    expect(screen.getByTestId("epic-queue-rank-c")).toHaveTextContent("#2");
    expect(screen.getByTestId("epic-queue-rank-c")).not.toHaveTextContent("Next");
  });

  it("shows blocked tickets with their open dependency targets", () => {
    const a = makeEpic({ id: "a", title: "Epic A", status: "backlog" });
    const b = makeEpic({ id: "b", title: "Epic B" });
    const d = makeEpic({ id: "d", title: "Epic D", status: "done" });
    setBoard({ backlog: [a], todo: [b], done: [d] });
    // b waits on a (backlog, open) and on d (done, satisfied)
    setDependencies([
      { ticketId: "b", dependsOnTicketId: "a" },
      { ticketId: "b", dependsOnTicketId: "d" },
    ]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    const blockedRow = screen.getByTestId("epic-blocked-b");
    expect(blockedRow).toHaveTextContent("Waiting on: Epic A");
    // The delivered target never shows up as a blocker
    expect(blockedRow).not.toHaveTextContent("Epic D");
    // a card without open dependencies shows no blocked row
    expect(screen.queryByTestId("epic-blocked-a")).toBeNull();
  });

  it("reports Backlog readiness as Ready n/3", () => {
    const ready = makeEpic({
      id: "ready",
      title: "Ready",
      status: "backlog",
      description: "A plan",
      usCount: 2,
    });
    const partial = makeEpic({
      id: "partial",
      title: "Partial",
      status: "backlog",
      description: "A plan",
      usCount: 2,
      latestSessionOutcome: "asked_question",
    });
    const bare = makeEpic({
      id: "bare",
      title: "Bare",
      status: "backlog",
      usCount: 0,
    });
    setBoard({ backlog: [ready, partial, bare] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-readiness-ready")).toHaveTextContent("Ready 3/3");
    expect(screen.getByTestId("epic-readiness-partial")).toHaveTextContent("Ready 2/3");
    // No open question + no description + no stories = 1 of 3
    expect(screen.getByTestId("epic-readiness-bare")).toHaveTextContent("Ready 1/3");
    // Queue ranking is a To Do-only signal: Backlog cards get no rank chip
    expect(screen.queryByTestId("epic-queue-rank-ready")).toBeNull();
  });

  it("hovering a card highlights its dependency neighbours and dims the rest", () => {
    vi.useFakeTimers();
    // A is delivered: the edge stays in the adjacency so the focus still has
    // neighbours, but B is not blocked — this test is about the hover focus,
    // and a blocked B would carry its own muted opacity.
    const a = makeEpic({ id: "a", title: "Epic A", status: "done" });
    const b = makeEpic({ id: "b", title: "Epic B" });
    const z = makeEpic({ id: "z", title: "Unrelated" });
    setBoard({ todo: [b, z], done: [a] });
    setDependencies([{ ticketId: "b", dependsOnTicketId: "a" }]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    const cardA = cardOf("Epic A");
    const cardB = cardOf("Epic B");
    const cardZ = cardOf("Unrelated");

    // Enter a: the focus commits after the 150 ms intent window
    act(() => {
      fireEvent.mouseEnter(cardA);
    });
    expect(cardB.className).not.toContain("ring-agent/50");
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // b is a successor of a -> agent ring; z is unrelated -> dimmed.
    // The dim is asserted on the computed style, not the class list: the card
    // sets `opacity` inline for the drag state, and an inline declaration
    // beats a non-`!important` class rule, so a class assertion would pass
    // even when nothing reaches the screen.
    expect(cardB.className).toContain("ring-agent/50");
    expect(cardZ.style.opacity).toBe("0.4");
    expect(cardB.style.opacity).toBe("1");
    expect(cardA.className).not.toContain("ring-agent/50");

    // Move to b: a becomes the highlighted predecessor
    act(() => {
      fireEvent.mouseEnter(cardB);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(cardA.className).toContain("ring-primary/50");

    // Leaving clears the focus entirely
    act(() => {
      fireEvent.mouseLeave(cardB);
    });
    expect(cardA.className).not.toContain("ring-primary/50");
    expect(cardZ.style.opacity).toBe("1");
  });

  it("hovering a card with no dependencies dims nothing", () => {
    vi.useFakeTimers();
    const a = makeEpic({ id: "a", title: "Epic A", status: "done" });
    const b = makeEpic({ id: "b", title: "Epic B" });
    const z = makeEpic({ id: "z", title: "Unrelated" });
    setBoard({ todo: [b, z], done: [a] });
    // z has no edge in either direction; a and b are linked to each other.
    // A is delivered so B carries no blocked styling of its own here.
    setDependencies([{ ticketId: "b", dependsOnTicketId: "a" }]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    act(() => {
      fireEvent.mouseEnter(cardOf("Unrelated"));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    // No focus at all: dimming every card while highlighting none would say
    // nothing, and on a board with no dependency rows it would fire on any
    // pointer rest.
    for (const title of ["Epic A", "Epic B", "Unrelated"]) {
      const card = cardOf(title);
      expect(card.style.opacity).toBe("1");
      expect(card.className).not.toContain("ring-primary/50");
      expect(card.className).not.toContain("ring-agent/50");
    }
  });

  it("still highlights dependencies after a cancelled drag", () => {
    vi.useFakeTimers();
    // dnd-kit dispatches cancel INSTEAD of end — Escape, a window resize and a
    // tab switch all reach it. Without a reset there, the drag state stays
    // latched and every later hover bails out, killing story 3 for the rest of
    // the page session.
    const a = makeEpic({ id: "a", title: "Epic A", status: "done" });
    const b = makeEpic({ id: "b", title: "Epic B" });
    const z = makeEpic({ id: "z", title: "Unrelated" });
    setBoard({ todo: [b, z], done: [a] });
    setDependencies([{ ticketId: "b", dependsOnTicketId: "a" }]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);
    expect(dndHandlers.onDragCancel).toBeTypeOf("function");

    act(() => {
      dndHandlers.onDragStart?.({ active: { id: "b" } });
    });
    act(() => {
      dndHandlers.onDragCancel?.();
    });

    act(() => {
      fireEvent.mouseEnter(cardOf("Epic A"));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(cardOf("Epic B").className).toContain("ring-agent/50");
    expect(cardOf("Unrelated").style.opacity).toBe("0.4");
  });

  it("clears the focus when the hovered card is moved to another column", () => {
    vi.useFakeTimers();
    // An SSE update moving the hovered ticket re-mounts its card under a
    // different Column. React fires no mouseleave for that, so without the
    // card reporting its own departure the board would stay dimmed with the
    // pointer nowhere near a card.
    const a = makeEpic({ id: "a", title: "Epic A", status: "done" });
    const b = makeEpic({ id: "b", title: "Epic B" });
    const z = makeEpic({ id: "z", title: "Unrelated" });
    setBoard({ todo: [b, z], done: [a] });
    setDependencies([{ ticketId: "b", dependsOnTicketId: "a" }]);

    const { rerender } = render(
      <Board projectId="proj-1" onEpicClick={vi.fn()} />
    );

    act(() => {
      fireEvent.mouseEnter(cardOf("Epic B"));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(cardOf("Unrelated").style.opacity).toBe("0.4");

    // An agent picks B up — exactly what the user was hovering it to decide.
    setBoard({
      todo: [z],
      in_progress: [{ ...b, status: "in_progress" }],
      done: [a],
    });
    act(() => {
      rerender(<Board projectId="proj-1" onEpicClick={vi.fn()} />);
    });

    expect(cardOf("Unrelated").style.opacity).toBe("1");
  });

  it("greys a blocked card, not just labels it", () => {
    // Story 2 is "carte grisée + libellé": the label alone leaves a blocked
    // card pixel-identical to a ready one apart from one 11px row.
    const blocked = makeEpic({ id: "blocked", title: "Blocked" });
    const ready = makeEpic({ id: "ready", title: "Ready" });
    const prereq = makeEpic({ id: "prereq", title: "Prereq", status: "backlog" });
    setBoard({ todo: [blocked, ready], backlog: [prereq] });
    setDependencies([{ ticketId: "blocked", dependsOnTicketId: "prereq" }]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    // Asserted on the computed style: opacity is inline precisely because an
    // inline declaration beats Tailwind's non-`!important` classes, so a class
    // assertion could pass while nothing reaches the screen.
    const blockedCard = cardOf("Blocked");
    expect(blockedCard.style.opacity).toBe("0.62");
    expect(blockedCard.className).toContain("saturate-[.55]");
    expect(blockedCard).toHaveTextContent("Waiting on: Prereq");

    // An unblocked sibling is untouched.
    expect(cardOf("Ready").style.opacity).toBe("1");
    expect(cardOf("Ready").className).not.toContain("saturate-[.55]");
  });

  it("clears the blocked styling once the prerequisite is delivered", () => {
    const dependent = makeEpic({ id: "dependent", title: "Dependent" });
    const prereq = makeEpic({ id: "prereq", title: "Prereq", status: "done" });
    setBoard({ todo: [dependent], done: [prereq] });
    setDependencies([{ ticketId: "dependent", dependsOnTicketId: "prereq" }]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(cardOf("Dependent").style.opacity).toBe("1");
    expect(screen.queryByTestId("epic-blocked-dependent")).toBeNull();
  });

  it("keeps the focus while focus moves within the same card", () => {
    vi.useFakeTimers();
    const a = makeEpic({ id: "a", title: "Epic A" });
    const b = makeEpic({ id: "b", title: "Epic B" });
    const z = makeEpic({ id: "z", title: "Unrelated" });
    setBoard({ todo: [a, b, z] });
    setDependencies([{ ticketId: "b", dependsOnTicketId: "a" }]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);
    const cardA = cardOf("Epic A");
    const cardZ = cardOf("Unrelated");

    act(() => {
      fireEvent.focusIn(cardA);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(cardZ.style.opacity).toBe("0.4");

    // Tabbing from the card body onto something inside it is not a leave.
    // Clearing here would drop the focus and re-arm the 150 ms timer, so the
    // dim would visibly blink on every internal tab step.
    act(() => {
      fireEvent.focusOut(cardA, { relatedTarget: cardA.firstChild });
    });
    expect(cardZ.style.opacity).toBe("0.4");

    // Leaving the card for good does clear it.
    act(() => {
      fireEvent.focusOut(cardA, { relatedTarget: cardZ });
    });
    expect(cardZ.style.opacity).toBe("1");
  });

  it("does not dim when the only neighbour is off the draggable board", () => {
    vi.useFakeTimers();
    const x = makeEpic({ id: "x", title: "Dependent" });
    const other = makeEpic({ id: "other", title: "Bystander" });
    // y is Released: ReleasedColumn renders no focus roles, so highlighting it
    // is impossible and dimming the board would point at nothing.
    const y = makeEpic({ id: "y", title: "Shipped", status: "released" });
    setBoard({ todo: [x, other], released: [y] });
    setDependencies([{ ticketId: "x", dependsOnTicketId: "y" }]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    act(() => {
      fireEvent.mouseEnter(cardOf("Dependent"));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(cardOf("Bystander").style.opacity).toBe("1");
    expect(cardOf("Dependent").style.opacity).toBe("1");
  });

  it("does not dim when focus mode collapses the neighbour's column", () => {
    vi.useFakeTimers();
    const x = makeEpic({ id: "x", title: "Dependent" });
    const other = makeEpic({ id: "other", title: "Bystander" });
    // "prerequisite is Done" is the normal end state, and focus mode is a
    // one-click toggle that replaces the Done column with a collapsed slice.
    const y = makeEpic({ id: "y", title: "Finished", status: "done" });
    setBoard({ todo: [x, other], done: [y] });
    setDependencies([{ ticketId: "x", dependsOnTicketId: "y" }]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    // Sanity: with Done rendered, the focus works and dims the bystander.
    act(() => {
      fireEvent.mouseEnter(cardOf("Dependent"));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(cardOf("Bystander").style.opacity).toBe("0.4");
    act(() => {
      fireEvent.mouseLeave(cardOf("Dependent"));
    });

    fireEvent.click(screen.getByTestId("focus-mode-toggle"));
    expect(screen.getByTestId("collapsed-column-done")).toBeInTheDocument();

    act(() => {
      fireEvent.mouseEnter(cardOf("Dependent"));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(cardOf("Bystander").style.opacity).toBe("1");
  });

  it("renders a bug's Backlog readiness out of 2", () => {
    // Bugs carry no user stories, so a third criterion would strand every bug
    // card below its total forever.
    const bug = makeEpic({
      id: "bug",
      title: "Crash",
      status: "backlog",
      type: "bug",
      description: "Steps to reproduce",
      usCount: 0,
    });
    setBoard({ backlog: [bug] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-readiness-bug")).toHaveTextContent(
      "Ready 2/2"
    );
  });

  it("separates multiple blockers with a comma", () => {
    // readableId is nullable, so entries fall back to the title; multi-word
    // titles joined by a bare space read as one blocker.
    const b = makeEpic({ id: "b", title: "Blocked" });
    const p1 = makeEpic({ id: "p1", title: "Fix login redirect", status: "backlog" });
    const p2 = makeEpic({ id: "p2", title: "Cache warmup", status: "backlog" });
    setBoard({ todo: [b], backlog: [p1, p2] });
    setDependencies([
      { ticketId: "b", dependsOnTicketId: "p1" },
      { ticketId: "b", dependsOnTicketId: "p2" },
    ]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-blocked-b")).toHaveTextContent(
      "Waiting on: Fix login redirect, Cache warmup"
    );
  });

  it("drops the blocked label once the dependent itself is delivered", () => {
    const late = makeEpic({ id: "late", title: "Late", status: "backlog" });
    const shipped = makeEpic({ id: "shipped", title: "Shipped", status: "done" });
    const open = makeEpic({ id: "open", title: "Open" });
    setBoard({ backlog: [late], todo: [open], done: [shipped] });
    // Both depend on a prerequisite that is still in Backlog. Full Auto
    // ignores ticket_dependencies, so an epic really can merge ahead of one.
    setDependencies([
      { ticketId: "shipped", dependsOnTicketId: "late" },
      { ticketId: "open", dependsOnTicketId: "late" },
    ]);

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    // A delivered card never advertises a block it has already outlived
    expect(screen.queryByTestId("epic-blocked-shipped")).toBeNull();
    // ...while an undelivered dependent still does
    expect(screen.getByTestId("epic-blocked-open")).toHaveTextContent(
      "Waiting on: Late"
    );
  });

  it("under a filter, drops land at the end of the target column", () => {
    const a = makeEpic({ id: "a", title: "Epic A" });
    const d1 = makeEpic({ id: "d1", title: "Done 1", status: "done", type: "bug" });
    const d2 = makeEpic({ id: "d2", title: "Done 2", status: "done", type: "bug" });
    setBoard({ todo: [a], done: [d1, d2] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    // A bug-only filter hides the feature epic from the todo view, but
    // dragging stays live and lands at the end of the target column.
    fireEvent.click(screen.getByTestId("filter-type-bug"));

    act(() => {
      dndHandlers.overColumnId = "done";
      dndHandlers.onDragStart?.({ active: { id: "a" } });
    });
    // The drop indicator moved to the bottom of the target column...
    expect(screen.getByTestId("column-drop-end-done")).toBeInTheDocument();
    // ...and only there: it follows the pointer, so the other columns stay
    // clean. An indicator in all five columns indicates nothing.
    expect(screen.queryByTestId("column-drop-end-todo")).toBeNull();
    expect(screen.queryByTestId("column-drop-end-backlog")).toBeNull();
    expect(screen.queryByTestId("column-drop-end-review")).toBeNull();

    act(() => {
      dndHandlers.overColumnId = null;
      dndHandlers.onDragEnd?.({ active: { id: "a" }, over: { id: "d2" } });
    });
    // End of the done column, not the filtered-visible index
    expect(mockKanbanState.moveEpic).toHaveBeenCalledWith(
      "a",
      "todo",
      "done",
      2,
      undefined
    );

    // The drag is over: the indicator is gone again
    expect(screen.queryByTestId("column-drop-end-done")).toBeNull();

    // A same-column reorder under a filter stays a no-op: the visible
    // index would not match the board order.
    act(() => {
      dndHandlers.onDragStart?.({ active: { id: "d1" } });
    });
    act(() => {
      dndHandlers.onDragEnd?.({ active: { id: "d1" }, over: { id: "d2" } });
    });
    expect(mockKanbanState.moveEpic).toHaveBeenCalledTimes(1);

    // With the filter cleared, the drop lands at the hovered card's slot
    fireEvent.click(screen.getByTestId("filter-clear-all"));
    act(() => {
      dndHandlers.onDragEnd?.({ active: { id: "a" }, over: { id: "d2" } });
    });
    expect(mockKanbanState.moveEpic).toHaveBeenLastCalledWith(
      "a",
      "todo",
      "done",
      1,
      undefined
    );
  });

  it("shows no drop slot in the dragged card's own column under a filter", () => {
    const a = makeEpic({ id: "a", title: "Epic A", type: "bug" });
    const b = makeEpic({ id: "b", title: "Epic B", type: "bug" });
    setBoard({ todo: [a, b] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId("filter-type-bug"));

    // Same-column drops are a deliberate no-op under a filter (the visible
    // index does not match board order), so the column must not promise a slot
    // it will silently refuse.
    act(() => {
      dndHandlers.overColumnId = "todo";
      dndHandlers.onDragStart?.({ active: { id: "a" } });
    });
    expect(screen.queryByTestId("column-drop-end-todo")).toBeNull();

    // A column that would accept the drop still shows one.
    act(() => {
      dndHandlers.overColumnId = null;
      dndHandlers.onDragEnd?.({ active: { id: "a" }, over: null });
    });
    act(() => {
      dndHandlers.overColumnId = "review";
      dndHandlers.onDragStart?.({ active: { id: "a" } });
    });
    expect(screen.getByTestId("column-drop-end-review")).toBeInTheDocument();
  });

  it("warns — without blocking — when a backlog epic with open questions moves to To Do", () => {
    const asked = makeEpic({
      id: "asked",
      title: "Asked",
      status: "backlog",
      latestSessionOutcome: "asked_question",
      latestSessionEndedAt: "2026-08-01 00:00:00",
    });
    setBoard({ backlog: [asked] });
    const onMoveWarning = vi.fn();

    render(
      <Board
        projectId="proj-1"
        onEpicClick={vi.fn()}
        onMoveWarning={onMoveWarning}
      />
    );

    act(() => {
      dndHandlers.onDragEnd?.({ active: { id: "asked" }, over: { id: "todo" } });
    });

    // The move itself is never blocked — the user decides.
    expect(mockKanbanState.moveEpic).toHaveBeenCalledWith(
      "asked",
      "backlog",
      "todo",
      0,
      expect.any(Function)
    );

    // The warning rides moveEpic's accepted path, so nothing is said until
    // the server has taken the move: a refused transition must not warn about
    // a To Do placement that never happened.
    expect(onMoveWarning).not.toHaveBeenCalled();

    const onAccepted = mockKanbanState.moveEpic.mock.calls.at(-1)?.[4] as
      | (() => void)
      | undefined;
    act(() => {
      onAccepted?.();
    });
    expect(onMoveWarning).toHaveBeenCalledWith(
      expect.stringContaining("open agent questions")
    );
  });

  it("does not warn when the agent question has been answered", () => {
    const answered = makeEpic({
      id: "answered",
      title: "Answered",
      status: "backlog",
      latestSessionOutcome: "asked_question",
      latestSessionEndedAt: "2026-08-01 00:00:00",
      latestUserCommentCreatedAt: "2026-08-01 01:00:00",
    });
    setBoard({ backlog: [answered] });
    const onMoveWarning = vi.fn();

    render(
      <Board
        projectId="proj-1"
        onEpicClick={vi.fn()}
        onMoveWarning={onMoveWarning}
      />
    );

    act(() => {
      dndHandlers.onDragEnd?.({
        active: { id: "answered" },
        over: { id: "todo" },
      });
    });

    expect(mockKanbanState.moveEpic).toHaveBeenCalledWith(
      "answered",
      "backlog",
      "todo",
      0,
      undefined
    );
    expect(onMoveWarning).not.toHaveBeenCalled();
  });
});
