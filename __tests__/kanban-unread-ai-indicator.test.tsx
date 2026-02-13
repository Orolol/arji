import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Board } from "@/components/kanban/Board";
import type { KanbanEpic } from "@/lib/types/kanban";

const mockKanbanState = vi.hoisted(() => ({
  board: {
    columns: {
      backlog: [] as KanbanEpic[],
      todo: [] as KanbanEpic[],
      in_progress: [] as KanbanEpic[],
      review: [] as KanbanEpic[],
      done: [] as KanbanEpic[],
    },
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
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: false,
  }),
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {
      tabIndex: 0,
    },
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
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

function makeEpic(overrides?: Partial<KanbanEpic>): KanbanEpic {
  return {
    id: "epic-1",
    projectId: "proj-1",
    title: "Unread Indicator Epic",
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
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    type: "feature",
    linkedEpicId: null,
    images: null,
    usCount: 1,
    usDone: 0,
    latestCommentId: "comment-1",
    latestCommentAuthor: "agent",
    latestCommentCreatedAt: "2026-02-13T10:00:00.000Z",
    ...overrides,
  };
}

function setBoardTodo(epic: KanbanEpic) {
  mockKanbanState.board = {
    columns: {
      backlog: [],
      todo: [epic],
      in_progress: [],
      review: [],
      done: [],
    },
  };
}

describe("Kanban unread AI indicator", () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockKanbanState.refresh.mockClear();
    mockKanbanState.moveEpic.mockClear();
  });

  it("shows unread indicator when latest comment is AI-origin and unseen", () => {
    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-1",
        latestCommentAuthor: "agent",
      })
    );

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();
  });

  it("does not show unread indicator when latest comment is user-originated", () => {
    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-user-1",
        latestCommentAuthor: "user",
      })
    );

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(
      screen.queryByTestId("epic-unread-ai-epic-1")
    ).not.toBeInTheDocument();
  });

  it("clears unread indicator immediately when opening the ticket card", async () => {
    const onEpicClick = vi.fn();

    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-2",
        latestCommentAuthor: "system",
      })
    );

    render(<Board projectId="proj-1" onEpicClick={onEpicClick} />);

    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Unread Indicator Epic"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("epic-unread-ai-epic-1")
      ).not.toBeInTheDocument();
    });
    expect(onEpicClick).toHaveBeenCalledWith("epic-1");
    expect(
      JSON.parse(
        sessionStorage.getItem("arij:kanban:seen-ai-comments:proj-1") || "{}"
      )
    ).toMatchObject({
      "epic-1": "comment-ai-2",
    });
  });

  it("reappears only when a newer AI/system message becomes latest", async () => {
    sessionStorage.setItem(
      "arij:kanban:seen-ai-comments:proj-1",
      JSON.stringify({ "epic-1": "comment-ai-old" })
    );

    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-old",
        latestCommentAuthor: "agent",
      })
    );

    const { rerender } = render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("epic-unread-ai-epic-1")
      ).not.toBeInTheDocument();
    });

    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-new",
        latestCommentAuthor: "status",
      })
    );
    rerender(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();
  });
});
