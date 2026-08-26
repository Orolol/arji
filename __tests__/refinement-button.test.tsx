/**
 * The board-header "Agent Refinement" button.
 *
 * The behaviours the story asks for: it dispatches a session, it is disabled
 * with a visible indicator while a pass is in flight — including a pass this
 * component did not start, which is why the in-flight state is read from the
 * server — and session errors surface through the page's notification rail
 * rather than being swallowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RefinementButton } from "@/components/kanban/RefinementButton";

const originalFetch = global.fetch;

/** Queue of responses, consumed in order; the last one repeats. */
function mockFetchSequence(responses: Array<{ ok: boolean; body: unknown }>) {
  let index = 0;
  const fetchMock = vi.fn(async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: response.ok,
      json: async () => response.body,
    } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function idle(ticketCount = 5) {
  return {
    ok: true,
    body: { data: { running: false, sessionId: null, ticketCount } },
  };
}

function running(sessionId = "session-1") {
  return {
    ok: true,
    body: { data: { running: true, sessionId, ticketCount: 5 } },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("RefinementButton", () => {
  it("renders enabled when no pass is running", async () => {
    mockFetchSequence([idle()]);
    render(
      <RefinementButton
        projectId="proj-1"
        onError={vi.fn()}
        pollIntervalMs={0}
      />
    );

    const button = await screen.findByTestId("refinement-button");
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveTextContent("Agent Refinement");
    expect(screen.queryByTestId("refinement-button-badge")).toBeNull();
  });

  it("POSTs the refinement route and reports the session id", async () => {
    const fetchMock = mockFetchSequence([
      idle(),
      {
        ok: true,
        body: { data: { started: true, sessionId: "s-42", ticketCount: 5 } },
      },
    ]);
    const onStarted = vi.fn();

    render(
      <RefinementButton
        projectId="proj-1"
        onError={vi.fn()}
        onStarted={onStarted}
        pollIntervalMs={0}
      />
    );

    fireEvent.click(await screen.findByTestId("refinement-button"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/proj-1/refinement",
        expect.objectContaining({ method: "POST" })
      )
    );
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("s-42"));
  });

  it("disables itself with a spinner and badge once a pass is under way", async () => {
    mockFetchSequence([
      idle(),
      {
        ok: true,
        body: { data: { started: true, sessionId: "s-42", ticketCount: 5 } },
      },
    ]);

    render(
      <RefinementButton
        projectId="proj-1"
        onError={vi.fn()}
        pollIntervalMs={0}
      />
    );

    fireEvent.click(await screen.findByTestId("refinement-button"));

    await waitFor(() => {
      expect(screen.getByTestId("refinement-button")).toBeDisabled();
    });
    expect(screen.getByTestId("refinement-button-spinner")).toBeTruthy();
    expect(screen.getByTestId("refinement-button-badge")).toHaveTextContent(
      "running"
    );
  });

  it("starts disabled for a pass it did not launch", async () => {
    mockFetchSequence([running("elsewhere")]);

    render(
      <RefinementButton
        projectId="proj-1"
        onError={vi.fn()}
        pollIntervalMs={0}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("refinement-button")).toBeDisabled()
    );
  });

  it("surfaces a dispatch failure through onError", async () => {
    mockFetchSequence([
      idle(),
      {
        ok: false,
        body: {
          error: "A board refinement pass is already running for this project.",
          code: "REFINEMENT_ALREADY_RUNNING",
        },
      },
    ]);
    const onError = vi.fn();

    render(
      <RefinementButton
        projectId="proj-1"
        onError={onError}
        pollIntervalMs={0}
      />
    );

    fireEvent.click(await screen.findByTestId("refinement-button"));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "A board refinement pass is already running for this project."
      )
    );
    // A refused start must not leave the button stuck in a busy state.
    await waitFor(() =>
      expect(screen.getByTestId("refinement-button")).not.toBeDisabled()
    );
  });

  it("reports an empty board as a message, not a silent no-op", async () => {
    mockFetchSequence([
      idle(0),
      {
        ok: true,
        body: {
          data: {
            started: false,
            reason: "Refinement skipped — Backlog and To do are both empty.",
          },
        },
      },
    ]);
    const onError = vi.fn();

    render(
      <RefinementButton
        projectId="proj-1"
        onError={onError}
        pollIntervalMs={0}
      />
    );

    fireEvent.click(await screen.findByTestId("refinement-button"));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "Refinement skipped — Backlog and To do are both empty."
      )
    );
  });

  it("notifies the page once a running pass finishes", async () => {
    let refreshTrigger = 0;
    mockFetchSequence([running(), idle()]);
    const onFinished = vi.fn();

    const { rerender } = render(
      <RefinementButton
        projectId="proj-1"
        onError={vi.fn()}
        onFinished={onFinished}
        refreshTrigger={refreshTrigger}
        pollIntervalMs={0}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("refinement-button")).toBeDisabled()
    );

    // Second status read: the pass has ended.
    refreshTrigger = 1;
    rerender(
      <RefinementButton
        projectId="proj-1"
        onError={vi.fn()}
        onFinished={onFinished}
        refreshTrigger={refreshTrigger}
        pollIntervalMs={0}
      />
    );

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("refinement-button")).not.toBeDisabled()
    );
  });

  it("stays usable when the status read fails", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    render(
      <RefinementButton
        projectId="proj-1"
        onError={vi.fn()}
        pollIntervalMs={0}
      />
    );

    const button = await screen.findByTestId("refinement-button");
    expect(button).not.toBeDisabled();
  });
});
