/**
 * `fetchUnifiedSessions` — the client half of the paginated sessions list.
 *
 * The route bounds each response; this loop is what turns those pages back
 * into the whole list. Its contract is all-or-nothing on purpose: three
 * callers treat the result as complete data (the Sessions page's synthesis
 * band and both sort orders, `selectLatestFailures`' "newest session per epic
 * wins" verdict, and "What the agent did" picking the latest session of a
 * ticket), and a silently truncated list makes each of them quietly wrong
 * rather than visibly empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchUnifiedSessions,
  UnifiedSessionListIncompleteError,
  SESSION_LIST_MAX_PAGES,
} from "@/lib/agent-sessions/session-list";

interface Row {
  id: string;
}

/**
 * A fake route that serves `total` rows in pages of `pageSize`, using the same
 * "cursor is the last delivered row" shape as the real one.
 */
function serveRows(total: number, pageSize: number) {
  const rows: Row[] = Array.from({ length: total }, (_, i) => ({
    id: `row-${i}`,
  }));
  const requests: string[] = [];

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url.search);
    const cursor = url.searchParams.get("cursor");
    const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
    const page = rows.slice(start, start + pageSize);
    const next = start + pageSize < rows.length ? page[page.length - 1].id : null;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: page, nextCursor: next }),
    } as Response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchUnifiedSessions", () => {
  it("returns every row of a list far longer than the old 25-page cutoff", async () => {
    // 40 pages. The previous loop stopped at 25, logged to the developer
    // console and RETURNED — so callers got 25 pages of rows and no way to
    // tell they were holding a prefix.
    const { requests } = serveRows(400, 10);

    const rows = await fetchUnifiedSessions<Row>("proj-1", { limit: 10 });

    expect(rows).toHaveLength(400);
    expect(rows[0].id).toBe("row-0");
    expect(rows[399].id).toBe("row-399");
    expect(requests.length).toBeGreaterThan(25);
  });

  it("rejects instead of returning a prefix when the cursor stops advancing", async () => {
    // The failure the page cap was standing in for: a server that keeps
    // handing back the cursor it was given. A page count cannot tell that
    // apart from a genuinely long list; a repeated cursor can.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: `row-${calls}` }], nextCursor: "stuck" }),
        } as Response;
      })
    );

    await expect(fetchUnifiedSessions<Row>("proj-1")).rejects.toBeInstanceOf(
      UnifiedSessionListIncompleteError
    );
    // Two requests: the first learns the cursor, the second proves it repeats.
    expect(calls).toBe(2);
    expect(calls).toBeLessThan(SESSION_LIST_MAX_PAGES);
  });

  it("rejects at the page ceiling rather than returning a prefix", async () => {
    // The runaway backstop, behind the cursor-cycle check: a server that never
    // repeats a cursor and never ends. Cycle detection cannot see this one —
    // every cursor is genuinely new — so the page count is the only thing that
    // stops the loop, and what it does on the way out is the whole point. It
    // must reject: returning `rows` here would hand back a prefix wearing the
    // "complete list" contract, which is the failure this loop exists to make
    // impossible.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: `row-${calls}` }],
            nextCursor: `cursor-${calls}`,
          }),
        } as Response;
      })
    );

    const error = await fetchUnifiedSessions<Row>("proj-1").catch((e) => e);

    expect(error).toBeInstanceOf(UnifiedSessionListIncompleteError);
    // Stopped AT the ceiling — neither early nor one page past it.
    expect(calls).toBe(SESSION_LIST_MAX_PAGES);
    expect((error as UnifiedSessionListIncompleteError).partialRowCount).toBe(
      SESSION_LIST_MAX_PAGES
    );
  });

  it("carries how much it had collected when it gave up", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: `a-${calls}` }, { id: `b-${calls}` }],
            nextCursor: "stuck",
          }),
        } as Response;
      })
    );

    const error = await fetchUnifiedSessions<Row>("proj-1").catch((e) => e);
    expect(error).toBeInstanceOf(UnifiedSessionListIncompleteError);
    expect((error as UnifiedSessionListIncompleteError).partialRowCount).toBe(4);
  });

  it("still paints each page as it lands", async () => {
    serveRows(30, 10);
    const painted: number[] = [];

    await fetchUnifiedSessions<Row>("proj-1", {
      limit: 10,
      onPage: (rowsSoFar) => painted.push(rowsSoFar.length),
    });

    expect(painted).toEqual([10, 20, 30]);
  });

  it("propagates a failed response rather than returning what it has", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "row-0" }], nextCursor: "row-0" }),
          } as Response;
        }
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      })
    );

    await expect(fetchUnifiedSessions<Row>("proj-1")).rejects.toThrow(
      "Sessions list request failed (500)"
    );
  });
});
