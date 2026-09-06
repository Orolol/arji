/**
 * `useTicketOverlayData` × the paginated unified session list.
 *
 * "What the agent is doing" needs ONE row: the newest agent session of the
 * open ticket. The list route serves keyset pages newest-first, and the hook
 * used to collect the WHOLE list through `fetchUnifiedSessions` before taking
 * the first match — every page after the one holding the answer was a wasted
 * round trip — and it passed no AbortSignal, so closing the overlay or
 * opening another ticket left the loop paging a list nobody would read.
 *
 * WHAT THESE TESTS COUNT. Requests that reach the list route, through a fetch
 * stub that serves a fixed three-page list and can hold its first page open.
 * The two behaviours pinned are (1) the walk stops at the page holding the
 * match and (2) the cleanup aborts an in-flight walk. The stale-write guard
 * was already in place before this fix and is asserted only as a control.
 *
 * The overlay is the live re-render case in this family: the cross-project
 * desk at `/` opens tickets of different projects without remounting, so the
 * hook's `projectId` and `epicId` change under a mount that stays put. That
 * is the path `rerender` drives here.
 *
 * The composed hooks are deliberately real, answered by a URL-aware stub in
 * the same way as `ticket-overlay-unresolved-project.test.tsx`; the sibling
 * overlay specs mock the session-list module, which is exactly why they could
 * not see how many pages it fetched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useTicketOverlayData } from "@/hooks/useTicketOverlayData";

interface Row {
  id: string;
  kind: "agent_session" | "chat_session";
  epicId: string | null;
  createdAt: string;
}

function row(id: string, kind: Row["kind"], epicId: string | null): Row {
  return { id, kind, epicId, createdAt: "2026-03-10T00:00:00.000Z" };
}

/**
 * Newest first, as the route sorts. Page 1 holds the answer for `epic-1`
 * behind two rows that must be skipped — a chat conversation on the same
 * ticket and another ticket's session — and the two older pages hold only
 * older sessions of the same ticket, which a correct walk never asks for.
 */
const ROWS: Row[] = [
  // page 1
  row("chat-1", "chat_session", "epic-1"),
  row("sess-e2", "agent_session", "epic-2"),
  row("sess-new", "agent_session", "epic-1"),
  // page 2
  row("sess-old", "agent_session", "epic-1"),
  row("sess-e3", "agent_session", "epic-3"),
  row("chat-2", "chat_session", null),
  // page 3
  row("sess-older", "agent_session", "epic-1"),
  row("sess-e4", "agent_session", "epic-4"),
];

/** Fixed by the stub, whatever `?limit=` says: three pages for eight rows. */
const PAGE_SIZE = 3;

const LIST_PATH = /^\/api\/projects\/([^/]+)\/sessions$/;
const DETAIL_PATH = /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)$/;

interface ListRequest {
  cursor: string | null;
  signal: AbortSignal | undefined;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Everything else the overlay's hooks load on open, answered with the neutral
 * shape each reader accepts — the same table as the unresolved-project spec.
 */
function neutralPayload(pathname: string): unknown {
  if (pathname.includes("/dependencies")) {
    return { data: { predecessors: [], successors: [] } };
  }
  if (pathname.includes("/grading") || pathname.includes("/verify")) {
    return { data: null };
  }
  if (/^\/api\/projects\/[^/]+$/.test(pathname) || pathname.startsWith("/api/settings")) {
    return { data: {} };
  }
  return { data: [] };
}

function serveSessions({ holdFirstListRequest }: { holdFirstListRequest?: Promise<void> } = {}) {
  const listRequests: ListRequest[] = [];
  const detailRequests: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { signal?: AbortSignal }) => {
      const url = new URL(String(input), "http://localhost");
      const signal = init?.signal;
      // Real fetch rejects at once on a signal that is already aborted.
      if (signal?.aborted) throw abortError();

      const list = LIST_PATH.exec(url.pathname);
      if (list) {
        const cursor = url.searchParams.get("cursor");
        listRequests.push({ cursor, signal });
        if (listRequests.length === 1 && holdFirstListRequest) {
          await new Promise<void>((resolve, reject) => {
            void holdFirstListRequest.then(resolve);
            signal?.addEventListener("abort", () => reject(abortError()));
          });
        }
        const start = cursor ? ROWS.findIndex((r) => r.id === cursor) + 1 : 0;
        const page = ROWS.slice(start, start + PAGE_SIZE);
        const nextCursor =
          start + PAGE_SIZE < ROWS.length ? page[page.length - 1].id : null;
        return { ok: true, status: 200, json: async () => ({ data: page, nextCursor }) };
      }

      const detail = DETAIL_PATH.exec(url.pathname);
      if (detail && detail[2] !== "active" && detail[2] !== "resumable") {
        detailRequests.push(detail[2]);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              arijActions: [
                { kind: "comment", summary: `recorded by ${detail[2]}`, at: null },
              ],
            },
          }),
        };
      }

      return { ok: true, status: 200, json: async () => neutralPayload(url.pathname) };
    })
  );

  return { listRequests, detailRequests };
}

interface Props {
  projectId: string;
  epicId: string | null;
  open: boolean;
}

function renderOverlayData(initial: Partial<Props> = {}) {
  return renderHook(
    ({ projectId, epicId, open }: Props) => useTicketOverlayData(projectId, epicId, open),
    { initialProps: { projectId: "p1", epicId: "epic-1", open: true, ...initial } }
  );
}

/** Let an abandoned loop run as far as it will, flushing what it schedules. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

const originalEventSource = (globalThis as Record<string, unknown>).EventSource;

beforeEach(() => {
  // jsdom has no EventSource; `useProjectEvents` then stays quiet, which is
  // what keeps the request log below about the session list alone.
  delete (globalThis as Record<string, unknown>).EventSource;
});

afterEach(() => {
  vi.unstubAllGlobals();
  (globalThis as Record<string, unknown>).EventSource = originalEventSource;
});

describe("useTicketOverlayData — finding the ticket's newest session", () => {
  it("stops at the page that holds it instead of walking the list to the end", async () => {
    const stub = serveSessions();
    const view = renderOverlayData();

    await waitFor(() =>
      expect(view.result.current.sessionHref).toBe("/projects/p1/sessions/sess-new")
    );
    await waitFor(() =>
      expect(view.result.current.timeline.map((line) => line.text)).toContain(
        "recorded by sess-new"
      )
    );

    // The chat row on the same ticket and the other ticket's session were
    // skipped; the two pages of older sessions were never requested.
    expect(stub.detailRequests).toEqual(["sess-new"]);
    expect(stub.listRequests.map((r) => r.cursor)).toEqual([null]);
  });

  it("still walks the whole list when the ticket has no session, and shows none", async () => {
    // The control, and the cost the early exit does not remove: "no session"
    // can only be known at the end of the list. A server-side filter would
    // shorten this case; the client cannot.
    const stub = serveSessions();
    const view = renderOverlayData({ epicId: "epic-9" });

    await waitFor(() => expect(stub.listRequests).toHaveLength(3));
    await settle();

    expect(stub.listRequests.map((r) => r.cursor)).toEqual([null, "sess-new", "chat-2"]);
    expect(stub.detailRequests).toEqual([]);
    expect(view.result.current.sessionHref).toBeNull();
  });
});

describe("useTicketOverlayData — abandoning a walk still in flight", () => {
  it("stops paging when the overlay closes while the first page is loading", async () => {
    const gate = deferred();
    const stub = serveSessions({ holdFirstListRequest: gate.promise });
    const view = renderOverlayData();
    await waitFor(() => expect(stub.listRequests).toHaveLength(1));

    view.rerender({ projectId: "p1", epicId: "epic-1", open: false });
    await act(async () => {
      gate.resolve();
    });
    await settle();

    // One request: the one that was in flight, and it was told to stop. The
    // list has two more pages and none of them was asked for.
    expect(stub.listRequests.map((r) => r.cursor)).toEqual([null]);
    expect(stub.listRequests[0].signal?.aborted).toBe(true);
    expect(stub.detailRequests).toEqual([]);
    expect(view.result.current.sessionHref).toBeNull();
  });

  it("abandons the first ticket's walk when another ticket opens mid-load", async () => {
    const gate = deferred();
    const stub = serveSessions({ holdFirstListRequest: gate.promise });
    const view = renderOverlayData();
    await waitFor(() => expect(stub.listRequests).toHaveLength(1));

    view.rerender({ projectId: "p1", epicId: "epic-2", open: true });
    await waitFor(() =>
      expect(view.result.current.sessionHref).toBe("/projects/p1/sessions/sess-e2")
    );
    await act(async () => {
      gate.resolve();
    });
    await settle();

    // Two first pages — one per ticket — and nothing after either: the first
    // walk was aborted, the second stopped on its match.
    expect(stub.listRequests.map((r) => r.cursor)).toEqual([null, null]);
    expect(stub.listRequests[0].signal?.aborted).toBe(true);
    expect(stub.listRequests[1].signal?.aborted).toBe(false);
    expect(stub.detailRequests).toEqual(["sess-e2"]);
    expect(view.result.current.sessionHref).toBe("/projects/p1/sessions/sess-e2");
  });
});
