/**
 * The board-header "Agent Refinement" button.
 *
 * The behaviours the story asks for: it dispatches a session, it is disabled
 * with a visible indicator while a pass is in flight — including a pass this
 * component did not start, which is why the in-flight state is read from the
 * server — and session errors surface through the page's notification rail
 * rather than being swallowed.
 */
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RefinementButton } from "@/components/kanban/RefinementButton";
import { mockFetchSequence } from "@/__tests__/helpers/mock-fetch";

const originalFetch = global.fetch;

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
      // The dispatch flips the button to running, which re-runs its status
      // effect. That read is a GET and needs a status body: answering it with
      // the POST payload above leaves `running` undefined, which the button
      // reads as "the pass ended".
      running("s-42"),
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
      // The dispatch flips the button to running, which re-runs its status
      // effect. That read is a GET and needs a status body: answering it with
      // the POST payload above leaves `running` undefined, which the button
      // reads as "the pass ended".
      running("s-42"),
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

  it("reports an empty board as a notice, not a failure", async () => {
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
    const onNotice = vi.fn();

    render(
      <RefinementButton
        projectId="proj-1"
        onError={onError}
        onNotice={onNotice}
        pollIntervalMs={0}
      />
    );

    fireEvent.click(await screen.findByTestId("refinement-button"));

    // A 200 saying "nothing to do" is an answer, not a red toast.
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        "Refinement skipped — Backlog and To do are both empty."
      )
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("falls back to onError when no notice handler is wired", async () => {
    mockFetchSequence([
      idle(0),
      {
        ok: true,
        body: { data: { started: false, reason: "Nothing to refine" } },
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
      expect(onError).toHaveBeenCalledWith("Nothing to refine")
    );
  });

  it("polls slowly while idle and fast while a pass runs", async () => {
    vi.useFakeTimers();
    try {
      // Every tick is another status read of the same idle board, so the
      // steady state is the point here — hence the explicit opt-in.
      const fetchMock = mockFetchSequence([idle()], { repeatLast: true });
      render(
        <RefinementButton
          projectId="proj-1"
          onError={vi.fn()}
          pollIntervalMs={5000}
          idlePollIntervalMs={30000}
        />
      );

      // Initial read.
      await vi.advanceTimersByTimeAsync(0);
      const afterMount = fetchMock.mock.calls.length;

      // Idle: nothing at the running cadence.
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock.mock.calls.length).toBe(afterMount);

      // Only at the idle cadence.
      await vi.advanceTimersByTimeAsync(25000);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(afterMount);
    } finally {
      vi.useRealTimers();
    }
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

  /**
   * Regression: `onFinished` was called inside the `setStatus` updater.
   * React requires updaters to be pure and double-invokes them under
   * StrictMode — which the App Router enables by default — so the user got
   * two "finished" toasts and two board reloads per pass in development.
   */
  it("fires onFinished exactly once under StrictMode", async () => {
    // A controllable mock rather than a queue: StrictMode runs the effect
    // twice per mount, so a fixed sequence would desync.
    let serverSaysRunning = true;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () =>
        serverSaysRunning ? running().body : idle().body,
    })) as unknown as typeof fetch;
    const onFinished = vi.fn();

    const view = (trigger: number) => (
      <StrictMode>
        <RefinementButton
          projectId="proj-1"
          onError={vi.fn()}
          onFinished={onFinished}
          refreshTrigger={trigger}
          pollIntervalMs={0}
        />
      </StrictMode>
    );

    const { rerender } = render(view(0));
    await waitFor(() =>
      expect(screen.getByTestId("refinement-button")).toBeDisabled()
    );

    // The pass ends; the next status read sees idle.
    serverSaysRunning = false;
    rerender(view(1));

    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  /**
   * Regression: a status read that does not answer with a status must not be
   * mistaken for one. The button POSTs to the same URL it polls, so the
   * dispatch payload can come back as the answer to a status read — from a
   * queued mock, or from anything in front of the route that echoes the last
   * body. That payload has no `running` field, and reading it as a status
   * made `running` undefined, i.e. "the pass ended": the button dropped its
   * spinner and badge mid-pass and fired a spurious board reload.
   *
   * That is the mechanism behind the flake in "disables itself with a spinner
   * and badge once a pass is under way" — there the stray read is the effect
   * re-run that the running flag itself triggers, which is what this drives.
   */
  it("ignores a status read whose payload is not a status", async () => {
    const fetchMock = mockFetchSequence([
      running(),
      // Learning it is running re-runs the button's status effect. This is
      // that second read, answered with the dispatch payload.
      {
        ok: true,
        body: { data: { started: true, sessionId: "session-1", ticketCount: 5 } },
      },
    ]);
    const onFinished = vi.fn();

    render(
      <RefinementButton
        projectId="proj-1"
        onError={vi.fn()}
        onFinished={onFinished}
        pollIntervalMs={0}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("refinement-button")).toBeDisabled()
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    );
    // A settled window. Without the guard the bogus payload collapses the
    // state within a microtask of that read, so 100ms is a wide margin.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Nothing said the pass ended, so nothing about the button may change.
    expect(screen.getByTestId("refinement-button")).toBeDisabled();
    expect(screen.getByTestId("refinement-button-spinner")).toBeTruthy();
    expect(screen.getByTestId("refinement-button-badge")).toHaveTextContent(
      "running"
    );
    expect(onFinished).not.toHaveBeenCalled();
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
