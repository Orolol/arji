import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Board } from "@/components/kanban/Board";
import type { KanbanEpic } from "@/lib/types/kanban";
import { EMPTY_FILTERS } from "@/components/kanban/FilterBar";

const mockKanbanState = vi.hoisted(() => ({
  board: {
    columns: {
      backlog: [] as KanbanEpic[],
      todo: [] as KanbanEpic[],
      in_progress: [] as KanbanEpic[],
      review: [] as KanbanEpic[],
      to_merge: [] as KanbanEpic[],
      done: [] as KanbanEpic[],
      released: [] as KanbanEpic[],
    },
    releaseGroups: [],
  },
  refresh: vi.fn(),
  moveEpic: vi.fn(),
}));

const dndHandlers = vi.hoisted(() => ({
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
    dependencies: [],
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: ReactNode;
    onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => void;
  }) => {
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

let epicSeq = 0;
function makeEpic(overrides?: Partial<KanbanEpic>): KanbanEpic {
  epicSeq += 1;
  return {
    id: `epic-${epicSeq}`,
    projectId: "proj-1",
    title: `Epic ${epicSeq}`,
    description: "Has a description",
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
      to_merge: [],
      done: [],
      released: [],
      ...columns,
    },
    releaseGroups: [],
  } as typeof mockKanbanState.board;
}

describe("Kanban board filters and focus mode", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    epicSeq = 0;
    mockKanbanState.refresh.mockClear();
    mockKanbanState.moveEpic.mockClear();
    dndHandlers.onDragEnd = null;
  });

  it("filters cards by type", () => {
    const feature = makeEpic({ title: "Feature Card", type: "feature" });
    const bug = makeEpic({ title: "Bug Card", type: "bug" });
    setBoard({ todo: [feature, bug] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByText("Feature Card")).toBeInTheDocument();
    expect(screen.getByText("Bug Card")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("filter-type-bug"));

    expect(screen.queryByText("Feature Card")).not.toBeInTheDocument();
    expect(screen.getByText("Bug Card")).toBeInTheDocument();
  });

  it("says a column is filtered out, not empty, when filters hide its cards", () => {
    const feature = makeEpic({ title: "Feature Card", type: "feature" });
    setBoard({ todo: [feature] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    // Untouched columns are genuinely empty and still invite a capture.
    expect(screen.getByTestId("column-empty-backlog")).toHaveTextContent(
      "Nothing waiting."
    );

    fireEvent.click(screen.getByTestId("filter-type-bug"));

    const todoEmpty = screen.getByTestId("column-empty-todo");
    expect(todoEmpty).toHaveTextContent("Nothing matches the filters.");
    expect(todoEmpty).not.toHaveTextContent("Nothing waiting.");
    expect(screen.getByTestId("column-empty-backlog")).toHaveTextContent(
      "Nothing matches the filters."
    );
    expect(
      screen.queryByRole("button", { name: "Capture" })
    ).not.toBeInTheDocument();
  });

  it("combines type and priority filters (AND)", () => {
    const critical = makeEpic({ title: "Critical Feature", priority: 3 });
    const low = makeEpic({ title: "Low Feature", priority: 0 });
    const criticalBug = makeEpic({
      title: "Critical Bug",
      priority: 3,
      type: "bug",
    });
    setBoard({ todo: [critical, low, criticalBug] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    fireEvent.click(screen.getByTestId("filter-type-feature"));
    fireEvent.click(screen.getByTestId("filter-priority-3"));

    expect(screen.getByText("Critical Feature")).toBeInTheDocument();
    expect(screen.queryByText("Low Feature")).not.toBeInTheDocument();
    expect(screen.queryByText("Critical Bug")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-active-count")).toHaveTextContent(
      "2 filters active"
    );
  });

  it("filters by agent running / unread AI / failed session signals", () => {
    const running = makeEpic({ title: "Running Epic" });
    const unread = makeEpic({
      title: "Unread Epic",
      latestCommentId: "c-1",
      latestCommentAuthor: "agent",
    });
    const failed = makeEpic({ title: "Failed Epic" });
    const idle = makeEpic({ title: "Idle Epic" });
    setBoard({ todo: [running, unread, failed, idle] });

    render(
      <Board
        projectId="proj-1"
        onEpicClick={vi.fn()}
        runningEpicIds={new Set([running.id])}
        failedSessions={{
          [failed.id]: { sessionId: "s-1", error: "boom", agentType: "build" },
        }}
      />
    );

    fireEvent.click(screen.getByTestId("filter-agent-running"));
    expect(screen.getByText("Running Epic")).toBeInTheDocument();
    expect(screen.queryByText("Idle Epic")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("filter-agent-running"));

    fireEvent.click(screen.getByTestId("filter-unread-ai"));
    expect(screen.getByText("Unread Epic")).toBeInTheDocument();
    expect(screen.queryByText("Running Epic")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("filter-unread-ai"));

    fireEvent.click(screen.getByTestId("filter-failed-session"));
    expect(screen.getByText("Failed Epic")).toBeInTheDocument();
    expect(screen.queryByText("Idle Epic")).not.toBeInTheDocument();
  });

  it("clear-all restores every card", () => {
    const feature = makeEpic({ title: "Feature Card" });
    const bug = makeEpic({ title: "Bug Card", type: "bug" });
    setBoard({ todo: [feature, bug] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    fireEvent.click(screen.getByTestId("filter-type-bug"));
    expect(screen.queryByText("Feature Card")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("filter-clear-all"));
    expect(screen.getByText("Feature Card")).toBeInTheDocument();
    expect(screen.getByText("Bug Card")).toBeInTheDocument();
  });

  it("moves the epic to the end of the target column while a filter is active", () => {
    const epic = makeEpic({ title: "Draggable Epic", status: "todo" });
    const doneA = makeEpic({ title: "Done A", status: "done", type: "bug" });
    const doneB = makeEpic({ title: "Done B", status: "done", type: "bug" });
    setBoard({ todo: [epic], done: [doneA, doneB] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    // Under a bug-only filter the feature epic is hidden from the todo
    // view, but dragging stays live and lands at the end of the target
    // column instead of the filtered-visible index.
    fireEvent.click(screen.getByTestId("filter-type-bug"));
    act(() => {
      dndHandlers.onDragEnd?.({ active: { id: epic.id }, over: { id: doneB.id } });
    });
    expect(mockKanbanState.moveEpic).toHaveBeenCalledWith(
      epic.id,
      "todo",
      "done",
      2,
      undefined
    );

    // A same-column reorder under a filter stays a no-op: the visible
    // index would not match the board order.
    act(() => {
      dndHandlers.onDragEnd?.({ active: { id: doneA.id }, over: { id: doneB.id } });
    });
    expect(mockKanbanState.moveEpic).toHaveBeenCalledTimes(1);

    // With the filter cleared, the drop lands at the hovered card's slot.
    fireEvent.click(screen.getByTestId("filter-clear-all"));
    act(() => {
      dndHandlers.onDragEnd?.({ active: { id: epic.id }, over: { id: doneB.id } });
    });
    expect(mockKanbanState.moveEpic).toHaveBeenLastCalledWith(
      epic.id,
      "todo",
      "done",
      1,
      undefined
    );
  });

  it("focus mode collapses Done and Released to headers with counts", () => {
    const doneEpic = makeEpic({ title: "Done Epic", status: "done" });
    setBoard({ done: [doneEpic] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByText("Done Epic")).toBeInTheDocument();
    expect(screen.getByTestId("released-column")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("focus-mode-toggle"));

    expect(screen.queryByText("Done Epic")).not.toBeInTheDocument();
    expect(screen.queryByTestId("released-column")).not.toBeInTheDocument();
    expect(screen.getByTestId("collapsed-column-done")).toHaveTextContent("Done");
    expect(screen.getByTestId("collapsed-column-done")).toHaveTextContent("1");
    expect(screen.getByTestId("collapsed-column-released")).toHaveTextContent(
      "Released"
    );

    fireEvent.click(screen.getByTestId("focus-mode-toggle"));
    expect(screen.getByText("Done Epic")).toBeInTheDocument();
    expect(screen.getByTestId("released-column")).toBeInTheDocument();
  });

  it("persists filters and focus mode per project in localStorage", () => {
    setBoard({ todo: [makeEpic({ title: "Any Epic" })] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    fireEvent.click(screen.getByTestId("filter-type-bug"));
    fireEvent.click(screen.getByTestId("focus-mode-toggle"));

    expect(
      JSON.parse(localStorage.getItem("arij.kanban-board.filters.proj-1") || "{}")
    ).toEqual({ ...EMPTY_FILTERS, types: ["bug"] });
    expect(localStorage.getItem("arij.kanban-board.focus.proj-1")).toBe("true");
  });

  it("restores persisted filters and focus mode on mount", () => {
    localStorage.setItem(
      "arij.kanban-board.filters.proj-1",
      JSON.stringify({ ...EMPTY_FILTERS, types: ["bug"] })
    );
    localStorage.setItem("arij.kanban-board.focus.proj-1", "true");

    const feature = makeEpic({ title: "Feature Card" });
    const bug = makeEpic({ title: "Bug Card", type: "bug" });
    const doneEpic = makeEpic({ title: "Done Epic", status: "done", type: "bug" });
    setBoard({ todo: [feature, bug], done: [doneEpic] });

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.queryByText("Feature Card")).not.toBeInTheDocument();
    expect(screen.getByText("Bug Card")).toBeInTheDocument();
    expect(screen.getByTestId("collapsed-column-done")).toBeInTheDocument();
    expect(screen.getByTestId("filter-active-count")).toHaveTextContent(
      "1 filter active"
    );
  });
});
