import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useKanban } from "@/hooks/useKanban";
import type { KanbanEpic } from "@/lib/types/kanban";

function makeEpic(overrides: Partial<KanbanEpic> & { id: string }): KanbanEpic {
  return {
    projectId: "proj-1",
    title: overrides.id,
    description: null,
    priority: 1,
    status: "todo",
    position: 0,
    branchName: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    confidence: null,
    evidence: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
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
    ...overrides,
  };
}

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response;
}

const epics = [
  makeEpic({ id: "a", position: 0 }),
  makeEpic({ id: "b", position: 1 }),
];

/** Routes each board request to a canned payload; reorder POSTs are recorded. */
function installFetch(reorderOk = true) {
  const reorderCalls: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/epics/reorder")) {
      reorderCalls.push(JSON.parse(String(init?.body)));
      return jsonResponse(reorderOk ? {} : { error: "Refused" }, reorderOk);
    }
    if (url.endsWith("/epics")) return jsonResponse({ data: epics });
    if (url.endsWith("/releases")) return jsonResponse({ data: [] });
    if (url.endsWith("/dependencies")) return jsonResponse({ data: [] });
    return jsonResponse({ data: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, reorderCalls };
}

describe("useKanban moveEpic", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("issues exactly one reorder request and one accepted callback", async () => {
    // The reorder POST used to live inside a setBoard updater. React
    // double-invokes updaters under Strict Mode, which fired the request — and
    // the user-visible accepted callback — twice in development.
    const { reorderCalls } = installFetch();
    const onMoveAccepted = vi.fn();

    const { result } = renderHook(() => useKanban("proj-1"), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.moveEpic("a", "todo", "done", 0, onMoveAccepted);
    });

    expect(reorderCalls).toHaveLength(1);
    expect(onMoveAccepted).toHaveBeenCalledTimes(1);
    expect(result.current.board.columns.done.map((e) => e.id)).toEqual(["a"]);
    expect(result.current.board.columns.todo.map((e) => e.id)).toEqual(["b"]);
  });

  it("reports the reorder payload from the post-move board", async () => {
    const { reorderCalls } = installFetch();

    const { result } = renderHook(() => useKanban("proj-1"), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.moveEpic("a", "todo", "done", 0);
    });

    expect(reorderCalls[0]).toEqual({
      items: [
        { id: "b", status: "todo", position: 0 },
        { id: "a", status: "done", position: 0 },
      ],
    });
  });

  it("does not run the accepted callback when the server refuses", async () => {
    const { reorderCalls } = installFetch(false);
    const onMoveAccepted = vi.fn();
    const onMoveError = vi.fn();

    const { result } = renderHook(() => useKanban("proj-1", { onMoveError }), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.moveEpic("a", "todo", "done", 0, onMoveAccepted);
    });

    expect(reorderCalls).toHaveLength(1);
    expect(onMoveAccepted).not.toHaveBeenCalled();
    expect(onMoveError).toHaveBeenCalledWith("Refused");
  });

  it("keeps the board rendered when the dependency request rejects", async () => {
    // A rejected fetch inside the Promise.all used to skip setBoard entirely.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/dependencies")) throw new Error("network down");
      if (url.endsWith("/epics")) return jsonResponse({ data: epics });
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useKanban("proj-1"), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.board.columns.todo.map((e) => e.id)).toEqual(["a", "b"]);
    expect(result.current.dependencies).toEqual([]);
  });
});
