/**
 * Spec page wiring for the spec-update feedback panel: once the dispatch
 * dialog reports a started session (or adopted on reload), the page polls it
 * and feeds the panel — streamed output while running, confirmation + agent
 * response on success (with the spec reloaded), error detail on failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

// The editor/preview are heavy mention/markdown surfaces — the wiring under
// test only passes the spec text through, so render it assertably.
vi.mock("@/components/spec/SpecEditor", () => ({
  SpecEditor: (props: { value: string; disabled?: boolean }) => (
    <textarea
      data-testid="spec-editor"
      readOnly
      disabled={props.disabled}
      value={props.value}
    />
  ),
}));
vi.mock("@/components/spec/SpecPreview", () => ({
  SpecPreview: () => <div data-testid="spec-preview" />,
}));

// The dialog is covered by its own suite; here it is just the trigger that
// hands the dispatched session id to the page.
vi.mock("@/components/spec/SpecUpdateDialog", () => ({
  SpecUpdateDialog: (props: {
    open: boolean;
    onStarted: (data: { sessionId: string }) => void;
  }) =>
    props.open ? (
      <button onClick={() => props.onStarted({ sessionId: "sess-1" })}>
        start-update
      </button>
    ) : null,
}));
import SpecPage from "@/app/projects/[projectId]/spec/page";

type SessionResponse = Record<string, unknown>;

let projectSpec = "# Spec\n\nOld content.";
let pendingUpdateInfo: { pending: boolean; sessionId: string | null; status: string | null } = {
  pending: false,
  sessionId: null,
  status: null,
};
let sessionQueue: (SessionResponse | Error | "HTTP_500")[] = [];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/spec/update")) {
      return jsonResponse({ data: pendingUpdateInfo });
    }
    if (urlStr.endsWith("/sessions/sess-1")) {
      const next = sessionQueue.shift() ?? { status: "running" };
      if (next === "HTTP_500") {
        return jsonResponse({ error: "Internal error" }, false, 500);
      }
      if (next instanceof Error) {
        throw next;
      }
      return jsonResponse({ data: next });
    }
    if (urlStr.includes("/api/projects/proj-1")) {
      return jsonResponse({
        data: { spec: projectSpec, updatedAt: "2026-01-01T00:00:00.000Z" },
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch,
);

async function advanceTimer() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  projectSpec = "# Spec\n\nOld content.";
  pendingUpdateInfo = { pending: false, sessionId: null, status: null };
  sessionQueue = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SpecPage spec-update feedback", () => {
  it("streams the running session, disables editor/save while running, then confirms with the agent response and reloads the spec", async () => {
    render(<SpecPage />);
    const editor = await screen.findByTestId("spec-editor");
    expect(editor).toHaveValue("# Spec\n\nOld content.");
    expect(editor).not.toBeDisabled();
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("spec-update-button"));
    fireEvent.click(screen.getByText("start-update"));
    expect(await screen.findByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "running",
    );
    expect(editor).toBeDisabled();
    expect(saveButton).toBeDisabled();

    sessionQueue.push({
      status: "running",
      chunkStreams: {
        output: [
          { content: "Reading board… " },
          { content: "updating specification" },
        ],
      },
    });
    await advanceTimer();
    expect(screen.getByTestId("spec-update-stream")).toHaveTextContent(
      "Reading board… updating specification",
    );

    projectSpec = "# Spec\n\nNew content from the agent.";
    sessionQueue.push({
      status: "completed",
      logs: { result: "Updated the architecture section." },
    });
    await advanceTimer();

    await waitFor(() =>
      expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
        "data-status",
        "done",
      ),
    );
    expect(screen.getByText("Spec updated by agent.")).toBeInTheDocument();
    expect(screen.getByTestId("spec-update-response")).toHaveTextContent(
      "Updated the architecture section.",
    );
    expect(editor).not.toBeDisabled();
    expect(saveButton).not.toBeDisabled();

    // The spec shown in the editor was reloaded after the successful run.
    await waitFor(() =>
      expect(screen.getByTestId("spec-editor")).toHaveValue(
        "# Spec\n\nNew content from the agent.",
      ),
    );
  });

  it("recovers an in-flight spec update session on page reload", async () => {
    pendingUpdateInfo = {
      pending: true,
      sessionId: "sess-1",
      status: "running",
    };

    render(<SpecPage />);
    expect(await screen.findByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "running",
    );
    expect(screen.getByTestId("spec-editor")).toBeDisabled();
  });

  it("does not report failure on a temporary non-200 poll response", async () => {
    render(<SpecPage />);
    await screen.findByTestId("spec-editor");

    fireEvent.click(screen.getByTestId("spec-update-button"));
    fireEvent.click(screen.getByText("start-update"));
    await screen.findByTestId("spec-update-progress");

    // Dev server recompile or transient 500
    sessionQueue.push("HTTP_500");
    await advanceTimer();

    // Still running, not failed
    expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "running",
    );

    // Follow-up successful poll completes normally
    projectSpec = "# Spec\n\nUpdated.";
    sessionQueue.push({
      status: "completed",
      logs: { result: "All done." },
    });
    await advanceTimer();

    await waitFor(() =>
      expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
        "data-status",
        "done",
      ),
    );
  });

  it("shows the failure reason and keeps the previous spec on error", async () => {
    render(<SpecPage />);
    await screen.findByTestId("spec-editor");

    fireEvent.click(screen.getByTestId("spec-update-button"));
    fireEvent.click(screen.getByText("start-update"));
    await screen.findByTestId("spec-update-progress");

    sessionQueue.push({
      status: "failed",
      error: "claude CLI exited with code 1",
    });
    await advanceTimer();

    await waitFor(() =>
      expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
        "data-status",
        "failed",
      ),
    );
    expect(screen.getByText(/left unchanged/)).toBeInTheDocument();
    expect(screen.getByTestId("spec-update-error")).toHaveTextContent(
      "claude CLI exited with code 1",
    );
    expect(screen.getByTestId("spec-editor")).toHaveValue(
      "# Spec\n\nOld content.",
    );
  });

  it("hides the panel again after dismissing a terminal result", async () => {
    render(<SpecPage />);
    await screen.findByTestId("spec-editor");

    fireEvent.click(screen.getByTestId("spec-update-button"));
    fireEvent.click(screen.getByText("start-update"));
    await screen.findByTestId("spec-update-progress");

    sessionQueue.push({ status: "completed", logs: { result: "done" } });
    await advanceTimer();
    await waitFor(() =>
      expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
        "data-status",
        "done",
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss spec update result" }),
    );
    expect(screen.queryByTestId("spec-update-progress")).toBeNull();
  });
});
