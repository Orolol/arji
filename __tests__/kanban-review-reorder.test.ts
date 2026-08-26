/**
 * What a drag persists into `epics.position` when the column it touches is
 * displayed in a DERIVED order.
 *
 * Review is drawn merge-ready-first, so its display index is not its
 * position. Persisting the display index would encode a transient signal into
 * the board's durable ordering contract — and would reorder cards nobody
 * dragged, which only becomes visible later, when one of them stops being
 * ready and the column falls back to position order.
 *
 * Two layers are covered: the pure translation (`persistedColumnOrder`) and
 * the hook that actually builds the reorder payload (`useKanban.moveEpic`),
 * because the component tests mock `useKanban` out entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { persistedColumnOrder } from "@/lib/kanban/reorder";
import { useKanban } from "@/hooks/useKanban";
import type { KanbanEpic } from "@/lib/types/kanban";
import type { MergeReadiness } from "@/lib/kanban/merge-readiness";

const READY: MergeReadiness = { ready: true, blocker: null, openFindings: 0 };
const BLOCKED: MergeReadiness = {
  ready: false,
  blocker: "open_findings",
  openFindings: 1,
};

describe("persistedColumnOrder", () => {
  const card = (id: string, position: number) => ({ id, position });

  it("returns stored position order when nothing landed in this column", () => {
    // The column the card was dragged OUT of: re-index the survivors only.
    const ordered = persistedColumnOrder(
      [card("b", 1), card("a", 0), card("c", 2)],
      null
    );
    expect(ordered.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("never reorders cards the user did not drag", () => {
    // Displayed B, A (B is ready so it floats); stored order is A(0), B(1).
    const ordered = persistedColumnOrder(
      [card("b", 1), card("x", 99), card("a", 0)],
      "x"
    );
    // A before B, exactly as stored — the derived float did not leak.
    expect(ordered.map((c) => c.id).filter((id) => id !== "x")).toEqual([
      "a",
      "b",
    ]);
  });

  it("anchors the dragged card after its display predecessor", () => {
    const ordered = persistedColumnOrder(
      [card("b", 1), card("x", 99), card("a", 0)],
      "x"
    );
    expect(ordered.map((c) => c.id)).toEqual(["a", "b", "x"]);
  });

  it("puts a card dropped at the top first", () => {
    const ordered = persistedColumnOrder(
      [card("x", 99), card("b", 1), card("a", 0)],
      "x"
    );
    expect(ordered.map((c) => c.id)).toEqual(["x", "a", "b"]);
  });

  it("handles a reorder within the column (moved card already stored here)", () => {
    const ordered = persistedColumnOrder(
      [card("c", 2), card("a", 0), card("b", 1)],
      "c"
    );
    // Survivors keep stored order (a, b); c lands right after its display
    // predecessor, which is nothing — it was dropped at the top.
    expect(ordered.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps displayed order for cards that share a position", () => {
    const ordered = persistedColumnOrder(
      [card("b", 0), card("a", 0), card("c", 0)],
      null
    );
    expect(ordered.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("tolerates a movedId that is not in the column", () => {
    const ordered = persistedColumnOrder([card("b", 1), card("a", 0)], "ghost");
    expect(ordered.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [card("b", 1), card("a", 0)];
    persistedColumnOrder(input, null);
    expect(input.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

/* ------------------------------------------------------------------ */
/* useKanban.moveEpic — the payload that actually reaches the database */
/* ------------------------------------------------------------------ */

function epic(overrides: Partial<KanbanEpic> & { id: string }): KanbanEpic {
  return {
    projectId: "proj-1",
    title: overrides.id,
    description: "d",
    priority: 0,
    status: "review",
    position: 0,
    branchName: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    confidence: null,
    evidence: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    type: "feature",
    linkedEpicId: null,
    images: null,
    readableId: null,
    releaseId: null,
    usCount: 0,
    usDone: 0,
    ...overrides,
  };
}

let epicsPayload: KanbanEpic[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/** Every reorder POST body seen so far, newest last. */
function reorderPayloads(): Array<{
  id: string;
  status: string;
  position: number;
}[]> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/epics/reorder"))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string).items);
}

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/epics")) {
      return { ok: true, json: async () => ({ data: epicsPayload }) };
    }
    if (String(url).endsWith("/releases")) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: true, json: async () => ({ data: {} }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountBoard() {
  const hook = renderHook(() => useKanban("proj-1"));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe("useKanban.moveEpic — Review keeps its derived order out of `position`", () => {
  it("does not swap two Review tickets when a third is dragged in", async () => {
    // A is in review (position 0); B is ready (position 1), so B is DISPLAYED
    // first. X arrives from To Do.
    epicsPayload = [
      epic({ id: "a", position: 0, mergeReadiness: BLOCKED }),
      epic({ id: "b", position: 1, mergeReadiness: READY }),
      epic({ id: "x", status: "todo", position: 0 }),
    ];

    const { result } = await mountBoard();
    expect(result.current.board.columns.review.map((e) => e.id)).toEqual([
      "b",
      "a",
    ]);

    // Dropped at the very bottom of the displayed column (after A).
    await act(async () => {
      await result.current.moveEpic("x", "todo", "review", 2);
    });

    await waitFor(() => expect(reorderPayloads()).toHaveLength(1));
    const review = reorderPayloads()[0]
      .filter((item) => item.status === "review")
      .sort((p, q) => p.position - q.position)
      .map((item) => item.id);

    // The regression: A and B must keep their stored relative order. Persisting
    // display indices would have written B=0, A=1 and swapped them.
    expect(review.indexOf("a")).toBeLessThan(review.indexOf("b"));
  });

  it("still persists plain display order for an ordinary column", async () => {
    epicsPayload = [
      epic({ id: "t1", status: "todo", position: 0 }),
      epic({ id: "t2", status: "todo", position: 1 }),
      epic({ id: "t3", status: "todo", position: 2 }),
    ];

    const { result } = await mountBoard();

    // Move t3 to the top of To Do.
    await act(async () => {
      await result.current.moveEpic("t3", "todo", "todo", 0);
    });

    await waitFor(() => expect(reorderPayloads()).toHaveLength(1));
    expect(
      reorderPayloads()[0]
        .sort((p, q) => p.position - q.position)
        .map((item) => item.id)
    ).toEqual(["t3", "t1", "t2"]);
  });

  it("re-indexes the column a card was dragged out of", async () => {
    epicsPayload = [
      epic({ id: "a", position: 0, mergeReadiness: BLOCKED }),
      epic({ id: "b", position: 1, mergeReadiness: READY }),
    ];

    const { result } = await mountBoard();

    await act(async () => {
      await result.current.moveEpic("b", "review", "done", 0);
    });

    await waitFor(() => expect(reorderPayloads()).toHaveLength(1));
    const review = reorderPayloads()[0].filter(
      (item) => item.status === "review"
    );
    expect(review).toEqual([{ id: "a", status: "review", position: 0 }]);
  });

  it("keeps a second drag correct by refreshing local positions", async () => {
    // Without writing the persisted positions back onto the local rows, the
    // second drag would re-sort Review by stale values and undo the first.
    epicsPayload = [
      epic({ id: "a", position: 0, mergeReadiness: BLOCKED }),
      epic({ id: "b", position: 1, mergeReadiness: READY }),
      epic({ id: "x", status: "todo", position: 0 }),
      epic({ id: "y", status: "todo", position: 1 }),
    ];

    const { result } = await mountBoard();

    await act(async () => {
      await result.current.moveEpic("x", "todo", "review", 0);
    });
    await waitFor(() => expect(reorderPayloads()).toHaveLength(1));

    await act(async () => {
      await result.current.moveEpic("y", "todo", "review", 3);
    });
    await waitFor(() => expect(reorderPayloads()).toHaveLength(2));

    const second = reorderPayloads()[1]
      .filter((item) => item.status === "review")
      .sort((p, q) => p.position - q.position)
      .map((item) => item.id);

    // X stayed at the head where the first drag put it, and A still precedes B.
    expect(second[0]).toBe("x");
    expect(second.indexOf("a")).toBeLessThan(second.indexOf("b"));
    expect(new Set(second)).toEqual(new Set(["a", "b", "x", "y"]));
  });
});
