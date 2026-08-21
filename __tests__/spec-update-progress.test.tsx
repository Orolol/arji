/**
 * SpecUpdateProgress: the Spec view's feedback panel for a spec-update run.
 * While running it shows the streamed agent output; on success the
 * confirmation plus the agent's response; on failure the reason alongside
 * the "spec left unchanged" promise. Terminal states can be dismissed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SpecUpdateProgress } from "@/components/spec/SpecUpdateProgress";

function renderPanel(overrides: Partial<Parameters<typeof SpecUpdateProgress>[0]> = {}) {
  const props: Parameters<typeof SpecUpdateProgress>[0] = {
    projectId: "p1",
    sessionId: "s1",
    status: "running",
    stream: null,
    response: null,
    error: null,
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(<SpecUpdateProgress {...props} />);
  return props;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("SpecUpdateProgress", () => {
  it("streams the live agent output while running", () => {
    renderPanel({ status: "running", stream: "Reading SPEC.md…" });

    expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "running"
    );
    expect(screen.getByTestId("spec-update-stream")).toHaveTextContent(
      "Reading SPEC.md…"
    );
    // No result yet — neither a response nor an error pane.
    expect(screen.queryByTestId("spec-update-response")).toBeNull();
    expect(screen.queryByTestId("spec-update-error")).toBeNull();
  });

  it("shows a placeholder while the agent has not produced output yet", () => {
    renderPanel({ status: "running", stream: null });

    expect(screen.getByTestId("spec-update-stream")).toHaveTextContent(
      "Waiting for agent output"
    );
  });

  it("confirms success and shows the agent's response", () => {
    renderPanel({
      status: "done",
      stream: "# Spec\n- rewritten",
      response: "Updated the architecture section.",
    });

    expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "done"
    );
    expect(screen.getByText("Spec updated by agent.")).toBeInTheDocument();
    expect(screen.getByTestId("spec-update-response")).toHaveTextContent(
      "Updated the architecture section."
    );
    // The live stream pane is gone once the run settled.
    expect(screen.queryByTestId("spec-update-stream")).toBeNull();
  });

  it("reports failure with the session error and promises an unchanged spec", () => {
    renderPanel({
      status: "failed",
      error: "claude CLI exited with code 1",
    });

    expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "failed"
    );
    expect(screen.getByText(/left unchanged/)).toBeInTheDocument();
    expect(screen.getByTestId("spec-update-error")).toHaveTextContent(
      "claude CLI exited with code 1"
    );
    expect(screen.queryByTestId("spec-update-response")).toBeNull();
  });

  it("links to the full session page", () => {
    renderPanel();

    const link = screen.getByRole("link", { name: "view session" });
    expect(link).toHaveAttribute("href", "/projects/p1/sessions/s1");
  });

  it("dismisses a terminal result but not a running session", () => {
    const done = renderPanel({ status: "done", response: "ok" });
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss spec update result" })
    );
    expect(done.onDismiss).toHaveBeenCalledTimes(1);

    document.body.innerHTML = "";
    const running = renderPanel({ status: "running", stream: "…" });
    expect(
      screen.queryByRole("button", { name: "Dismiss spec update result" })
    ).toBeNull();
    expect(running.onDismiss).not.toHaveBeenCalled();
  });
});
