/**
 * Tests that EpicCard renders an active work indicator when isActive is true.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock dnd-kit
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => null,
    },
  },
}));

import { EpicCard } from "@/components/kanban/EpicCard";

const baseEpic = {
  id: "epic-1",
  projectId: "proj-1",
  title: "Test Epic",
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
  createdAt: "2026-02-12T00:00:00.000Z",
  updatedAt: "2026-02-12T00:00:00.000Z",
  usCount: 3,
  usDone: 1,
  type: "feature",
  linkedEpicId: null,
  images: null,
};

describe("EpicCard", () => {
  it("renders without active indicator by default", () => {
    render(<EpicCard epic={baseEpic} />);

    expect(screen.getByText("Test Epic")).toBeInTheDocument();
    expect(screen.queryByTitle("Agent running")).not.toBeInTheDocument();
  });

  it("renders active indicator when isActive is true", () => {
    render(<EpicCard epic={baseEpic} isActive={true} />);

    expect(screen.getByText("Test Epic")).toBeInTheDocument();
    const indicator = screen.getByTitle("Agent running");
    expect(indicator).toBeInTheDocument();
    expect(indicator.className).toContain("animate-pulse");
    expect(indicator.className).toContain("bg-yellow-500");
  });

  it("does not render active indicator when isActive is false", () => {
    render(<EpicCard epic={baseEpic} isActive={false} />);

    expect(screen.queryByTitle("Agent running")).not.toBeInTheDocument();
  });

  it("renders user story count", () => {
    render(<EpicCard epic={baseEpic} />);

    expect(screen.getByText("1/3 US")).toBeInTheDocument();
  });
});
