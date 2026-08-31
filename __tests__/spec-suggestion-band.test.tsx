/**
 * SUGGESTION D'AGENT (frame 8b, right rail).
 *
 * There is no store of proposed spec edits, so the band hosts the one real
 * agent-proposal signal that exists — the live or just-finished spec-update
 * session — and otherwise COLLAPSES TO ITS LABEL LINE. It must never render a
 * placeholder sentence, and never a disabled `Appliquer` / `Voir le diff`:
 * a disabled control tells the user the feature exists.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SuggestionBand } from "@/components/spec/SuggestionBand";

function renderBand(over: Partial<Parameters<typeof SuggestionBand>[0]> = {}) {
  render(
    <SuggestionBand
      projectId="proj-1"
      sessionId={null}
      status={null}
      stream={null}
      response={null}
      error={null}
      onDismiss={vi.fn()}
      {...over}
    />,
  );
}

describe("SuggestionBand", () => {
  it("collapses to its label line when no spec-update session exists", () => {
    renderBand();

    expect(screen.getByText("Suggestion d'agent")).toBeInTheDocument();
    expect(screen.queryByTestId("spec-update-progress")).toBeNull();
    // Nothing else: no proposal prose, no buttons, no links.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("never seeds the frame's sample proposal or its dead actions", () => {
    renderBand();

    expect(screen.queryByText(/ARJ-113/)).toBeNull();
    expect(screen.queryByText(/Appliquer/)).toBeNull();
    expect(screen.queryByText(/Voir le diff/)).toBeNull();
  });

  it("hosts the spec-update session when there is one", () => {
    renderBand({
      sessionId: "sess-1",
      status: "running",
      stream: "Reading the board…",
    });

    const panel = screen.getByTestId("spec-update-progress");
    expect(panel).toHaveAttribute("data-status", "running");
    expect(screen.getByTestId("spec-update-stream")).toHaveTextContent(
      "Reading the board…",
    );
    // The frame's two buttons are replaced by the affordances the progress
    // panel already owns: a link to the session, and (once terminal) a dismiss.
    expect(screen.getByRole("link", { name: "view session" })).toHaveAttribute(
      "href",
      "/projects/proj-1/sessions/sess-1",
    );
  });

  it("keeps the terminal result and its dismiss inside the band", () => {
    renderBand({
      sessionId: "sess-1",
      status: "done",
      response: "Updated the architecture section.",
    });

    expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(
      screen.getByRole("button", { name: "Dismiss spec update result" }),
    ).toBeInTheDocument();
  });
});
