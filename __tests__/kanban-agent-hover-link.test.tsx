import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { EpicCard } from "@/components/kanban/EpicCard";
import { AgentMonitor } from "@/components/monitor/AgentMonitor";

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
  title: "Hover Link Epic",
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
  usCount: 2,
  usDone: 0,
  type: "feature",
  linkedEpicId: null,
  images: null,
};

const activities = [
  {
    id: "sess-1",
    epicId: "epic-1",
    userStoryId: null,
    type: "build" as const,
    label: "Building: Hover Link Epic",
    status: "running",
    mode: "code",
    provider: "codex",
    startedAt: "2026-02-13T12:00:00.000Z",
    source: "db" as const,
    cancellable: true,
  },
  {
    id: "sess-2",
    epicId: "epic-2",
    userStoryId: null,
    type: "review" as const,
    label: "Reviewing: Another Epic",
    status: "running",
    mode: "plan",
    provider: "claude-code",
    startedAt: "2026-02-13T12:05:00.000Z",
    source: "db" as const,
    cancellable: true,
  },
];

function HoverLinkHarness({ withLinkedAgent = true }: { withLinkedAgent?: boolean }) {
  const [highlightedActivityId, setHighlightedActivityId] = useState<string | null>(
    null
  );

  return (
    <div>
      <EpicCard
        epic={baseEpic}
        activeAgentActivity={
          withLinkedAgent
            ? {
                sessionId: "sess-1",
                actionType: "build",
                agentName: "Codex agent 123abc",
              }
            : undefined
        }
        onLinkedAgentHoverChange={setHighlightedActivityId}
      />
      <button data-testid="outside-focus-target">Outside focus</button>
      <AgentMonitor
        projectId="proj-1"
        activities={activities}
        highlightedActivityId={highlightedActivityId}
      />
    </div>
  );
}

describe("Kanban card to agent monitor hover link", () => {
  it("highlights linked agent on mouse enter and clears on leave", () => {
    render(<HoverLinkHarness />);

    const card = screen
      .getByText("Hover Link Epic")
      .closest('[data-slot="card"]') as HTMLElement;

    const linkedRow = screen.getByTestId("agent-monitor-activity-sess-1");
    const otherRow = screen.getByTestId("agent-monitor-activity-sess-2");

    expect(linkedRow.className).not.toContain("bg-primary/10");
    expect(otherRow.className).not.toContain("bg-primary/10");

    fireEvent.mouseEnter(card);
    expect(linkedRow.className).toContain("bg-primary/10");
    expect(otherRow.className).not.toContain("bg-primary/10");

    fireEvent.mouseLeave(card);
    expect(linkedRow.className).not.toContain("bg-primary/10");
  });

  it("highlights linked agent on focus and clears on blur", () => {
    render(<HoverLinkHarness />);

    const card = screen
      .getByText("Hover Link Epic")
      .closest('[data-slot="card"]') as HTMLElement;
    const linkedRow = screen.getByTestId("agent-monitor-activity-sess-1");
    const outside = screen.getByTestId("outside-focus-target");

    fireEvent.focus(card);
    expect(linkedRow.className).toContain("bg-primary/10");

    fireEvent.blur(card, { relatedTarget: outside });
    expect(linkedRow.className).not.toContain("bg-primary/10");
  });

  it("does not highlight any row when the card has no linked active agent", () => {
    render(<HoverLinkHarness withLinkedAgent={false} />);

    const card = screen
      .getByText("Hover Link Epic")
      .closest('[data-slot="card"]') as HTMLElement;
    const linkedRow = screen.getByTestId("agent-monitor-activity-sess-1");
    const otherRow = screen.getByTestId("agent-monitor-activity-sess-2");

    fireEvent.mouseEnter(card);
    expect(linkedRow.className).not.toContain("bg-primary/10");
    expect(otherRow.className).not.toContain("bg-primary/10");

    fireEvent.focus(card);
    expect(linkedRow.className).not.toContain("bg-primary/10");
    expect(otherRow.className).not.toContain("bg-primary/10");
  });
});
