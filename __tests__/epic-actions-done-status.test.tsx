/**
 * Tests that AgentActionsBar (merged EpicActions + StoryActions) shows the
 * correct buttons when an epic/story is in "done" status — specifically that
 * "Agent Review" is available on done items.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentActionsBar } from "@/components/shared/AgentActionsBar";

vi.mock("@/components/documents/MentionTextarea", () => ({
  MentionTextarea: ({
    projectId: _projectId,
    value,
    onValueChange,
    ...props
  }: {
    projectId?: string;
    value: string;
    onValueChange: (next: string) => void;
  }) => (
    <textarea
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      {...props}
    />
  ),
}));

const noop = vi.fn().mockResolvedValue(undefined);

describe("AgentActionsBar (epic target) — done status", () => {
  const baseProps = {
    projectId: "proj-1",
    target: {
      kind: "epic" as const,
      epic: { id: "e1", title: "Epic", status: "done" },
    },
    dispatching: false,
    isRunning: false,
    codexAvailable: false,
    onSendToDev: noop,
    onSendToReview: noop,
    onComplete: noop,
  };

  it("shows Agent Review button when epic is done", () => {
    render(<AgentActionsBar {...baseProps} />);
    expect(screen.getByText("Agent Review")).toBeInTheDocument();
  });

  it("does NOT show Send to Dev button when epic is done", () => {
    render(<AgentActionsBar {...baseProps} />);
    expect(screen.queryByText("Send to Dev")).not.toBeInTheDocument();
  });

  it("does NOT show the Merge button when epic is done", () => {
    // The epic's completion action is the merge, and a done epic has already
    // merged. (There is no epic "Approve" any more either way.)
    render(<AgentActionsBar {...baseProps} />);
    expect(screen.queryByText("Merge")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });

  it("shows the Merge button when the epic is in to_merge", () => {
    render(
      <AgentActionsBar
        {...baseProps}
        target={{
          kind: "epic" as const,
          epic: { id: "e1", title: "Epic", status: "to_merge" },
        }}
      />
    );
    // The merge IS the approval: the epic's green button says Merge, never
    // Approve.
    expect(screen.getByText("Merge")).toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });
});

describe("AgentActionsBar (story target) — done status", () => {
  const baseProps = {
    projectId: "proj-1",
    target: {
      kind: "story" as const,
      story: { id: "s1", title: "Story", status: "done" },
    },
    dispatching: false,
    isRunning: false,
    codexAvailable: false,
    onSendToDev: noop,
    onSendToReview: noop,
    onComplete: noop,
  };

  it("shows Agent Review button when story is done", () => {
    render(<AgentActionsBar {...baseProps} />);
    expect(screen.getByText("Agent Review")).toBeInTheDocument();
  });

  it("does NOT show Send to Dev button when story is done", () => {
    render(<AgentActionsBar {...baseProps} />);
    expect(screen.queryByText("Send to Dev")).not.toBeInTheDocument();
  });

  it("does NOT show Approve button when story is done", () => {
    render(<AgentActionsBar {...baseProps} />);
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });

  it("still shows Approve — not Merge — for a story in review", () => {
    // Stories have no branch of their own: their completion stays an explicit
    // human approval, untouched by the epic-side merge-is-the-approval change.
    render(
      <AgentActionsBar
        {...baseProps}
        target={{
          kind: "story" as const,
          story: { id: "s1", title: "Story", status: "review" },
        }}
      />
    );
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.queryByText("Merge")).not.toBeInTheDocument();
  });
});
