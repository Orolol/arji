/**
 * What the desk actually POSTs.
 *
 * This is the replacement pin for the dispatch behaviour the deleted board
 * tests covered from the card side: the retry dispatch decision, the sequential
 * batch merge, the composer's create-then-dispatch chain, and the
 * 409 AGENT_ALREADY_RUNNING toast that carries a link to the session in the way.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NowDesk } from "@/components/desk/NowDesk";
import type { ControlDeskPayload } from "@/lib/control-desk/types";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false, refresh: vi.fn() }),
}));

const payload: ControlDeskPayload = {
  generatedAt: "2026-08-28T09:00:00.000Z",
  projects: [
    {
      id: "p1",
      name: "Arij",
      shortName: "ARIJ",
      colorIndex: 0,
      activeAgents: 1,
      autoModeEnabled: false,
    },
  ],
  working: [],
  queued: [],
  today: {
    ticketsShipped: 2,
    failedSessions: 0,
    costUsd: 1.5,
    projects: 1,
    sessions: 4,
  },
  yourTurn: {
    awaitingReply: [],
    failed: [
      {
        epicId: "e1",
        projectId: "p1",
        readableId: "ARJ-9",
        title: "Worker pool",
        sessionId: "s9",
        error: "exit 1",
        agentType: "build",
        agentName: "Opus Builder",
        provider: "claude-code",
        namedAgentId: "a1",
        userStoryId: null,
        producedOutput: true,
        failedAt: "2026-08-28T08:39:00.000Z",
      },
    ],
    conflicts: [],
  },
  readyToLand: [
    {
      epicId: "e2",
      projectId: "p1",
      readableId: "ARJ-107",
      title: "Rail",
      prNumber: 218,
      usDone: 2,
      usCount: 2,
      openFindings: 0,
      agentBusy: false,
    },
    {
      epicId: "e3",
      projectId: "p1",
      readableId: "ARJ-108",
      title: "Chips",
      prNumber: null,
      usDone: 1,
      usCount: 1,
      openFindings: 0,
      agentBusy: false,
    },
  ],
  heldBackCount: 0,
  upNext: [],
};

type FetchCall = [string, RequestInit | undefined];

function mockFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body: unknown },
) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/control-desk") {
      return { ok: true, status: 200, json: async () => ({ data: payload }) };
    }
    const result = handler(url, init);
    const status = result.status ?? 200;
    return { ok: status < 400, status, json: async () => result.body };
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function calls(fn: ReturnType<typeof vi.fn>, match: string): FetchCall[] {
  return fn.mock.calls.filter(
    (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes(match),
  ) as FetchCall[];
}

describe("desk mutations", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockClear();
  });

  it("retries through buildRetryDispatch — single-epic route, resumed session", async () => {
    // The batch build route has no resumeSessionId parameter at all, so a retry
    // must go to the single-epic route or it can only ever start cold.
    const fetchMock = mockFetch(() => ({ body: { data: { ok: true } } }));
    render(<NowDesk />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(calls(fetchMock, "/build").length).toBe(1));
    const [url, init] = calls(fetchMock, "/build")[0];
    expect(url).toBe("/api/projects/p1/epics/e1/build");
    const body = JSON.parse(String(init!.body));
    // Reuses the failed session's agent and continues its conversation.
    expect(body.namedAgentId).toBe("a1");
    expect(body.resumeSessionId).toBe("s9");
  });

  it("turns a 409 into a toast that links to the session in the way", async () => {
    const fetchMock = mockFetch((url) =>
      url.includes("/build")
        ? {
            status: 409,
            body: {
              error: "An agent is already running on this epic",
              code: "AGENT_ALREADY_RUNNING",
              data: { activeSessionId: "s-live" },
            },
          }
        : { body: { data: {} } },
    );
    render(<NowDesk />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    const link = await screen.findByText("Open active session");
    expect(link).toHaveAttribute("href", "/projects/p1/sessions/s-live");
    expect(
      screen.getByText("An agent is already running on this epic"),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("prefers the server's own session url when it supplies one", async () => {
    mockFetch((url) =>
      url.includes("/build")
        ? {
            status: 409,
            body: {
              error: "busy",
              code: "AGENT_ALREADY_RUNNING",
              data: { activeSessionId: "s-live", sessionUrl: "/elsewhere/s-live" },
            },
          }
        : { body: { data: {} } },
    );
    render(<NowDesk />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Open active session")).toHaveAttribute(
      "href",
      "/elsewhere/s-live",
    );
  });

  it("lands one ticket through the merge route", async () => {
    const fetchMock = mockFetch(() => ({ body: { data: { merged: true } } }));
    render(<NowDesk />);

    fireEvent.click((await screen.findAllByTestId("desk-land-button"))[0]);

    await waitFor(() => expect(calls(fetchMock, "/merge").length).toBe(1));
    expect(calls(fetchMock, "/merge")[0][0]).toBe(
      "/api/projects/p1/epics/e2/merge",
    );
    expect(await screen.findByText("Merged into the base branch")).toBeInTheDocument();
  });

  it("lands a batch one at a time — a shared checkout cannot take two", async () => {
    const seen: string[] = [];
    const fetchMock = mockFetch((url) => {
      if (url.includes("/merge")) seen.push(url);
      return { body: { data: { merged: true } } };
    });
    render(<NowDesk />);

    fireEvent.click(await screen.findByTestId("desk-land-all"));

    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      "/api/projects/p1/epics/e2/merge",
      "/api/projects/p1/epics/e3/merge",
    ]);
    expect(await screen.findByText("Merged 2 epics")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("reports a partial batch honestly", async () => {
    mockFetch((url) =>
      url.endsWith("/e3/merge")
        ? { status: 500, body: { error: "boom" } }
        : { body: { data: { merged: true } } },
    );
    render(<NowDesk />);
    fireEvent.click(await screen.findByTestId("desk-land-all"));

    expect(await screen.findByText("Merged 1 epic")).toBeInTheDocument();
    expect(await screen.findByText("1 merge failed")).toBeInTheDocument();
  });

  it("composes an epic with the board's own payload — there is no draft status", async () => {
    const fetchMock = mockFetch(() => ({ body: { data: { id: "new-epic" } } }));
    render(<NowDesk />);

    const input = await screen.findByTestId("desk-composer-input");
    fireEvent.change(input, { target: { value: "Un nouveau truc" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(calls(fetchMock, "/epics").length).toBe(1));
    const body = JSON.parse(String(calls(fetchMock, "/epics")[0][1]!.body));
    expect(body).toEqual({
      title: "Un nouveau truc",
      status: "backlog",
      type: "feature",
    });
    // ⏎ alone never dispatches.
    expect(calls(fetchMock, "/build")).toHaveLength(0);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("⇧⏎ chains the build dispatch onto the new epic", async () => {
    const fetchMock = mockFetch(() => ({ body: { data: { id: "new-epic" } } }));
    render(<NowDesk />);

    const input = await screen.findByTestId("desk-composer-input");
    fireEvent.change(input, { target: { value: "Direct en dev" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    await waitFor(() => expect(calls(fetchMock, "/build").length).toBe(1));
    expect(calls(fetchMock, "/build")[0][0]).toBe(
      "/api/projects/p1/epics/new-epic/build",
    );
  });

  it("keeps the typed title when creation fails", async () => {
    mockFetch(() => ({ status: 400, body: { error: "Title too short" } }));
    render(<NowDesk />);

    const input = await screen.findByTestId("desk-composer-input");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Title too short")).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("x");
  });

  it("reports Full Auto per project — there is no global switch", async () => {
    mockFetch(() => ({ body: { data: {} } }));
    render(<NowDesk />);
    expect(await screen.findByTestId("desk-full-auto")).toHaveTextContent(
      "Full Auto · 0/1",
    );
  });
});
