/**
 * `useKanban.sortColumnByPriority` — the one path by which priority reaches
 * the scheduler.
 *
 * Position is the single source of execution order: Full Auto drains a column
 * top-down and never reads `priority`. So priority only influences what runs
 * next through this action, which rewrites the column's positions in bulk via
 * the existing reorder route. That contract is checkable, and checked here:
 * priority DESC, ties keeping their current display order, one bulk write
 * covering the whole column, and the board showing exactly what it persisted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useKanban } from "@/hooks/useKanban";

const PROJECT_ID = "proj-sort";

interface EpicSeed {
  id: string;
  priority: number;
  status?: string;
  position?: number;
}

function seedEpics(seeds: EpicSeed[]): Record<string, unknown>[] {
  return seeds.map((seed, idx) => ({
    id: seed.id,
    projectId: PROJECT_ID,
    title: seed.id,
    description: null,
    priority: seed.priority,
    status: seed.status ?? "todo",
    position: seed.position ?? idx,
    branchName: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    confidence: null,
    evidence: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    type: "feature",
    linkedEpicId: null,
    images: null,
    usCount: 0,
    usDone: 0,
  }));
}

describe("useKanban.sortColumnByPriority", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  function mockBoard(seeds: EpicSeed[]): void {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/epics")) {
        return new Response(JSON.stringify({ data: seedEpics(seeds) }));
      }
      return new Response(JSON.stringify({ data: [] }));
    });
  }

  function reorderPosts(): Array<{ url: string; items: unknown }> {
    return fetchSpy.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([url, init]) => ({
        url: String(url),
        items: JSON.parse((init as RequestInit).body as string).items,
      }));
  }

  function epicLoadCount(): number {
    return fetchSpy.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/epics") &&
        (init as RequestInit | undefined)?.method !== "POST"
    ).length;
  }

  async function mountBoard(seeds: EpicSeed[]) {
    mockBoard(seeds);
    const hook = renderHook(() => useKanban(PROJECT_ID));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rewrites the whole column's positions in priority DESC order", async () => {
    const { result } = await mountBoard([
      { id: "low", priority: 0 },
      { id: "critical", priority: 3 },
      { id: "medium", priority: 1 },
    ]);

    act(() => {
      result.current.sortColumnByPriority("todo");
    });

    const posts = reorderPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`/api/projects/${PROJECT_ID}/epics/reorder`);
    expect(posts[0].items).toEqual([
      { id: "critical", status: "todo", position: 0 },
      { id: "medium", status: "todo", position: 1 },
      { id: "low", status: "todo", position: 2 },
    ]);
  });

  it("keeps the current display order for equal priorities", async () => {
    const { result } = await mountBoard([
      { id: "first-medium", priority: 1 },
      { id: "second-medium", priority: 1 },
      { id: "critical", priority: 3 },
      { id: "third-medium", priority: 1 },
    ]);

    act(() => {
      result.current.sortColumnByPriority("todo");
    });

    // Only `critical` moves; the three ties keep their relative order, so the
    // button is idempotent and never shuffles equal-priority work.
    expect(reorderPosts()[0].items).toEqual([
      { id: "critical", status: "todo", position: 0 },
      { id: "first-medium", status: "todo", position: 1 },
      { id: "second-medium", status: "todo", position: 2 },
      { id: "third-medium", status: "todo", position: 3 },
    ]);
  });

  it("shows the order it just persisted", async () => {
    const { result } = await mountBoard([
      { id: "low", priority: 0 },
      { id: "critical", priority: 3 },
    ]);

    act(() => {
      result.current.sortColumnByPriority("todo");
    });

    // The AC: what the board displays after the click is what Full Auto will
    // execute, because both read the positions that were just written.
    expect(result.current.board.columns.todo.map((e) => e.id)).toEqual([
      "critical",
      "low",
    ]);
    expect(reorderPosts()[0].items).toEqual([
      { id: "critical", status: "todo", position: 0 },
      { id: "low", status: "todo", position: 1 },
    ]);
  });

  it("touches only the sorted column", async () => {
    const { result } = await mountBoard([
      { id: "todo-low", priority: 0, status: "todo" },
      { id: "todo-high", priority: 3, status: "todo" },
      { id: "backlog-low", priority: 0, status: "backlog" },
      { id: "backlog-high", priority: 3, status: "backlog" },
    ]);

    act(() => {
      result.current.sortColumnByPriority("backlog");
    });

    expect(reorderPosts()[0].items).toEqual([
      { id: "backlog-high", status: "backlog", position: 0 },
      { id: "backlog-low", status: "backlog", position: 1 },
    ]);
    // The To Do column is neither rewritten nor reordered on screen.
    expect(result.current.board.columns.todo.map((e) => e.id)).toEqual([
      "todo-low",
      "todo-high",
    ]);
  });

  it("sends the request without waiting for a deferred callback", async () => {
    const { result } = await mountBoard([
      { id: "low", priority: 0 },
      { id: "critical", priority: 3 },
    ]);

    fetchSpy.mockClear();
    vi.useFakeTimers();
    try {
      act(() => {
        result.current.sortColumnByPriority("todo");
      });

      // Timers are frozen and never advanced: a `setTimeout`-deferred write
      // cannot have fired. The write must be synchronous, because a deferred
      // one re-reads a board an in-flight refresh may have replaced — which
      // persists the PRE-sort order behind a click that appeared to sort.
      expect(reorderPosts()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a rejected write and re-reads the server order", async () => {
    const onMoveError = vi.fn();
    mockBoard([
      { id: "low", priority: 0 },
      { id: "critical", priority: 3 },
    ]);
    const { result } = renderHook(() => useKanban(PROJECT_ID, { onMoveError }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const loadsBefore = epicLoadCount();

    fetchSpy.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ error: "Reorder refused" }), {
            status: 409,
          });
        }
        if (String(input).endsWith("/epics")) {
          return new Response(
            JSON.stringify({ data: seedEpics([{ id: "low", priority: 0 }]) })
          );
        }
        return new Response(JSON.stringify({ data: [] }));
      }
    );

    await act(async () => {
      result.current.sortColumnByPriority("todo");
    });

    await waitFor(() =>
      expect(onMoveError).toHaveBeenCalledWith("Reorder refused")
    );
    await waitFor(() => expect(epicLoadCount()).toBeGreaterThan(loadsBefore));
  });

  it("never sorts the released column", async () => {
    const { result } = await mountBoard([
      { id: "shipped", priority: 3, status: "released" },
    ]);

    act(() => {
      result.current.sortColumnByPriority("released");
    });

    expect(reorderPosts()).toHaveLength(0);
  });
});
