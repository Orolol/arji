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

// Mock NamedAgentSelect (replaces old ProviderSelect)
vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: ({ value, onChange, className }: {
    value: string | null;
    onChange: (v: string) => void;
    className?: string;
  }) => (
    <select
      data-testid="agent-select"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Select agent</option>
      <option value="agent-1">Claude Code</option>
      <option value="agent-2">Codex Agent</option>
    </select>
  ),
}));

const baseProps = {
  projectId: "proj-1",
  story: { id: "s1", title: "Test Story", status: "todo" },
  dispatching: false,
  isRunning: false,
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

  it("opens Send to Dev dialog with agent select on click", () => {
    render(<StoryActions {...baseProps} />);
    fireEvent.click(screen.getByText("Send to Dev"));
    expect(screen.getByText("Dispatch Agent")).toBeInTheDocument();
    expect(screen.getByText("Agent:")).toBeInTheDocument();
    const selects = screen.getAllByTestId("agent-select");
    expect(selects.length).toBeGreaterThanOrEqual(1);
  });

  it("opens Agent Review dialog with agent select on click", () => {
    render(
      <StoryActions {...baseProps} story={{ ...baseProps.story, status: "review" }} />
    );
    fireEvent.click(screen.getByText("Agent Review"));
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText("Code Review")).toBeInTheDocument();
    expect(screen.getByText("Compliance / Accessibility")).toBeInTheDocument();
    const selects = screen.getAllByTestId("agent-select");
    expect(selects.length).toBeGreaterThanOrEqual(1);
  });

  it("calls onSendToDev with null namedAgentId when no agent selected", async () => {
    const onSendToDev = vi.fn().mockResolvedValue(undefined);
    render(<StoryActions {...baseProps} onSendToDev={onSendToDev} />);

    fireEvent.click(screen.getByText("Send to Dev"));
    fireEvent.click(screen.getByText("Dispatch Agent"));

    // Called with undefined comment and null namedAgentId (default)
    expect(onSendToDev).toHaveBeenCalledWith(undefined, null, undefined);
  });

  it("calls onSendToDev with selected namedAgentId", async () => {
    const onSendToDev = vi.fn().mockResolvedValue(undefined);
    render(<StoryActions {...baseProps} onSendToDev={onSendToDev} />);

    fireEvent.click(screen.getByText("Send to Dev"));
    const select = screen.getAllByTestId("agent-select")[0];
    fireEvent.change(select, { target: { value: "agent-1" } });
    fireEvent.click(screen.getByText("Dispatch Agent"));

    expect(onSendToDev).toHaveBeenCalledWith(undefined, "agent-1", undefined);
  });

  it("calls onSendToReview with selected types and namedAgentId", async () => {
    const onSendToReview = vi.fn().mockResolvedValue(undefined);
    render(
      <StoryActions
        {...baseProps}
        story={{ ...baseProps.story, status: "review" }}
        onSendToReview={onSendToReview}
      />
    );

    fireEvent.click(screen.getByText("Agent Review"));

    // Uncheck feature_review (default checked), check security
    const featureCheckbox = screen.getByRole("checkbox", {
      name: /feature review/i,
    });
    fireEvent.click(featureCheckbox);
    const securityCheckbox = screen.getByRole("checkbox", { name: /security/i });
    fireEvent.click(securityCheckbox);

    fireEvent.click(screen.getByText("Run Review (1)"));

    expect(onSendToReview).toHaveBeenCalledWith(["security"], null, undefined);
  });

  it("requires mandatory comment when sending to dev from review status", () => {
    render(
      <StoryActions {...baseProps} story={{ ...baseProps.story, status: "review" }} />
    );

    fireEvent.click(screen.getByText("Send to Dev"));

    const dispatchBtn = screen.getByText("Dispatch Agent").closest("button");
    expect(dispatchBtn).toBeDisabled();
  });
});
