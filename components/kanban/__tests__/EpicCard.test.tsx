import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EpicCard } from "../EpicCard";
import type { KanbanEpic } from "@/lib/types/kanban";

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
  CSS: { Transform: { toString: () => undefined } },
}));

function makeEpic(overrides: Partial<KanbanEpic> = {}): KanbanEpic {
  return {
    id: "epic-abc123",
    projectId: "proj-1",
    title: "My Epic",
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
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    type: "feature",
    linkedEpicId: null,
    images: null,
    usCount: 3,
    usDone: 1,
    ...overrides,
  };
}

describe("EpicCard", () => {
  describe("checkbox removal", () => {
    it("does not render a checkbox button", () => {
      render(
        <EpicCard
          epic={makeEpic()}
          onToggleSelect={vi.fn()}
          selected={false}
        />
      );
      // No checkbox/square button should exist
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("does not contain Square or CheckSquare icons", () => {
      const { container } = render(
        <EpicCard
          epic={makeEpic()}
          onToggleSelect={vi.fn()}
          selected={true}
        />
      );
      // The old checkbox icons had specific classes; ensure no button with those
      expect(container.querySelector("button")).toBeNull();
    });

    it("applies ring-2 ring-primary class when selected", () => {
      const { container } = render(
        <EpicCard epic={makeEpic()} selected={true} />
      );
      const card = container.firstChild as HTMLElement;
      expect(card.className).toContain("ring-2");
      expect(card.className).toContain("ring-primary");
    });

    it("does not apply ring classes when not selected", () => {
      const { container } = render(
        <EpicCard epic={makeEpic()} selected={false} />
      );
      const card = container.firstChild as HTMLElement;
      expect(card.className).not.toContain("ring-2");
      expect(card.className).not.toContain("ring-primary");
    });

    it("calls onClick when card is clicked (selection still works)", () => {
      const handleClick = vi.fn();
      const { container } = render(
        <EpicCard epic={makeEpic()} onClick={handleClick} />
      );
      fireEvent.click(container.firstChild as HTMLElement);
      expect(handleClick).toHaveBeenCalledOnce();
    });

    it("uses additive selection on modifier click without triggering primary open", () => {
      const handleClick = vi.fn();
      const handleToggleSelect = vi.fn();
      const { container } = render(
        <EpicCard
          epic={makeEpic()}
          onClick={handleClick}
          onToggleSelect={handleToggleSelect}
        />
      );

      fireEvent.click(container.firstChild as HTMLElement, { ctrlKey: true });

      expect(handleToggleSelect).toHaveBeenCalledOnce();
      expect(handleClick).not.toHaveBeenCalled();
    });
  });

  describe("epic ID display", () => {
    it("displays the epic ID above the title in monospace text", () => {
      render(<EpicCard epic={makeEpic({ id: "epic-xyz789" })} />);
      const idEl = screen.getByText("epic-xyz789");
      expect(idEl).toBeInTheDocument();
      expect(idEl.tagName).toBe("SPAN");
      expect(idEl.className).toContain("font-mono");
      expect(idEl.className).toContain("text-xs");
      expect(idEl.className).toContain("text-muted-foreground");
    });
  });

  describe("description preview", () => {
    it("renders description when present", () => {
      render(
        <EpicCard
          epic={makeEpic({ description: "This is a description of the epic" })}
        />
      );
      const desc = screen.getByText("This is a description of the epic");
      expect(desc).toBeInTheDocument();
      expect(desc.className).toContain("line-clamp-2");
      expect(desc.className).toContain("text-xs");
      expect(desc.className).toContain("text-muted-foreground");
    });

    it("does not render description when null", () => {
      render(<EpicCard epic={makeEpic({ description: null })} />);
      // Only the title and ID text should exist, no <p> for description
      expect(screen.queryByText("", { selector: "p" })).not.toBeInTheDocument();
    });

    it("does not render description when empty string", () => {
      render(<EpicCard epic={makeEpic({ description: "" })} />);
      const paragraphs = document.querySelectorAll("p");
      expect(paragraphs).toHaveLength(0);
    });
  });
});
