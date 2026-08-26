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
  }: {
    children: ReactNode;
    onDragStart: (event: { active: { id: string } }) => void;
    onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => void;
  }) => {
    dndHandlers.onDragStart = onDragStart;
    dndHandlers.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PointerSensor: class PointerSensor {},
  KeyboardSensor: class KeyboardSensor {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCorners: vi.fn(),
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: false,
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
    expect(screen.getByTestId("epic-queue-rank-a")).toHaveTextContent("Prochain");
    expect(screen.queryByTestId("epic-queue-rank-b")).toBeNull();
    expect(screen.getByTestId("epic-queue-rank-c")).toHaveTextContent("#2");
    expect(screen.getByTestId("epic-queue-rank-c")).not.toHaveTextContent("Prochain");
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
    expect(blockedRow).toHaveTextContent("Attend : Epic A");
    // The delivered target never shows up as a blocker
    expect(blockedRow).not.toHaveTextContent("Epic D");
    // a card without open dependencies shows no blocked row
    expect(screen.queryByTestId("epic-blocked-a")).toBeNull();
  });

  it("reports Backlog readiness as Pret n/3", () => {
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

    expect(screen.getByTestId("epic-readiness-ready")).toHaveTextContent("Prêt 3/3");
    expect(screen.getByTestId("epic-readiness-partial")).toHaveTextContent("Prêt 2/3");
    // No open question + no description + no stories = 1 of 3
    expect(screen.getByTestId("epic-readiness-bare")).toHaveTextContent("Prêt 1/3");
    // Readiness is a Backlog-only signal: To Do cards get no chip
    expect(screen.queryByTestId("epic-queue-rank-ready")).toBeNull();
  });

  it("hovering a card highlights its dependency neighbours and dims the rest", () => {
    vi.useFakeTimers();
    const a = makeEpic({ id: "a", title: "Epic A" });
    const b = makeEpic({ id: "b", title: "Epic B" });
    const z = makeEpic({ id: "z", title: "Unrelated" });
    setBoard({ todo: [a, b, z] });
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
    // b is a successor of a -> agent ring; z is unrelated -> dimmed
    expect(cardB.className).toContain("ring-agent/50");
    expect(cardZ.className).toContain("opacity-40");
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
    expect(cardZ.className).not.toContain("opacity-40");
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
      dndHandlers.onDragStart?.({ active: { id: "a" } });
    });
    // The drop indicator moved to the bottom of the target column
    expect(screen.getByTestId("column-drop-end-done")).toBeInTheDocument();

    act(() => {
      dndHandlers.onDragEnd?.({ active: { id: "a" }, over: { id: "d2" } });
    });
    // End of the done column, not the filtered-visible index
    expect(mockKanbanState.moveEpic).toHaveBeenCalledWith("a", "todo", "done", 2);

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
    expect(mockKanbanState.moveEpic).toHaveBeenLastCalledWith("a", "todo", "done", 1);
  });
});
