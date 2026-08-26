/**
 * Tests for kanban animation behaviors:
 * - EpicCard highlight prop triggers visual highlight class
 * - Column detects new arrivals and highlights them
 * - Reduced motion preference removes animations
 * - Agent activity pulsing indicator
 */

import { describe, it, expect, vi } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { EpicCard } from "@/components/kanban/EpicCard";
import type { KanbanEpic } from "@/lib/types/kanban";

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
  CSS: { Transform: { toString: () => undefined } },
}));

// Mock tooltip to render children without Radix portals
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div data-testid="tooltip-content">{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function makeEpic(overrides?: Partial<KanbanEpic>): KanbanEpic {
  return {
    id: "epic-1",
    projectId: "proj-1",
    title: "Test Epic",
    description: null,
    priority: 0,
    status: "backlog",
    position: 0,
    branchName: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    confidence: null,
    evidence: null,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    type: "feature",
    linkedEpicId: null,
    images: null,
    readableId: "E-1",
    releaseId: null,
    usCount: 2,
    usDone: 0,
    ...overrides,
  };
}

describe("EpicCard — highlight animation", () => {
  it("applies highlight classes when highlight=true", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <EpicCard epic={makeEpic()} />
    );

    // Initially no highlight
    const card = container.firstElementChild!;
    expect(card.className).not.toContain("ring-primary/70");

    // Re-render with highlight=true — triggers the useEffect
    rerender(<EpicCard epic={makeEpic()} highlight={true} />);

    // The useEffect sets isHighlighted = true
    expect(card.className).toContain("ring-primary/70");

    // After 1500ms the highlight should clear
    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(card.className).not.toContain("ring-primary/70");
    vi.useRealTimers();
  });

  it("includes motion-reduce classes for accessibility", () => {
    const { container } = render(
      <EpicCard epic={makeEpic()} />
    );

    const card = container.firstElementChild!;
    expect(card.className).toContain("motion-reduce:transition-none");
  });

  it("passes highlight prop without crashing", () => {
    const { container } = render(
      <EpicCard epic={makeEpic()} highlight={false} />
    );

    expect(container.firstElementChild).toBeTruthy();
  });
});

describe("EpicCard — agent activity indicator", () => {
  it("shows the breathing dot and an indeterminate progress track when an agent is active", () => {
    const { container } = render(
      <EpicCard
        epic={makeEpic()}
        view={{
          activity: {
            sessionId: "session-1",
            actionType: "build",
            agentName: "Test Agent",
            provider: "claude-code",
            startedAt: new Date().toISOString(),
          },
        }}
      />
    );

    const activityEl = container.querySelector('[data-testid="epic-activity-epic-1"]');
    expect(activityEl).toBeTruthy();
    // The ambient-activity signal: a breathing dot on the status line...
    expect(activityEl!.querySelector(".breathing-dot")).toBeTruthy();
    // ...and the shared 2px crawl track underneath it.
    expect(container.querySelector(".progress-track .crawl-fill")).toBeTruthy();
  });

  it("names the running action and the agent name on the card", () => {
    render(
      <EpicCard
        epic={makeEpic()}
        view={{
          activity: {
            sessionId: "session-1",
            actionType: "build",
            agentName: "Test Agent",
            provider: "claude-code",
            startedAt: new Date().toISOString(),
          },
        }}
      />
    );

    const line = screen.getByTestId("epic-activity-epic-1");
    expect(line.textContent).toContain("Build");
    expect(line.textContent).toContain("Test Agent");
    expect(line.textContent).not.toContain("Claude Code");
    expect(line).toHaveAttribute("aria-label", "Build active: Test Agent");
  });

  it("shows tooltip content with provider and agent name", () => {
    const { getByTestId } = render(
      <EpicCard
        epic={makeEpic()}
        view={{
          activity: {
            sessionId: "session-1",
            actionType: "review",
            agentName: "Review Bot",
            provider: "gemini-cli",
            startedAt: new Date().toISOString(),
          },
        }}
      />
    );

    const tooltip = getByTestId("tooltip-content");
    expect(tooltip.textContent).toContain("Review");
    expect(tooltip.textContent).toContain("Review Bot");
    expect(tooltip.textContent).toContain("Gemini");
  });

  it("does not show activity indicator when no agent is active", () => {
    const { container } = render(
      <EpicCard epic={makeEpic()} />
    );

    const activityEl = container.querySelector('[data-testid="epic-activity-epic-1"]');
    expect(activityEl).toBeNull();
  });
});
