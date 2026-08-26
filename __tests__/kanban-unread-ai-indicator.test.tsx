import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    dependencies: [],
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
    readableId: null,
    releaseId: null,
    usCount: 1,
    usDone: 0,
    latestCommentId: "comment-1",
    latestCommentAuthor: "agent",
    latestCommentCreatedAt: "2026-02-13T10:00:00.000Z",
    lastReadAt: null,
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
      released: [],
    },
    releaseGroups: [],
  };
}

describe("Kanban unread AI indicator (ticket_read_cursors source of truth)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockKanbanState.refresh.mockClear();
    mockKanbanState.moveEpic.mockClear();
    fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), { status: 200 }) as never
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows unread indicator when the latest AI comment is newer than the read cursor", () => {
    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-1",
        latestCommentAuthor: "agent",
        latestCommentCreatedAt: "2026-02-13T10:00:00.000Z",
        lastReadAt: null,
      })
    );

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();
  });

  it("shows unread indicator when the cursor is older than the AI comment", () => {
    setBoardTodo(
      makeEpic({
        latestCommentCreatedAt: "2026-02-13T10:00:00.000Z",
        lastReadAt: "2026-02-13T09:00:00.000Z",
      })
    );

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();
  });

  it("does not show unread indicator when the cursor is newer than the AI comment", () => {
    setBoardTodo(
      makeEpic({
        latestCommentCreatedAt: "2026-02-13T10:00:00.000Z",
        lastReadAt: "2026-02-13T11:00:00.000Z",
      })
    );

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(
      screen.queryByTestId("epic-unread-ai-epic-1")
    ).not.toBeInTheDocument();
  });

  it("does not show unread indicator when latest comment is user-originated", () => {
    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-user-1",
        latestCommentAuthor: "user",
        lastReadAt: null,
      })
    );

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(
      screen.queryByTestId("epic-unread-ai-epic-1")
    ).not.toBeInTheDocument();
  });

  it("orders SQLite-format comment timestamps against ISO cursors", () => {
    // ticket_comments default CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS") vs
    // the ISO cursor written by /api/inbox/read.
    setBoardTodo(
      makeEpic({
        latestCommentCreatedAt: "2026-02-13 10:00:00",
        lastReadAt: "2026-02-13T09:00:00.000Z",
      })
    );

    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();
  });

  it("clears unread indicator immediately when opening the ticket card", async () => {
    const onEpicClick = vi.fn();

    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-2",
        latestCommentAuthor: "system",
        lastReadAt: null,
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
    // The durable cursor move (POST /api/inbox/read) is owned by EpicDetail
    // on mount — the Board itself must not fire it.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reappears only when a newer AI/system message becomes latest", async () => {
    // Server cursor covers the old comment -> starts read.
    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-old",
        latestCommentAuthor: "agent",
        latestCommentCreatedAt: "2026-02-13T10:00:00.000Z",
        lastReadAt: "2026-02-13T10:30:00.000Z",
      })
    );

    const { rerender } = render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("epic-unread-ai-epic-1")
      ).not.toBeInTheDocument();
    });

    // A newer AI comment lands after the cursor -> unread again.
    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-new",
        latestCommentAuthor: "status",
        latestCommentCreatedAt: "2026-02-13T11:00:00.000Z",
        lastReadAt: "2026-02-13T10:30:00.000Z",
      })
    );
    rerender(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();
  });

  it("re-raises the dot for a newer AI comment after a local click-clear", async () => {
    // Click clears locally (optimistic, keyed by comment id)...
    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-1",
        latestCommentAuthor: "agent",
        latestCommentCreatedAt: "2026-02-13T10:00:00.000Z",
        lastReadAt: null,
      })
    );

    const { rerender } = render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);
    fireEvent.click(screen.getByText("Unread Indicator Epic"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("epic-unread-ai-epic-1")
      ).not.toBeInTheDocument();
    });

    // ...but a NEWER comment id must override the local overlay even before
    // any server cursor lands.
    setBoardTodo(
      makeEpic({
        latestCommentId: "comment-ai-2",
        latestCommentAuthor: "agent",
        latestCommentCreatedAt: "2026-02-13T12:00:00.000Z",
        lastReadAt: null,
      })
    );
    rerender(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    expect(screen.getByTestId("epic-unread-ai-epic-1")).toBeInTheDocument();
  });
});
