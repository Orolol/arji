/**
 * Tests for the `notice` slot of AgentDispatchDialog and its wiring in
 * AgentActionsBar (review provider segregation notice).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AgentDispatchDialog } from "@/components/shared/AgentDispatchDialog";
import { AgentActionsBar } from "@/components/shared/AgentActionsBar";

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="named-agent-select" />,
}));

vi.mock("@/components/shared/SessionPicker", () => ({
  SessionPicker: () => <div data-testid="session-picker" />,
}));

vi.mock("@/components/documents/MentionTextarea", () => ({
  MentionTextarea: () => <textarea data-testid="mention-textarea" />,
}));

const baseDialogProps = {
  open: true,
  onOpenChange: vi.fn(),
  title: "Agent Review",
  projectId: "proj-1",
  agentProps: { value: null, onChange: vi.fn() },
  confirmLabel: "Run Review",
  busy: false,
  onConfirm: vi.fn(),
};

describe("AgentDispatchDialog — notice slot", () => {
  it("renders the notice text when provided", () => {
    render(
      <AgentDispatchDialog
        {...baseDialogProps}
        notice="Review by Oh My Pi (builder was Claude Code)"
      />
    );

    expect(screen.getByTestId("dispatch-notice")).toHaveTextContent(
      "Review by Oh My Pi (builder was Claude Code)"
    );
  });

  it("renders no notice element when the prop is absent", () => {
    render(<AgentDispatchDialog {...baseDialogProps} />);
    expect(screen.queryByTestId("dispatch-notice")).not.toBeInTheDocument();
  });
});

describe("AgentActionsBar — segregation notice in the review dialog", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/review-resolution")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              provider: "oh-my-pi",
              namedAgentId: null,
              name: null,
              segregated: true,
              builderProvider: "claude-code",
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ data: {} }) };
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  function renderBar() {
    return render(
      <AgentActionsBar
        projectId="proj-1"
        target={{
          kind: "epic",
          epic: { id: "epic-1", status: "review", title: "Epic" },
        }}
        dispatching={false}
        isRunning={false}
        onSendToDev={vi.fn(async () => undefined)}
        onSendToReview={vi.fn(async () => undefined)}
        onComplete={vi.fn(async () => undefined)}
      />
    );
  }

  it("shows the segregation notice when the preview reports a redirect", async () => {
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: /Agent Review/i }));

    await waitFor(() => {
      expect(screen.getByTestId("dispatch-notice")).toHaveTextContent(
        "Review by Oh My Pi (builder was Claude Code)"
      );
    });

    // Preview was requested with the epic target and a review agent type.
    const previewCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/projects/proj-1/review-resolution")
    );
    expect(previewCall).toBeTruthy();
    expect(String(previewCall![0])).toContain("epicId=epic-1");
    expect(String(previewCall![0])).toContain("agentType=review_feature");
  });

  it("shows no notice when the preview reports no segregation", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        data: {
          provider: "claude-code",
          namedAgentId: null,
          name: null,
          segregated: false,
          builderProvider: null,
        },
      }),
    }));

    renderBar();
    fireEvent.click(screen.getByRole("button", { name: /Agent Review/i }));

    // Wait for the preview fetch to settle, then assert absence.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId("dispatch-notice")).not.toBeInTheDocument()
    );
  });
});
