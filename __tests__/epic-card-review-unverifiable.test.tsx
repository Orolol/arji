/**
 * The Review column's blocking reason.
 *
 * When an epic's last review filed nothing through `submit_findings`, the
 * gates refuse it silently — the merge never happens and Approve 400s. The
 * card is where the operator finds out why without opening the ticket, so
 * the badge is scoped to the one column where "waiting on a review" is the
 * ticket's actual state.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

import { EpicCard } from "@/components/kanban/EpicCard";
import type { KanbanEpic } from "@/lib/types/kanban";

function makeEpic(overrides?: Partial<KanbanEpic>): KanbanEpic {
  return {
    id: "epic-1",
    projectId: "proj-1",
    title: "Providers Documentation",
    description: null,
    priority: 1,
    status: "review",
    position: 0,
    branchName: "feature/providers-documentation",
    confidence: null,
    evidence: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    createdAt: "2026-08-20",
    updatedAt: "2026-08-20",
    usCount: 0,
    usDone: 0,
    type: "feature",
    linkedEpicId: null,
    images: null,
    readableId: "E-arij-1",
    releaseId: null,
    ...overrides,
  };
}

const BADGE = "epic-review-unverifiable-epic-1";

describe("EpicCard — unverifiable review", () => {
  it("flags a review-column epic whose last review filed no verdict", () => {
    render(<EpicCard epic={makeEpic({ reviewUnverifiable: true })} />);
    const badge = screen.getByTestId(BADGE);
    expect(badge).toHaveTextContent("Review unverifiable");
    expect(badge.getAttribute("title")).toContain("submit_findings");
  });

  it("stays quiet when the review delivered its verdict", () => {
    render(<EpicCard epic={makeEpic({ reviewUnverifiable: false })} />);
    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });

  it("stays quiet on a board that never reported the flag", () => {
    render(<EpicCard epic={makeEpic()} />);
    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });

  it("stays quiet outside the Review column", () => {
    // The same epic in In Progress is not waiting on anything a reviewer
    // said, so the blocking reason would be noise.
    render(
      <EpicCard
        epic={makeEpic({ status: "in_progress", reviewUnverifiable: true })}
      />
    );
    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });
});
