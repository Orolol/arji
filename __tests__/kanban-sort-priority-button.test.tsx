/**
 * The "Sort by priority" control in the Backlog and To Do column headers.
 *
 * It is offered on exactly the two columns a human curates before work
 * starts, and it obeys the same rule every other reorder path in Board.tsx
 * obeys: no position writes while a filter is active, because sorting
 * rewrites the whole column and a filtered view is a subset of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Board } from "@/components/kanban/Board";
import type { KanbanEpic } from "@/lib/types/kanban";

const PROJECT_ID = "proj-sort-button";

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
  sortColumnByPriority: vi.fn(),
  dependencies: [] as { ticketId: string; dependsOnTicketId: string }[],
}));

vi.mock("@/hooks/useKanban", () => ({
  useKanban: () => ({
    board: mockKanbanState.board,
    loading: false,
    refresh: mockKanbanState.refresh,
    moveEpic: mockKanbanState.moveEpic,
    sortColumnByPriority: mockKanbanState.sortColumnByPriority,
    dependencies: mockKanbanState.dependencies,
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

function boardEpic(overrides: Partial<KanbanEpic>): KanbanEpic {
  return {
    id: "epic-x",
    projectId: PROJECT_ID,
    title: "Epic X",
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
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    type: "feature",
    linkedEpicId: null,
    images: null,
    usCount: 0,
    usDone: 0,
    ...overrides,
  } as KanbanEpic;
}

describe("Sort by priority button", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockKanbanState.sortColumnByPriority.mockClear();
    mockKanbanState.board = {
      columns: {
        backlog: [boardEpic({ id: "b1", title: "Backlog One", status: "backlog" })],
        todo: [
          boardEpic({ id: "t1", title: "Todo Feature", type: "feature" }),
          boardEpic({ id: "t2", title: "Todo Bug", type: "bug", position: 1 }),
        ],
        in_progress: [boardEpic({ id: "p1", status: "in_progress" })],
        review: [boardEpic({ id: "r1", status: "review" })],
        done: [boardEpic({ id: "d1", status: "done" })],
        released: [],
      },
      releaseGroups: [],
    } as typeof mockKanbanState.board;
  });

  it("is offered on the two curated columns and nowhere else", () => {
    render(<Board projectId={PROJECT_ID} onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("column-sort-priority-backlog")).toBeInTheDocument();
    expect(screen.getByTestId("column-sort-priority-todo")).toBeInTheDocument();
    for (const status of ["in_progress", "review", "done"]) {
      expect(
        screen.queryByTestId(`column-sort-priority-${status}`)
      ).not.toBeInTheDocument();
    }
  });

  it("sorts the column it belongs to", () => {
    render(<Board projectId={PROJECT_ID} onEpicClick={vi.fn()} />);

    fireEvent.click(screen.getByTestId("column-sort-priority-todo"));
    expect(mockKanbanState.sortColumnByPriority).toHaveBeenCalledWith("todo");

    fireEvent.click(screen.getByTestId("column-sort-priority-backlog"));
    expect(mockKanbanState.sortColumnByPriority).toHaveBeenCalledWith("backlog");
    expect(mockKanbanState.sortColumnByPriority).toHaveBeenCalledTimes(2);
  });

  it("is disabled while filters hide part of the column", () => {
    render(<Board projectId={PROJECT_ID} onEpicClick={vi.fn()} />);

    fireEvent.click(screen.getByTestId("filter-type-bug"));

    // Sorting writes positions for the WHOLE column while the user is looking
    // at a subset — the same reason drag is disabled under a filter.
    const button = screen.getByTestId("column-sort-priority-todo");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Clear the filters to sort — sorting rewrites the whole column"
    );

    fireEvent.click(button);
    expect(mockKanbanState.sortColumnByPriority).not.toHaveBeenCalled();
  });

  it("becomes available again once the filters are cleared", () => {
    render(<Board projectId={PROJECT_ID} onEpicClick={vi.fn()} />);

    fireEvent.click(screen.getByTestId("filter-type-bug"));
    fireEvent.click(screen.getByTestId("filter-type-bug"));

    const button = screen.getByTestId("column-sort-priority-todo");
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(mockKanbanState.sortColumnByPriority).toHaveBeenCalledWith("todo");
  });
});
