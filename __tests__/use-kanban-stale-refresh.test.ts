import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useKanban } from "@/hooks/useKanban";
import type { KanbanEpic } from "@/lib/types/kanban";

function makeEpic(id: string, position: number): KanbanEpic {
  return {
    projectId: "proj-1",
    id,
    title: id,
    description: null,
    priority: 1,
    status: "todo",
    position,
    branchName: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    confidence: null,
    evidence: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    type: "feature",
    linkedEpicId: null,
    images: null,
    readableId: null,
    releaseId: null,
    usCount: 1,
    usDone: 0,
    latestCommentId: null,
    latestCommentAuthor: null,
    latestCommentCreatedAt: null,
  };
}

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response;
}

/** Lets the test resolve one board GET at a moment of its choosing. */
function deferred() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const PRE_MOVE = [makeEpic("a", 0), makeEpic("b", 1)];
const POST_MOVE = [makeEpic("b", 0), makeEpic("a", 1)];

/**
 * A board server whose `/epics` order can change under the client and whose
 * next GET can be held in flight. Everything else answers immediately, so the
 * only ordering the test controls is the one under test.
 */
function installFetch() {
  const server = {
    epics: PRE_MOVE,
    /** Arm this to hold the next `/epics` GET open. */
    holdNextBoardGet: false,
    held: null as ReturnType<typeof deferred> | null,
    boardGets: 0,
    reorderCalls: [] as unknown[],
  };

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/epics/reorder")) {
      server.reorderCalls.push(JSON.parse(String(init?.body)));
      return Promise.resolve(jsonResponse({ data: { skipped: 0 } }));
    }
    if (url.endsWith("/epics")) {
      server.boardGets += 1;
      if (server.holdNextBoardGet) {
        server.holdNextBoardGet = false;
        server.held = deferred();
        return server.held.promise;
      }
      return Promise.resolve(jsonResponse({ data: server.epics }));
    }
    return Promise.resolve(jsonResponse({ data: [] }));
  });

  vi.stubGlobal("fetch", fetchMock);
  return server;
}

/** Flush the fetch continuations (JSON parse + setState) a response schedules. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const todoIds = (result: { current: ReturnType<typeof useKanban> }) =>
  result.current.board.columns.todo.map((e) => e.id);

describe("useKanban board refresh ordering", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("discards a board GET issued before a drag that resolves after it", async () => {
    // The page bumps its refresh trigger on every SSE event and on every poll
    // tick of the SSE-down fallback, so board GETs are in flight on a cadence
    // unrelated to the drag. One issued before the drop still describes the
    // pre-move order when it lands; applying it repaints the board with the
    // order the user just changed and the move reads as lost, even though the
    // reorder was stored.
    const server = installFetch();
    const { result } = renderHook(() => useKanban("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(todoIds(result)).toEqual(["a", "b"]);

    // T0 — a refresh is issued and held in flight.
    server.holdNextBoardGet = true;
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(server.held).not.toBeNull());

    // T1/T2 — the drop lands and the reorder commits.
    server.epics = POST_MOVE;
    await act(async () => {
      await result.current.moveEpic("b", "todo", "todo", 0);
    });
    await settle();
    expect(server.reorderCalls).toHaveLength(1);
    expect(todoIds(result)).toEqual(["b", "a"]);

    // T3 — the pre-move response finally resolves.
    server.held!.resolve(jsonResponse({ data: PRE_MOVE }));
    await settle();

    expect(todoIds(result)).toEqual(["b", "a"]);
  });

  it("refetches the board once the server confirms the write", async () => {
    // Without a refetch tied to the write, a board left stale by a discarded
    // response has nothing scheduled to correct it: it stays wrong until an
    // unrelated event or a manual reload. This is also the only refetch that
    // still happens when SSE is down between poll ticks.
    const server = installFetch();
    const { result } = renderHook(() => useKanban("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const boardGetsBeforeDrag = server.boardGets;
    // A card another writer added: only a genuine refetch can surface it.
    server.epics = [...POST_MOVE, makeEpic("c", 2)];

    await act(async () => {
      await result.current.moveEpic("b", "todo", "todo", 0);
    });
    await settle();

    expect(server.boardGets).toBe(boardGetsBeforeDrag + 1);
    expect(todoIds(result)).toEqual(["b", "a", "c"]);
  });

  it("applies the newest board GET when responses resolve out of order", async () => {
    // The same lost update without a drag: two refreshes overlap and the
    // older one wins simply because it resolved last.
    const server = installFetch();
    const { result } = renderHook(() => useKanban("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    server.holdNextBoardGet = true;
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(server.held).not.toBeNull());
    const older = server.held!;

    server.epics = POST_MOVE;
    await act(async () => {
      await result.current.refresh();
    });
    await settle();
    expect(todoIds(result)).toEqual(["b", "a"]);

    older.resolve(jsonResponse({ data: PRE_MOVE }));
    await settle();

    expect(todoIds(result)).toEqual(["b", "a"]);
  });
});
