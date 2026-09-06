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
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RefinementButton } from "@/components/kanban/RefinementButton";
import { mockFetchSequence } from "@/__tests__/helpers/mock-fetch";

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false, refresh: vi.fn() }),
}));

vi.mock("@/hooks/useDispatchReliability", () => ({
  useDispatchReliability: () => ({
    byAgentId: new Map(), minSample: 5, windowDays: 30, loading: false,
  }),
}));

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
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/proj-1/refinement",
        expect.objectContaining({ method: "POST" })
      )
    );
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("s-42"));
  });

  /**
   * The wait condition here has to be the badge, and only the badge.
   *
   * The button has two busy states, and `disabled` and the spinner are both
   * driven by `busy = running || starting` — so both are already true while
   * the POST is merely in flight, one tick before the server has confirmed
   * anything. Waiting on either settles on that pending state and then runs
   * the remaining assertions against it, which is a race the test loses
   * whenever the dispatch takes longer than a microtask. The badge is the
   * only marker gated on `running` alone, so it is the only honest signal
   * that the pass is actually under way.
   *
   * The disabled and spinner assertions stay, after the wait: the point of
   * the test is that all three hold together once the pass is running.
   */
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
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));

    await waitFor(() => {
      expect(screen.getByTestId("refinement-button-badge")).toHaveTextContent(
        "running"
      );
    });
    expect(screen.getByTestId("refinement-button")).toBeDisabled();
    expect(screen.getByTestId("refinement-button-spinner")).toBeTruthy();
  });

  /**
   * Regression: the two busy states must stay distinguishable, and the test
   * above must keep waiting on the one marker that separates them.
   *
   * With an immediate mock the dispatch resolves inside the same microtask
   * drain as the click, so the pending window is invisible and a test that
   * waits on `disabled` or on the spinner passes by accident. Holding the
   * POST open for a macrotask makes that window real, and pins what the user
   * actually sees in it: the button is already inert and spinning — so a
   * second dispatch cannot be fired into the gap — but it does not yet claim
   * a pass is running, because no one has said so. Only the server's answer
   * promotes it to the badge.
   *
   * This is what stops the fix above from being re-relaxed: waiting on
   * `disabled` or on the spinner reddens here rather than flaking later.
   */
  it("is inert while the dispatch is in flight, and only then claims a running pass", async () => {
    mockFetchSequence([
      idle(),
      {
        ok: true,
        body: { data: { started: true, sessionId: "s-42", ticketCount: 5 } },
        // Long enough to survive a microtask drain, so the in-flight state is
        // observable instead of collapsing into the resolved one.
        delayMs: 10,
      },
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
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));

    // In flight: inert and spinning, but making no claim about a pass.
    await waitFor(() =>
      expect(screen.getByTestId("refinement-button")).toBeDisabled()
    );
    expect(screen.getByTestId("refinement-button-spinner")).toBeTruthy();
    expect(screen.queryByTestId("refinement-button-badge")).toBeNull();

    // The server answers; now — and only now — the pass is declared running.
    await waitFor(() =>
      expect(screen.getByTestId("refinement-button-badge")).toHaveTextContent(
        "running"
      )
    );
    expect(screen.getByTestId("refinement-button")).toBeDisabled();
    expect(screen.getByTestId("refinement-button-spinner")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));
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

describe("REfinment 2 — configuration dialog", () => {
  it("opens without dispatching and cancels without dispatching", async () => {
    const fetchMock = mockFetchSequence([idle()]);
    render(<RefinementButton projectId="proj-1" onError={vi.fn()} pollIntervalMs={0} />);
    fireEvent.click(await screen.findByTestId("refinement-button"));
    expect(screen.getByRole("dialog", { name: "Configure board refinement" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("requires a checked action and submits only the chosen actions plus instructions", async () => {
    const fetchMock = mockFetchSequence([idle(), { ok: true, body: { data: { started: true, sessionId: "s-config" } } }, running("s-config")]);
    render(<RefinementButton projectId="proj-1" onError={vi.fn()} pollIntervalMs={0} />);
    fireEvent.click(await screen.findByTestId("refinement-button"));
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect(screen.getByRole("button", { name: "Start refinement" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Select at least one action");
    fireEvent.click(screen.getByRole("checkbox", { name: /Priorities and deprioritization/ }));
    fireEvent.change(screen.getByLabelText("Additional instructions (optional)"), { target: { value: "  Focus on onboarding  " } });
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/projects/proj-1/refinement", expect.objectContaining({ body: JSON.stringify({ namedAgentId: null, instructions: "Focus on onboarding", actions: ["priorities"] }) })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});


describe("REfinment 2 — a concurrent pass never traps the dialog", () => {
  it.each(["Cancel", "Close", "Escape"])(
    "allows %s after a 409 followed by a running status refresh",
    async (exit) => {
      let serverRunning = false;
      const onError = vi.fn();
      global.fetch = vi.fn(async (_url, init) => {
        if (init?.method === "POST") {
          return { ok: false, status: 409, json: async () => ({
            error: "A board refinement pass is already running for this project.",
            code: "REFINEMENT_ALREADY_RUNNING",
          }) } as Response;
        }
        return { ok: true, json: async () =>
          serverRunning ? running("other-pass").body : idle().body,
        } as Response;
      });
      const view = (refreshTrigger: number) => (
        <RefinementButton projectId="proj-1" onError={onError}
          refreshTrigger={refreshTrigger} pollIntervalMs={0} />
      );
      const { rerender } = render(view(0));
      fireEvent.click(await screen.findByTestId("refinement-button"));
      fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));
      await waitFor(() => expect(onError).toHaveBeenCalled());
      serverRunning = true;
      rerender(view(1));
      await waitFor(() => expect(screen.getByTestId("refinement-button-badge"))
        .toHaveTextContent("running"));
      expect(screen.getByRole("button", { name: /Start/ })).toBeDisabled();
      if (exit === "Escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: exit }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  );
});


it("protects a pending POST without trapping the dialog after it settles", async () => {
  let finish!: (response: Response) => void;
  global.fetch = vi.fn(async (_url, init) => {
    if (init?.method === "POST") return new Promise<Response>((resolve) => { finish = resolve; });
    return { ok: true, json: async () => idle().body } as Response;
  });
  render(<RefinementButton projectId="proj-1" onError={vi.fn()} pollIntervalMs={0} />);
  fireEvent.click(await screen.findByTestId("refinement-button"));
  fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  await act(async () => finish({
    ok: false, json: async () => ({ error: "Try again" }),
  } as Response));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
