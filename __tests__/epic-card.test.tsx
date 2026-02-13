import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EpicCard } from "@/components/kanban/EpicCard";

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
      toString: () => undefined,
    },
  },
}));

const baseEpic = {
  id: "epic-1",
  projectId: "proj-1",
  title: "Epic title",
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
  it("shows running indicator when epic has active work", () => {
    render(<EpicCard epic={baseEpic} isRunning={true} />);
    expect(screen.getByTestId("epic-running-epic-1")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("hides running indicator when epic has no active work", () => {
    render(<EpicCard epic={baseEpic} isRunning={false} />);
    expect(screen.queryByTestId("epic-running-epic-1")).not.toBeInTheDocument();
  });
});
