/**
 * Spec page wiring for the spec-update feedback panel: once the dispatch
 * dialog reports a started session (or adopted on reload), the page polls it
 * and feeds the panel — streamed output while running, confirmation + agent
 * response on success (with the spec reloaded), error detail on failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// The editor/preview are heavy mention/markdown surfaces — the wiring under
// test only passes the spec text through, so render it assertably.
vi.mock("@/components/spec/SpecEditor", () => ({
  SpecEditor: (props: {
    value: string;
    onChange?: (val: string) => void;
    disabled?: boolean;
  }) => (
    <textarea
      data-testid="spec-editor"
      disabled={props.disabled}
      value={props.value}
      onChange={(e) => props.onChange?.(e.target.value)}
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
    onBeforeStart?: () => Promise<void>;
  }) =>
    props.open ? (
      <button
        onClick={async () => {
          await props.onBeforeStart?.();
          props.onStarted({ sessionId: "sess-1" });
        }}
      >
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
let sessionQueue: (SessionResponse | Error | "HTTP_500" | "HTTP_404")[] = [];
let patchCalls: unknown[] = [];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (init?.method === "PATCH" && urlStr.includes("/api/projects/proj-1")) {
      const body = JSON.parse(String(init.body));
      patchCalls.push(body);
      projectSpec = body.spec;
      return jsonResponse({
        data: { spec: projectSpec, updatedAt: new Date().toISOString() },
      });
    }
    if (urlStr.endsWith("/spec/update")) {
      return jsonResponse({ data: pendingUpdateInfo });
    }
    if (urlStr.endsWith("/sessions/sess-1")) {
      const next = sessionQueue.shift() ?? { status: "running" };
      if (next === "HTTP_404") {
        return jsonResponse({ error: "Session not found" }, false, 404);
      }
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

beforeEach(() => {
  vi.clearAllMocks();
  patchCalls = [];
  projectSpec = "# Spec\n\nOld content.";
  pendingUpdateInfo = { pending: false, sessionId: null, status: null };
  sessionQueue = [];
});

describe("SpecPage spec-update feedback", () => {
  it("streams the running session, disables editor/save while running, then confirms with the agent response and reloads the spec", async () => {
    render(<SpecPage pollIntervalMs={20} />);
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

    await waitFor(() =>
      expect(screen.getByTestId("spec-update-stream")).toHaveTextContent(
        "Reading board… updating specification",
      )
    );

    projectSpec = "# Spec\n\nNew content from the agent.";
    sessionQueue.push({
      status: "completed",
      logs: { result: "Updated the architecture section." },
    });

    await waitFor(() =>
      expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
        "data-status",
        "done",
      )
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
      )
    );
  });

  it("recovers an in-flight spec update session on page reload", async () => {
    pendingUpdateInfo = {
      pending: true,
      sessionId: "sess-1",
      status: "running",
    };

    render(<SpecPage pollIntervalMs={20} />);
    expect(await screen.findByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "running",
    );
    expect(screen.getByTestId("spec-editor")).toBeDisabled();
  });

  it("does not report failure on a temporary non-200 poll response", async () => {
    render(<SpecPage pollIntervalMs={20} />);
    await screen.findByTestId("spec-editor");

    fireEvent.click(screen.getByTestId("spec-update-button"));
    fireEvent.click(screen.getByText("start-update"));
    await screen.findByTestId("spec-update-progress");

    // Dev server recompile or transient 500
    sessionQueue.push("HTTP_500");

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

    await waitFor(() =>
      expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
        "data-status",
        "done",
      )
    );
  });

  it("shows the failure reason and keeps the previous spec on error", async () => {
    render(<SpecPage pollIntervalMs={20} />);
    await screen.findByTestId("spec-editor");

    fireEvent.click(screen.getByTestId("spec-update-button"));
    fireEvent.click(screen.getByText("start-update"));
    await screen.findByTestId("spec-update-progress");

    sessionQueue.push({
      status: "failed",
      error: "claude CLI exited with code 1",
    });

    await waitFor(() =>
      expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
        "data-status",
        "failed",
      )
    );
    expect(screen.getByText(/left unchanged/)).toBeInTheDocument();
    expect(screen.getByTestId("spec-update-error")).toHaveTextContent(
      "claude CLI exited with code 1",
    );
    expect(screen.getByTestId("spec-editor")).toHaveValue(
      "# Spec\n\nOld content.",
    );
  });

  it("autosaves unsaved editor changes before dispatching the update session", async () => {
    render(<SpecPage pollIntervalMs={20} />);
    const editor = await screen.findByTestId("spec-editor");
    expect(editor).toHaveValue("# Spec\n\nOld content.");

    // User types in the editor
    fireEvent.change(editor, {
      target: { value: "# Spec\n\nUser typed edits before dispatch." },
    });
    expect(editor).toHaveValue("# Spec\n\nUser typed edits before dispatch.");

    // Start update
    fireEvent.click(screen.getByTestId("spec-update-button"));
    await act(async () => {
      fireEvent.click(screen.getByText("start-update"));
    });
    expect(patchCalls[0]).toEqual({
      spec: "# Spec\n\nUser typed edits before dispatch.",
    });
  });

  it("stops polling and unlocks the editor immediately on 404 session error", async () => {
    render(<SpecPage pollIntervalMs={20} />);
    await screen.findByTestId("spec-editor");

    fireEvent.click(screen.getByTestId("spec-update-button"));
    fireEvent.click(screen.getByText("start-update"));
    expect(await screen.findByTestId("spec-update-progress")).toHaveAttribute(
      "data-status",
      "running",
    );
    expect(screen.getByTestId("spec-editor")).toBeDisabled();

    sessionQueue.push("HTTP_404");

    await waitFor(() =>
      expect(screen.getByTestId("spec-update-progress")).toHaveAttribute(
        "data-status",
        "failed",
      )
    );
    expect(screen.getByTestId("spec-update-error")).toHaveTextContent(
      "Session not found",
    );
    // Editor and save button must be re-enabled
    expect(screen.getByTestId("spec-editor")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });
});
