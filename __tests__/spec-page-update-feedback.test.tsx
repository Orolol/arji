/**
 * Spec page wiring for the spec-update feedback panel: once the dispatch
 * dialog reports a started session, the page polls it and feeds the panel —
 * streamed output while running, confirmation + agent response on success
 * (with the spec reloaded), error detail on failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

// The editor/preview are heavy mention/markdown surfaces — the wiring under
// test only passes the spec text through, so render it assertably.
vi.mock("@/components/spec/SpecEditor", () => ({
  SpecEditor: (props: { value: string }) => (
    <textarea data-testid="spec-editor" readOnly value={props.value} />
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
let sessionQueue: SessionResponse[] = [];

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    if (String(url).endsWith("/sessions/sess-1")) {
      return jsonResponse({
        data: sessionQueue.shift() ?? { status: "running" },
      });
    }
    if (String(url).includes("/api/projects/proj-1")) {
      return jsonResponse({
        data: { spec: projectSpec, updatedAt: "2026-01-01T00:00:00.000Z" },
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch,
);

/** One poll tick (~2s backoff inside the page). */
async function tick() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 2100);
  await act(async () => {
    await promise;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  projectSpec = "# Spec\n\nOld content.";
  sessionQueue = [];
});

describe("SpecPage spec-update feedback", () => {
  it("streams the running session, then confirms with the agent response and reloads the spec", async () => {
    render(<SpecPage />);
    const editor = await screen.findByTestId("spec-editor");
    expect(editor).toHaveValue("# Spec\n\nOld content.");

    fireEvent.click(screen.getByTestId("spec-update-button"));
    fireEvent.click(screen.getByText("start-update"));
    expect(await screen.findByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "running",
    );

    sessionQueue.push({
      status: "running",
      chunkStreams: {
        output: [
          { content: "Reading board… " },
          { content: "rewriting SPEC.md" },
        ],
      },
    });
    await tick();
    expect(screen.getByTestId("spec-update-stream")).toHaveTextContent(
      "Reading board… rewriting SPEC.md",
    );

    projectSpec = "# Spec\n\nNew content from the agent.";
    sessionQueue.push({
      status: "completed",
      logs: { result: "Updated the architecture section." },
    });
    await tick();

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
    // The spec shown in the editor was reloaded after the successful run.
    await waitFor(() =>
      expect(screen.getByTestId("spec-editor")).toHaveValue(
        "# Spec\n\nNew content from the agent.",
      ),
    );
  }, 15000);

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
    await tick();

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
  }, 15000);

  it("hides the panel again after dismissing a terminal result", async () => {
    render(<SpecPage />);
    await screen.findByTestId("spec-editor");

    fireEvent.click(screen.getByTestId("spec-update-button"));
    fireEvent.click(screen.getByText("start-update"));
    await screen.findByTestId("spec-update-progress");

    sessionQueue.push({ status: "completed", logs: { result: "done" } });
    await tick();
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
  }, 15000);
});
