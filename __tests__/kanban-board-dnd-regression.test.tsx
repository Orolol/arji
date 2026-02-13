import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Board } from "@/components/kanban/Board";

const mockKanban = vi.hoisted(() => ({
  board: {
    columns: {
      backlog: [],
      todo: [
        {
          id: "epic-1",
          projectId: "proj-1",
          title: "Epic One",
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
        },
        {
          id: "epic-2",
          projectId: "proj-1",
          title: "Epic Two",
          description: null,
          priority: 1,
          status: "todo",
          position: 1,
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
        },
      ],
      in_progress: [],
      review: [],
      done: [],
    },
  },
  loading: false,
  moveEpic: vi.fn(),
  refresh: vi.fn(),
}));

const dndHandlers = vi.hoisted(() => ({
  onDragEnd: null as ((event: { active: { id: string }; over: { id: string } | null }) => void) | null,
}));

vi.mock("@/hooks/useKanban", () => ({
  useKanban: () => mockKanban,
}));

vi.mock("@/components/kanban/Column", () => ({
  Column: () => <div data-testid="kanban-column" />,
}));

vi.mock("@/components/kanban/EpicCard", () => ({
  EpicCard: () => <div data-testid="epic-card-overlay" />,
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
}));

vi.mock("@dnd-kit/sortable", () => ({
  sortableKeyboardCoordinates: vi.fn(),
}));

describe("Board drag-and-drop regression", () => {
  beforeEach(() => {
    mockKanban.moveEpic.mockClear();
    dndHandlers.onDragEnd = null;
  });

  it("keeps moveEpic wiring intact when dropping an epic into another column", () => {
    render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);

    act(() => {
      dndHandlers.onDragEnd?.({
        active: { id: "epic-1" },
        over: { id: "done" },
      });
    });

    expect(mockKanban.moveEpic).toHaveBeenCalledWith("epic-1", "todo", "done", 0);
  });
});
