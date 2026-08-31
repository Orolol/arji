/**
 * Send-to-Dev dialog: the "Run full pipeline" checkbox — its default from
 * the effective `pipeline_enabled` setting, and the flag it forwards to the
 * dispatch callback (and from there to the build route body).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { AgentActionsBar } from "@/components/shared/AgentActionsBar";
import { useAgentDispatch } from "@/hooks/useAgentDispatch";
import { renderHook } from "@testing-library/react";

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="named-agent-select" />,
}));

vi.mock("@/components/shared/SessionPicker", () => ({
  SessionPicker: () => <div data-testid="session-picker" />,
}));

vi.mock("@/components/documents/MentionTextarea", () => ({
  MentionTextarea: () => <textarea data-testid="mention-textarea" />,
}));

/** Settings payload served by the stubbed GET /api/settings. */
let settings: Record<string, unknown> = {};

function stubFetch() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/settings") {
      return { ok: true, json: async () => ({ data: settings }) };
    }
    return { ok: true, json: async () => ({ data: {} }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type SendToDev = (
  comment?: string,
  namedAgentId?: string | null,
  resumeSessionId?: string,
  pipeline?: boolean
) => Promise<unknown>;

/** Typed so `mock.calls[0][3]` is the pipeline flag, not a never-index. */
function sendToDevSpy() {
  return vi.fn<SendToDev>(async () => undefined);
}

function renderBar(onSendToDev: SendToDev) {
  return render(
    <AgentActionsBar
      projectId="proj-1"
      target={{ kind: "epic", epic: { id: "epic-1", status: "todo", title: "E" } }}
      dispatching={false}
      isRunning={false}
      onSendToDev={onSendToDev}
      onSendToReview={vi.fn(async () => undefined)}
      onComplete={vi.fn(async () => undefined)}
    />
  );
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /Send to Dev/i }));
}

/** Re-queried every time: the dialog re-renders as the settings read lands. */
function confirmButton() {
  return screen.getByRole("button", { name: /Dispatch Agent/i });
}

describe("AgentActionsBar — pipeline checkbox", () => {
  beforeEach(() => {
    settings = {};
    stubFetch();
  });

  it("is checked when no pipeline setting exists", async () => {
    renderBar(sendToDevSpy());
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    await waitFor(() => expect(checkbox).toBeChecked());
  });

  it("defaults to unchecked when the global setting is explicitly off", async () => {
    settings = { pipeline_enabled: false };
    renderBar(sendToDevSpy());
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    await waitFor(() => expect(checkbox).not.toBeChecked());
  });

  it("lets a per-project override turn the default back off", async () => {
    settings = { pipeline_enabled: true, "pipeline_enabled:proj-1": false };
    renderBar(sendToDevSpy());
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    await waitFor(() => expect(checkbox).not.toBeChecked());
  });

  it("passes pipeline=true to onSendToDev when the box stays ticked", async () => {
    const onSendToDev = sendToDevSpy();
    renderBar(onSendToDev);
    openDialog();

    // The box is checked by default; dispatch without touching it — but only
    // once the settings read has lifted the confirm gate.
    await screen.findByTestId("pipeline-checkbox");
    await waitFor(() => expect(confirmButton()).toBeEnabled());

    fireEvent.click(confirmButton());

    await waitFor(() => expect(onSendToDev).toHaveBeenCalled());
    expect(onSendToDev.mock.calls[0]).toEqual([undefined, null, undefined, true]);
  });

  it("passes pipeline=false when the box is unticked", async () => {
    const onSendToDev = sendToDevSpy();
    renderBar(onSendToDev);
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onSendToDev).toHaveBeenCalled());
    expect(onSendToDev.mock.calls[0][3]).toBe(false);
  });
});

/**
 * The dialog is interactive before `GET /api/settings` answers. Until it
 * does, the checkbox is only an optimistic product default — dispatching it
 * as an explicit `pipeline: true` would override a project or global
 * `pipeline_enabled: false`. These tests pin the three ways out of that
 * window: gate, user choice wins, and omit the flag when the read fails.
 */
describe("AgentActionsBar — pipeline default while the settings read is in flight", () => {
  interface DeferredSettings {
    /** Answer the pending GET /api/settings with this settings map. */
    resolve: (settings: Record<string, unknown>) => void;
    /** Make the pending read fail (network error or a non-OK response). */
    fail: (mode?: "reject" | "not-ok") => void;
  }

  /** Stubs fetch so only `/api/settings` hangs until the test releases it. */
  function stubDeferredSettings(): DeferredSettings {
    let release!: (
      value: { settings: Record<string, unknown> } | { notOk: true }
    ) => void;
    let rejectRead!: (error: unknown) => void;
    const gate = new Promise<
      { settings: Record<string, unknown> } | { notOk: true }
    >((res, rej) => {
      release = res;
      rejectRead = rej;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) !== "/api/settings") {
          return { ok: true, json: async () => ({ data: [] }) };
        }
        const outcome = await gate;
        if ("notOk" in outcome) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({ data: outcome.settings }) };
      })
    );

    return {
      resolve: (s) => release({ settings: s }),
      fail: (mode = "reject") =>
        mode === "reject" ? rejectRead(new Error("offline")) : release({ notOk: true }),
    };
  }

  it("refuses to dispatch until the read lands, then honours an explicit false", async () => {
    const onSendToDev = sendToDevSpy();
    const deferred = stubDeferredSettings();
    renderBar(onSendToDev);
    openDialog();

    // The optimistic box is on, but confirming it now would send an explicit
    // `pipeline: true` over a setting that has not been read yet.
    await screen.findByTestId("pipeline-checkbox");
    fireEvent.click(confirmButton());
    expect(onSendToDev).not.toHaveBeenCalled();
    expect(confirmButton()).toBeDisabled();

    await act(async () => {
      deferred.resolve({ "pipeline_enabled:proj-1": false });
    });

    await waitFor(() => expect(confirmButton()).toBeEnabled());
    expect(screen.getByTestId("pipeline-checkbox")).not.toBeChecked();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(onSendToDev).toHaveBeenCalled());
    expect(onSendToDev.mock.calls[0][3]).toBe(false);
  });

  it("keeps a choice the user made before the response, and dispatches it", async () => {
    const onSendToDev = sendToDevSpy();
    const deferred = stubDeferredSettings();
    renderBar(onSendToDev);
    openDialog();

    // Untick while the read is still in flight: an explicit choice, which
    // also lifts the gate — there is nothing left to wait for.
    const checkbox = await screen.findByTestId("pipeline-checkbox");
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(confirmButton()).toBeEnabled();

    // A late "pipeline is on" must not re-tick it under the user.
    await act(async () => {
      deferred.resolve({ pipeline_enabled: true });
    });
    expect(screen.getByTestId("pipeline-checkbox")).not.toBeChecked();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(onSendToDev).toHaveBeenCalled());
    expect(onSendToDev.mock.calls[0][3]).toBe(false);
  });

  it.each(["reject", "not-ok"] as const)(
    "omits the flag when the settings read fails (%s), leaving the route authoritative",
    async (mode) => {
      const onSendToDev = sendToDevSpy();
      const deferred = stubDeferredSettings();
      renderBar(onSendToDev);
      openDialog();

      await screen.findByTestId("pipeline-checkbox");
      await act(async () => {
        deferred.fail(mode);
      });

      // Dispatch is possible again — the dialog just stops claiming to know
      // the mode, and says so.
      await waitFor(() => expect(confirmButton()).toBeEnabled());
      expect(
        screen.getByTestId("pipeline-setting-unresolved")
      ).toBeInTheDocument();

      fireEvent.click(confirmButton());
      await waitFor(() => expect(onSendToDev).toHaveBeenCalled());
      expect(onSendToDev.mock.calls[0][3]).toBeUndefined();
    }
  );

  it("sends the flag explicitly once the user chooses after a failed read", async () => {
    const onSendToDev = sendToDevSpy();
    const deferred = stubDeferredSettings();
    renderBar(onSendToDev);
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    await act(async () => {
      deferred.fail();
    });
    await waitFor(() =>
      expect(screen.getByTestId("pipeline-setting-unresolved")).toBeInTheDocument()
    );

    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(
      screen.queryByTestId("pipeline-setting-unresolved")
    ).not.toBeInTheDocument();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(onSendToDev).toHaveBeenCalled());
    expect(onSendToDev.mock.calls[0][3]).toBe(true);
  });

  it("re-reads on re-open and drops the previous choice's ownership", async () => {
    const onSendToDev = sendToDevSpy();
    let deferred = stubDeferredSettings();
    renderBar(onSendToDev);
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    fireEvent.click(checkbox);
    await act(async () => {
      deferred.resolve({});
    });
    expect(screen.getByTestId("pipeline-checkbox")).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    deferred = stubDeferredSettings();
    openDialog();

    // Second open: the stale choice no longer shields the value, and the
    // gate is back until the fresh read lands.
    await screen.findByTestId("pipeline-checkbox");
    expect(confirmButton()).toBeDisabled();
    await act(async () => {
      deferred.resolve({ pipeline_enabled: true });
    });
    await waitFor(() =>
      expect(screen.getByTestId("pipeline-checkbox")).toBeChecked()
    );

    fireEvent.click(confirmButton());
    await waitFor(() => expect(onSendToDev).toHaveBeenCalled());
    expect(onSendToDev.mock.calls[0][3]).toBe(true);
  });
});

describe("useAgentDispatch — pipeline flag in the build request body", () => {
  it("adds `pipeline` to the POST body only when the caller passes a boolean", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          calls.push({ url, body: JSON.parse(String(init.body)) });
          return { ok: true, json: async () => ({ data: { sessionId: "s1" } }) };
        }
        return { ok: true, json: async () => ({ data: [] }) };
      })
    );

    const { result } = renderHook(() =>
      useAgentDispatch("proj-1", { kind: "epic", epicId: "epic-1" })
    );

    await act(async () => {
      await result.current.sendToDev("go", null, undefined, true);
    });
    await act(async () => {
      await result.current.sendToDev("go", null, undefined);
    });

    const buildCalls = calls.filter((c) => c.url.endsWith("/build"));
    expect(buildCalls).toHaveLength(2);
    expect(buildCalls[0].body.pipeline).toBe(true);
    expect(buildCalls[1]).toBeDefined();
    expect("pipeline" in buildCalls[1].body).toBe(false);
  });
});
