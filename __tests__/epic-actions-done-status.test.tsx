/**
 * Tests that EpicActions and StoryActions show the correct buttons
 * when an epic/story is in "done" status — specifically that
 * "Agent Review" is available on done items.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EpicActions } from "@/components/epic/EpicActions";
import { StoryActions } from "@/components/story/StoryActions";

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

vi.mock("@/components/shared/ProviderSelect", () => ({
  ProviderSelect: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <select
      data-testid="provider-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="claude-code">Claude Code</option>
    </select>
  ),
}));

const noop = vi.fn().mockResolvedValue(undefined);

describe("EpicActions — done status", () => {
  const baseProps = {
    projectId: "proj-1",
    epic: { id: "e1", title: "Epic", status: "done" },
    dispatching: false,
    isRunning: false,
    codexAvailable: false,
    onSendToDev: noop,
    onSendToReview: noop,
    onApprove: noop,
  };

  it("shows Agent Review button when epic is done", () => {
    render(<EpicActions {...baseProps} />);
    expect(screen.getByText("Agent Review")).toBeInTheDocument();
  });

  it("does NOT show Send to Dev button when epic is done", () => {
    render(<EpicActions {...baseProps} />);
    expect(screen.queryByText("Send to Dev")).not.toBeInTheDocument();
  });

  it("does NOT show Approve button when epic is done", () => {
    render(<EpicActions {...baseProps} />);
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });
});

describe("StoryActions — done status", () => {
  const baseProps = {
    projectId: "proj-1",
    story: { id: "s1", title: "Story", status: "done" },
    dispatching: false,
    isRunning: false,
    codexAvailable: false,
    onSendToDev: noop,
    onSendToReview: noop,
    onApprove: noop,
  };

  it("shows Agent Review button when story is done", () => {
    render(<StoryActions {...baseProps} />);
    expect(screen.getByText("Agent Review")).toBeInTheDocument();
  });

  it("does NOT show Send to Dev button when story is done", () => {
    render(<StoryActions {...baseProps} />);
    expect(screen.queryByText("Send to Dev")).not.toBeInTheDocument();
  });

  it("does NOT show Approve button when story is done", () => {
    render(<StoryActions {...baseProps} />);
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });
});
