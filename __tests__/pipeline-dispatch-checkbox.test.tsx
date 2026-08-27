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

describe("AgentActionsBar — pipeline checkbox", () => {
  beforeEach(() => {
    settings = {};
    stubFetch();
  });

  it("is unchecked when no pipeline setting exists", async () => {
    renderBar(sendToDevSpy());
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    await waitFor(() => expect(checkbox).not.toBeChecked());
  });

  it("defaults to checked when the global setting is on", async () => {
    settings = { pipeline_enabled: true };
    renderBar(sendToDevSpy());
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    await waitFor(() => expect(checkbox).toBeChecked());
  });

  it("lets a per-project override turn the default back off", async () => {
    settings = { pipeline_enabled: true, "pipeline_enabled:proj-1": false };
    renderBar(sendToDevSpy());
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    // Let the settings fetch settle before asserting the (unchanged) state.
    await waitFor(() => expect(screen.getByTestId("pipeline-checkbox")).toBeInTheDocument());
    expect(checkbox).not.toBeChecked();
  });

  it("passes pipeline=true to onSendToDev when the box is ticked", async () => {
    const onSendToDev = sendToDevSpy();
    renderBar(onSendToDev);
    openDialog();

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /Dispatch Agent/i }));

    await waitFor(() => expect(onSendToDev).toHaveBeenCalled());
    expect(onSendToDev.mock.calls[0]).toEqual([undefined, null, undefined, true]);
  });

  it("passes pipeline=false when the box is left unticked", async () => {
    const onSendToDev = sendToDevSpy();
    renderBar(onSendToDev);
    openDialog();

    await screen.findByTestId("pipeline-checkbox");
    fireEvent.click(screen.getByRole("button", { name: /Dispatch Agent/i }));

    await waitFor(() => expect(onSendToDev).toHaveBeenCalled());
    expect(onSendToDev.mock.calls[0][3]).toBe(false);
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
