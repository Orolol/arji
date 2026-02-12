import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock dnd-kit
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
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

import { EpicCard } from "@/components/kanban/EpicCard";
import type { KanbanEpic } from "@/lib/types/kanban";

function makeEpic(overrides?: Partial<KanbanEpic>): KanbanEpic {
  return {
    id: "epic-1",
    projectId: "proj-1",
    title: "Test Epic",
    description: null,
    priority: 1,
    status: "in_progress",
    position: 0,
    branchName: "feature/test",
    confidence: null,
    evidence: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    usCount: 3,
    usDone: 1,
    ...overrides,
  };
}

describe("EpicCard PR badge", () => {
  it("does not show PR badge when prNumber is null", () => {
    render(<EpicCard epic={makeEpic()} />);
    expect(screen.queryByText(/#\d+/)).not.toBeInTheDocument();
  });

  it("shows PR badge with number when prNumber is set", () => {
    render(
      <EpicCard
        epic={makeEpic({
          prNumber: 42,
          prUrl: "https://github.com/org/repo/pull/42",
          prStatus: "open",
        })}
      />
    );
    expect(screen.getByText("#42")).toBeInTheDocument();
  });

  it("renders PR badge as a link to prUrl", () => {
    render(
      <EpicCard
        epic={makeEpic({
          prNumber: 10,
          prUrl: "https://github.com/org/repo/pull/10",
          prStatus: "open",
        })}
      />
    );
    const link = screen.getByText("#10").closest("a");
    expect(link).toHaveAttribute("href", "https://github.com/org/repo/pull/10");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("applies green color for open status", () => {
    render(
      <EpicCard
        epic={makeEpic({
          prNumber: 1,
          prUrl: "#",
          prStatus: "open",
        })}
      />
    );
    const link = screen.getByText("#1").closest("a");
    expect(link?.className).toContain("text-green-500");
  });

  it("applies purple color for merged status", () => {
    render(
      <EpicCard
        epic={makeEpic({
          prNumber: 1,
          prUrl: "#",
          prStatus: "merged",
        })}
      />
    );
    const link = screen.getByText("#1").closest("a");
    expect(link?.className).toContain("text-purple-500");
  });

  it("applies red color for closed status", () => {
    render(
      <EpicCard
        epic={makeEpic({
          prNumber: 1,
          prUrl: "#",
          prStatus: "closed",
        })}
      />
    );
    const link = screen.getByText("#1").closest("a");
    expect(link?.className).toContain("text-red-500");
  });

  it("applies muted color for draft status", () => {
    render(
      <EpicCard
        epic={makeEpic({
          prNumber: 1,
          prUrl: "#",
          prStatus: "draft",
        })}
      />
    );
    const link = screen.getByText("#1").closest("a");
    expect(link?.className).toContain("text-muted-foreground");
  });
});
