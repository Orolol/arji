/**
 * The Column drop placeholder marks the slot a dragged card would land in.
 *
 * The load-bearing assertion in every case below is ORDER, not presence.
 * Dropping on the column body (rather than onto another card) resolves to
 * `targetIndex = board.columns[target].length` in the Board's
 * `handleDragEnd` — an append. So the placeholder has to trail the cards; a
 * placeholder drawn above them promises a rank the drop will not deliver.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Column } from "@/components/kanban/Column";
import type { KanbanEpic } from "@/lib/types/kanban";

let mockIsOver = false;

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: mockIsOver,
  }),
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

function makeEpic(id: string): KanbanEpic {
  return {
    id,
    projectId: "proj-1",
    title: `Epic ${id}`,
    description: null,
    priority: 0,
    status: "in_progress",
    position: 0,
    branchName: null,
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
    readableId: `E-${id}`,
    releaseId: null,
    usCount: 1,
    usDone: 0,
  };
}

/** True when `a` appears strictly before `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return Boolean(
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
  );
}

describe("Column — drop placeholder", () => {
  beforeEach(() => {
    mockIsOver = false;
  });

  it("renders the placeholder AFTER every card in a flat column, matching the append the drop performs", () => {
    mockIsOver = true;

    render(
      <Column
        status="in_progress"
        epics={[makeEpic("1"), makeEpic("2")]}
        onEpicClick={vi.fn()}
      />
    );

    const placeholder = screen.getByTestId("column-drop-target-in_progress");
    const lastCard = screen.getByText("Epic 2");

    expect(precedes(lastCard, placeholder)).toBe(true);
    expect(precedes(placeholder, lastCard)).toBe(false);
  });

  it("does not render the placeholder when the column is not hovered", () => {
    mockIsOver = false;

    render(
      <Column
        status="in_progress"
        epics={[makeEpic("1")]}
        onEpicClick={vi.fn()}
      />
    );

    expect(
      screen.queryByTestId("column-drop-target-in_progress")
    ).not.toBeInTheDocument();
  });

  it("renders the placeholder inside the empty state, replacing the capture invitation", () => {
    mockIsOver = true;

    render(<Column status="in_progress" epics={[]} onEpicClick={vi.fn()} />);

    const placeholder = screen.getByTestId("column-drop-target-in_progress");
    expect(
      screen.getByTestId("column-empty-in_progress")
    ).toContainElement(placeholder);
    // An empty column normally invites a quick capture; while a card hovers,
    // the slot it would land in is the only thing worth showing.
    expect(screen.queryByText("Capture")).not.toBeInTheDocument();
  });

  it("renders the placeholder in the LAST section of a split column, not the accented first one", () => {
    mockIsOver = true;
    const ready = makeEpic("1");
    const inReview = makeEpic("2");

    render(
      <Column
        status="review"
        epics={[ready, inReview]}
        sections={[
          { key: "ready", label: "Ready to merge", epics: [ready], accent: true },
          { key: "in-review", label: "In review", epics: [inReview] },
        ]}
        onEpicClick={vi.fn()}
      />
    );

    const placeholder = screen.getByTestId("column-drop-target-review");
    // The append lands at the end of the column, which is the end of the
    // last section — putting the slot anywhere else would suggest a drop
    // could choose its section, and section membership is derived.
    expect(
      screen.getByTestId("column-section-review-in-review")
    ).toContainElement(placeholder);
    expect(
      screen.getByTestId("column-section-review-ready")
    ).not.toContainElement(placeholder);
    expect(precedes(screen.getByText("Epic 2"), placeholder)).toBe(true);
  });
});
