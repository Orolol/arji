/**
 * `useControlDesk` must not let a stale poll revert a completed action.
 *
 * The desk polls `GET /api/control-desk` every 4 s and every desk action ends
 * in `refresh()`. So the window the board had before commit a2a827c
 * ("stop a stale board GET reverting a completed action") exists here too: a
 * poll issued before the user lands a ticket can still be in flight when the
 * action's own refresh has painted the result, and it carries the pre-action
 * world. Every case below fails on the hook without its sequence guards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useControlDesk } from "@/hooks/useControlDesk";
import type { ControlDeskPayload } from "@/lib/control-desk/types";

function payload(readyEpicIds: string[]): ControlDeskPayload {
  return {
    generatedAt: "2026-08-28T09:00:00.000Z",
    projects: [
      {
        id: "p1",
        name: "Arij",
        shortName: "ARIJ",
        colorIndex: 0,
        activeAgents: 0,
        autoModeEnabled: false,
      },
    ],
    working: [],
    queued: [],
    today: {
      ticketsShipped: null,
      failedSessions: 0,
      costUsd: null,
      projects: 0,
      sessions: 0,
    },
    yourTurn: { awaitingReply: [], failed: [], conflicts: [] },
    readyToLand: readyEpicIds.map((id) => ({
      epicId: id,
      projectId: "p1",
      readableId: id.toUpperCase(),
      title: id,
      prNumber: null,
      usDone: 1,
      usCount: 1,
      openFindings: 0,
      agentBusy: false,
    })),
    heldBackCount: 0,
    upNext: [],
  };
}

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response;
}

/** Lets the test resolve one desk GET at a moment of its choosing. */
function deferred() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A desk server whose answer can change under the client and whose next GET
 * can be held open. Nothing else is asynchronous, so the only ordering the
 * test controls is the one under test.
 */
function installFetch() {
  const server = {
    ready: ["e1", "e2"],
    /** Arm this to hold the next desk GET open. */
    holdNextGet: false,
    held: null as ReturnType<typeof deferred> | null,
    gets: 0,
  };

  const fetchMock = vi.fn(() => {
    server.gets += 1;
    if (server.holdNextGet) {
      server.holdNextGet = false;
      server.held = deferred();
      return server.held.promise;
    }
    return Promise.resolve(jsonResponse({ data: payload(server.ready) }));
  });

  vi.stubGlobal("fetch", fetchMock);
  return server;
}

function readyIds(data: ControlDeskPayload | null): string[] {
  return (data?.readyToLand ?? []).map((row) => row.epicId);
}

describe("useControlDesk — stale response ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("drops a poll that was in flight when an action completed", async () => {
    const server = installFetch();
    // Hold the FIRST poll: it is the one that carries the pre-action world.
    server.holdNextGet = true;

    const { result } = renderHook(() => useControlDesk(null, 4000));
    await waitFor(() => expect(server.gets).toBe(1));
    const stalePoll = server.held!;

    // The user lands e1. The server drops it from READY TO LAND, and the desk
    // refreshes off the back of the confirmed write.
    server.ready = ["e2"];
    await act(async () => {
      await result.current.refresh();
    });
    expect(readyIds(result.current.data)).toEqual(["e2"]);

    // Only now does the pre-action poll answer, with e1 still landable.
    await act(async () => {
      stalePoll.resolve(jsonResponse({ data: payload(["e1", "e2"]) }));
      await Promise.resolve();
    });

    expect(readyIds(result.current.data)).toEqual(["e2"]);
  });

  it("drops an out-of-order poll even with no action in between", async () => {
    const server = installFetch();
    server.holdNextGet = true;

    const { result } = renderHook(() => useControlDesk(null, 4000));
    await waitFor(() => expect(server.gets).toBe(1));
    const slowPoll = server.held!;

    // The next tick answers straight away and wins.
    server.ready = ["e2"];
    await act(async () => {
      vi.advanceTimersByTime(4000);
      await Promise.resolve();
    });
    await waitFor(() => expect(readyIds(result.current.data)).toEqual(["e2"]));

    await act(async () => {
      slowPoll.resolve(jsonResponse({ data: payload(["e1", "e2"]) }));
      await Promise.resolve();
    });

    expect(readyIds(result.current.data)).toEqual(["e2"]);
  });

  it("does not let a stale failure clear the desk", async () => {
    const server = installFetch();
    server.holdNextGet = true;

    const { result } = renderHook(() => useControlDesk(null, 4000));
    await waitFor(() => expect(server.gets).toBe(1));
    const stalePoll = server.held!;

    server.ready = ["e2"];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();

    await act(async () => {
      stalePoll.resolve(jsonResponse({ error: "boom" }, true));
      await Promise.resolve();
    });

    // The response lost the race, so its error is not the desk's error either.
    expect(result.current.error).toBeNull();
    expect(readyIds(result.current.data)).toEqual(["e2"]);
  });

  it("still applies the refresh that follows an action", async () => {
    const server = installFetch();
    const { result } = renderHook(() => useControlDesk(null, 4000));
    await waitFor(() => expect(readyIds(result.current.data)).toEqual(["e1", "e2"]));

    server.ready = [];
    await act(async () => {
      await result.current.refresh();
    });

    expect(readyIds(result.current.data)).toEqual([]);
  });
});
