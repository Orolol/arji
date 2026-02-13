import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

// Mock ProviderSelect to inspect props
vi.mock("@/components/shared/ProviderSelect", () => ({
  ProviderSelect: ({ value, onChange, codexAvailable, className }: {
    value: string;
    onChange: (v: string) => void;
    codexAvailable: boolean;
    className?: string;
  }) => (
    <select
      data-testid="provider-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-codex-available={String(codexAvailable)}
    >
      <option value="claude-code">Claude Code</option>
      <option value="codex">Codex</option>
    </select>
  ),
}));

const baseProps = {
  projectId: "proj-1",
  story: { id: "s1", title: "Test Story", status: "todo" },
  dispatching: false,
  isRunning: false,
  codexAvailable: true,
  onSendToDev: vi.fn().mockResolvedValue(undefined),
  onSendToReview: vi.fn().mockResolvedValue(undefined),
  onApprove: vi.fn().mockResolvedValue(undefined),
};

describe("StoryActions", () => {
  it("shows Send to Dev button for todo status", () => {
    render(<StoryActions {...baseProps} />);
    expect(screen.getByText("Send to Dev")).toBeInTheDocument();
  });

  it("shows Agent Review and Approve buttons for review status", () => {
    render(
      <StoryActions {...baseProps} story={{ ...baseProps.story, status: "review" }} />
    );
    expect(screen.getByText("Agent Review")).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
  });

  it("shows running indicator when isRunning", () => {
    render(<StoryActions {...baseProps} isRunning={true} />);
    expect(screen.getByText("Agent running")).toBeInTheDocument();
  });

  it("shows lock helper text with active session id when running", () => {
    render(
      <StoryActions
        {...baseProps}
        story={{ ...baseProps.story, status: "review" }}
        isRunning={true}
        activeSessionId="abc123xyz"
      />
    );
    expect(
      screen.getByText("Another agent is already running for this task (#abc123).")
    ).toBeInTheDocument();
  });

  it("disables action buttons when running lock is active", () => {
    render(
      <StoryActions
        {...baseProps}
        story={{ ...baseProps.story, status: "review" }}
        isRunning={true}
      />
    );
    expect(screen.getByText("Send to Dev").closest("button")).toBeDisabled();
    expect(screen.getByText("Agent Review").closest("button")).toBeDisabled();
    expect(screen.getByText("Approve").closest("button")).toBeDisabled();
  });

  it("disables Send to Dev when dispatching", () => {
    render(<StoryActions {...baseProps} dispatching={true} />);
    expect(screen.getByText("Send to Dev").closest("button")).toBeDisabled();
  });

  it("opens Send to Dev dialog with provider select on click", () => {
    render(<StoryActions {...baseProps} />);
    fireEvent.click(screen.getByText("Send to Dev"));
    // Dialog should be open with provider selector
    expect(screen.getByText("Dispatch Agent")).toBeInTheDocument();
    expect(screen.getByText("Provider:")).toBeInTheDocument();
    const selects = screen.getAllByTestId("provider-select");
    expect(selects.length).toBeGreaterThanOrEqual(1);
  });

  it("opens Agent Review dialog with provider select on click", () => {
    render(
      <StoryActions {...baseProps} story={{ ...baseProps.story, status: "review" }} />
    );
    fireEvent.click(screen.getByText("Agent Review"));
    // Dialog should be open with provider selector and review type checkboxes
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText("Code Review")).toBeInTheDocument();
    expect(screen.getByText("Compliance / Accessibility")).toBeInTheDocument();
    const selects = screen.getAllByTestId("provider-select");
    expect(selects.length).toBeGreaterThanOrEqual(1);
  });

  it("passes codexAvailable to ProviderSelect in Send to Dev dialog", () => {
    render(<StoryActions {...baseProps} codexAvailable={false} />);
    fireEvent.click(screen.getByText("Send to Dev"));
    const select = screen.getAllByTestId("provider-select")[0];
    expect(select.getAttribute("data-codex-available")).toBe("false");
  });

  it("calls onSendToDev with provider when dispatching from todo", async () => {
    const onSendToDev = vi.fn().mockResolvedValue(undefined);
    render(<StoryActions {...baseProps} onSendToDev={onSendToDev} />);

    // Open dialog
    fireEvent.click(screen.getByText("Send to Dev"));
    // Click dispatch
    fireEvent.click(screen.getByText("Dispatch Agent"));

    // Should be called with undefined comment (empty) and "claude-code" default provider
    expect(onSendToDev).toHaveBeenCalledWith(undefined, "claude-code");
  });

  it("calls onSendToDev with changed provider", async () => {
    const onSendToDev = vi.fn().mockResolvedValue(undefined);
    render(<StoryActions {...baseProps} onSendToDev={onSendToDev} />);

    // Open dialog
    fireEvent.click(screen.getByText("Send to Dev"));
    // Change provider to codex
    const select = screen.getAllByTestId("provider-select")[0];
    fireEvent.change(select, { target: { value: "codex" } });
    // Click dispatch
    fireEvent.click(screen.getByText("Dispatch Agent"));

    expect(onSendToDev).toHaveBeenCalledWith(undefined, "codex");
  });

  it("calls onSendToReview with selected types and provider", async () => {
    const onSendToReview = vi.fn().mockResolvedValue(undefined);
    render(
      <StoryActions
        {...baseProps}
        story={{ ...baseProps.story, status: "review" }}
        onSendToReview={onSendToReview}
      />
    );

    // Open Agent Review dialog
    fireEvent.click(screen.getByText("Agent Review"));

    // Select security checkbox
    const featureCheckbox = screen.getByRole("checkbox", {
      name: /feature review/i,
    });
    fireEvent.click(featureCheckbox);
    const securityCheckbox = screen.getByRole("checkbox", { name: /security/i });
    fireEvent.click(securityCheckbox);

    // Click run review
    fireEvent.click(screen.getByText("Run Review (1)"));

    expect(onSendToReview).toHaveBeenCalledWith(["security"], "claude-code");
  });

  it("requires mandatory comment when sending to dev from review status", () => {
    render(
      <StoryActions {...baseProps} story={{ ...baseProps.story, status: "review" }} />
    );

    // Open Send to Dev dialog
    fireEvent.click(screen.getByText("Send to Dev"));

    // Dispatch should be disabled without comment
    const dispatchBtn = screen.getByText("Dispatch Agent").closest("button");
    expect(dispatchBtn).toBeDisabled();
  });
});
