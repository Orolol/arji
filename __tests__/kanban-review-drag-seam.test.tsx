/**
 * The seam between the Board and `useKanban`: the array the user SEES must be
 * the array the drop index is computed against.
 *
 * Every other test in this area covers one side alone — the section tests mock
 * `useKanban` out, the reorder tests call `moveEpic` with hand-picked indices.
 * The bug this file pins lived exactly in between: the Board re-derived the
 * To Merge order for display while `handleDragEnd`, the optimistic splice and
 * `persistedColumnOrder` all indexed the raw state array. They agree at load
 * and diverge after the first To Merge drag that crosses the ready boundary —
 * and nothing refetches an idle board, so they stay diverged.
 *
 * Only `fetch` and dnd-kit are stubbed here; the hook and the Board are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Board } from "@/components/kanban/Board";
import type { KanbanEpic } from "@/lib/types/kanban";
import type { MergeReadiness } from "@/lib/kanban/merge-readiness";

const dnd = vi.hoisted(() => ({
  onDragEnd: null as
    | ((event: { active: { id: string }; over: { id: string } | null }) => void)
    | null,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: ReactNode;
    onDragEnd: (event: {
      active: { id: string };
      over: { id: string } | null;
    }) => void;
  }) => {
    dnd.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
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
const BLOCKED: MergeReadiness = {
  ready: false,
  blocker: "merge_conflict",
  openFindings: 0,
};

function epic(
  id: string,
  position: number,
  mergeReadiness: MergeReadiness
): KanbanEpic {
  return {
    id,
    projectId: "proj-1",
    title: id,
    description: "d",
    priority: 0,
    status: "to_merge",
    position,
    branchName: `feature/${id}`,
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
    usCount: 0,
    usDone: 0,
    mergeReadiness,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Reorder payloads seen so far, newest last. */
function reorderPayloads(): Array<
  Array<{ id: string; status: string; position: number }>
> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/epics/reorder"))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string).items);
}

/** Persisted To Merge order implied by the latest reorder payload. */
function persistedMergeOrder(): string[] {
  const payloads = reorderPayloads();
  return payloads[payloads.length - 1]
    .filter((item) => item.status === "to_merge")
    .sort((a, b) => a.position - b.position)
    .map((item) => item.id);
}

/** To Merge card titles in the order they are actually drawn. */
function renderedOrder(): string[] {
  return screen
    .getAllByRole("heading", { level: 4 })
    .map((heading) => heading.textContent ?? "");
}

async function drag(activeId: string, overId: string) {
  await act(async () => {
    dnd.onDragEnd?.({ active: { id: activeId }, over: { id: overId } });
    // moveEpic defers the reorder POST to a macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  dnd.onDragEnd = null;
  // A (ready) floats above B and C, so the rendered column is [A, B, C]
  // while stored positions are A=0, B=1, C=2.
  const epics = [
    epic("A", 0, READY),
    epic("B", 1, BLOCKED),
    epic("C", 2, BLOCKED),
  ];
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/epics")) {
      return { ok: true, json: async () => ({ data: epics }) };
    }
    if (String(url).endsWith("/releases")) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: true, json: async () => ({ data: {} }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountBoard() {
  render(<Board projectId="proj-1" onEpicClick={vi.fn()} />);
  await waitFor(() => expect(renderedOrder()).toEqual(["A", "B", "C"]));
}

describe("To Merge drags: rendered order is the order indices mean", () => {
  it("keeps render and state in step across a drag that crosses the ready boundary", async () => {
    await mountBoard();

    // Drag the ready card to the visual bottom. It is persisted last, then
    // snaps back to the "Ready to merge" section — the advertised behaviour.
    await drag("A", "C");

    await waitFor(() => expect(reorderPayloads()).toHaveLength(1));
    expect(persistedMergeOrder()).toEqual(["B", "C", "A"]);
    // Display returns to ready-first; the state array must have followed.
    expect(renderedOrder()).toEqual(["A", "B", "C"]);
  });

  it("persists the second drag where the user aimed it, not the opposite", async () => {
    await mountBoard();

    // 1. The drag that used to leave the two arrays diverged.
    await drag("A", "C");
    await waitFor(() => expect(reorderPayloads()).toHaveLength(1));
    expect(renderedOrder()).toEqual(["A", "B", "C"]);

    // 2. Drag C onto the visually FIRST card, meaning "put C at the top".
    await drag("C", "A");
    await waitFor(() => expect(reorderPayloads()).toHaveLength(2));

    // The regression: with the arrays diverged, `handleDragEnd` read A's index
    // in the stale state array (2) and C was written to the BOTTOM, so the
    // drag looked like it did nothing.
    expect(persistedMergeOrder()[0]).toBe("C");
    // A stays drawn first because it is the only merge-ready card and the
    // section is pinned — that is the feature, not the bug. What must move is
    // C's rank among its peers, and the column the user sees.
    expect(renderedOrder()).toEqual(["A", "C", "B"]);
  });

  it("survives a third drag — the invariant is restored, not merely delayed", async () => {
    await mountBoard();

    await drag("A", "C");
    await waitFor(() => expect(reorderPayloads()).toHaveLength(1));
    await drag("C", "A");
    await waitFor(() => expect(reorderPayloads()).toHaveLength(2));

    // Move B to the top of the displayed column.
    const first = renderedOrder()[0];
    await drag("B", first);
    await waitFor(() => expect(reorderPayloads()).toHaveLength(3));

    expect(persistedMergeOrder()[0]).toBe("B");
    expect(renderedOrder()).toEqual(["A", "B", "C"]);
    // Every card is still accounted for exactly once.
    expect([...persistedMergeOrder()].sort()).toEqual(["A", "B", "C"]);
  });

  it("never writes a To Merge position that encodes readiness", async () => {
    await mountBoard();

    await drag("A", "C");
    await waitFor(() => expect(reorderPayloads()).toHaveLength(1));

    // A is the only ready card. If readiness leaked into `position` it would
    // be persisted at 0 (its display index) rather than where it was dropped.
    const items = reorderPayloads()[0].filter((i) => i.status === "to_merge");
    expect(items.find((i) => i.id === "A")?.position).toBe(2);
  });
});
