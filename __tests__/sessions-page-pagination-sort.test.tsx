/**
 * Sessions list page × the route's keyset pagination.
 *
 * `GET /api/projects/:id/sessions` is bounded: it serves a page plus a
 * `nextCursor`, and the page follows that cursor to the end. Bounding the
 * response moved a guarantee the list used to get for free — "the order you
 * render is the order the server sent" — onto the client, because the list is
 * now assembled from several responses instead of one.
 *
 * `sessions-list-pagination.test.ts` proves the route pages correctly and
 * `sessions-list-fetch-contract.test.ts` proves the loop in
 * `fetchUnifiedSessions` reaches the end. Neither mounts the page, and every
 * assertion in `sessions-page-queued.test.tsx` runs against a single-page
 * response with no `nextCursor`. So the two acceptance criteria that are
 * specifically about the *paged* list on screen — both sort orders still
 * correct, and the sort surviving a page landing — had no test at the layer
 * they describe. That is what this file covers.
 *
 * The sorts fail differently, and both are covered on purpose:
 *   - "Created" does not sort at all. It renders the accumulated order and
 *     trusts that concatenating the route's pages reproduces the global
 *     order, so it breaks if a page is dropped or spliced in out of order.
 *   - "Last activity" sorts client-side over everything loaded, so it breaks
 *     if it only ever sees the first page — and it breaks *silently*, as a
 *     plausible-looking order that is missing its tail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import SessionsPage from "@/app/projects/[projectId]/sessions/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

// Same substitution as sessions-page-queued.test.tsx: Radix Select's
// portal/pointer plumbing is covered by the shared UI component, and a native
// select is what lets jsdom drive the controlled value and read back the
// resulting row order.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      aria-label="Sort sessions"
      data-testid="sessions-sort"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => <option value={value}>{children}</option>,
}));

function agentSession(overrides: Record<string, unknown>) {
  const createdAt =
    typeof overrides.createdAt === "string"
      ? overrides.createdAt
      : new Date().toISOString();
  return {
    kind: "agent_session",
    id: "sess-x",
    status: "completed",
    mode: "code",
    provider: "claude-code",
    createdAt,
    lastActivityAt: createdAt,
    ...overrides,
  };
}

function chatSession(overrides: Record<string, unknown>) {
  const createdAt =
    typeof overrides.createdAt === "string"
      ? overrides.createdAt
      : new Date().toISOString();
  return {
    kind: "chat_session",
    id: "conv-x",
    type: "brainstorm",
    label: "Chat",
    status: "active",
    provider: "claude-code",
    messageCount: 1,
    lastMessagePreview: "Hello",
    createdAt,
    lastActivityAt: createdAt,
    ...overrides,
  };
}

interface Page {
  data: unknown[];
  nextCursor: string | null;
  /**
   * Optional gate. Resolve it to let this page's response land, so a test can
   * observe the list mid-load instead of only after the loop has finished.
   */
  release?: Promise<void>;
}

/**
 * Serve `pages` as the route does: keyed on `?cursor=`, each response
 * carrying the cursor for the next one and the last carrying `null`. The
 * stub asserts nothing itself — it just refuses to hand out a page the client
 * did not ask for by cursor, so a client that ignored `nextCursor` and
 * re-requested page 1 forever could not read as success.
 */
function mockPagedSessions(pages: Page[]) {
  const byCursor = new Map<string | null, Page>();
  let key: string | null = null;
  for (const page of pages) {
    byCursor.set(key, page);
    key = page.nextCursor;
  }

  const requestedCursors: (string | null)[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url), "http://localhost");
      if (parsed.pathname.includes("/build/night-runs")) {
        return { ok: true, json: async () => ({ data: [] }) };
      }

      const cursor = parsed.searchParams.get("cursor");
      requestedCursors.push(cursor);
      const page = byCursor.get(cursor);
      if (!page) {
        throw new Error(`stub has no page for cursor ${String(cursor)}`);
      }
      if (page.release) await page.release;
      return {
        ok: true,
        json: async () => ({ data: page.data, nextCursor: page.nextCursor }),
      };
    })
  );

  return { requestedCursors };
}

function visibleSessionIds(): string[] {
  return screen
    .getAllByTestId(/^session-row-/)
    .map((row) => row.getAttribute("data-testid")!.replace("session-row-", ""));
}

async function renderPage() {
  render(<SessionsPage />);
  await waitFor(() =>
    expect(screen.queryByText("Loading sessions...")).not.toBeInTheDocument()
  );
}

/**
 * Two pages in the route's own order — newest first, and strictly descending
 * across the boundary, which is what the keyset guarantees.
 *
 * The activity timestamps deliberately run the *other* way: the oldest-created
 * session on page 2 is the most recently active. So the two sort orders are
 * exact reverses of each other, and neither can be produced by accident from
 * the other — or from page 1 alone.
 */
const PAGE_ONE = [
  agentSession({
    id: "sess-created-1st",
    createdAt: "2026-03-10T00:00:00.000Z",
    lastActivityAt: "2026-03-10T00:00:00.000Z",
  }),
  chatSession({
    id: "conv-created-2nd",
    createdAt: "2026-03-09T00:00:00.000Z",
    lastActivityAt: "2026-03-11T00:00:00.000Z",
  }),
];

const PAGE_TWO = [
  agentSession({
    id: "sess-created-3rd",
    createdAt: "2026-03-08T00:00:00.000Z",
    lastActivityAt: "2026-03-12T00:00:00.000Z",
  }),
  agentSession({
    id: "sess-created-4th",
    createdAt: "2026-03-07T00:00:00.000Z",
    lastActivityAt: "2026-03-13T00:00:00.000Z",
  }),
];

const CREATED_ORDER = [
  "sess-created-1st",
  "conv-created-2nd",
  "sess-created-3rd",
  "sess-created-4th",
];

const ACTIVITY_ORDER = [...CREATED_ORDER].reverse();

describe("SessionsPage — paged list keeps both sort orders", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("follows the route's cursor instead of rendering only the first page", async () => {
    const { requestedCursors } = mockPagedSessions([
      { data: PAGE_ONE, nextCursor: "2026-03-09T00:00:00.000Z|conv-created-2nd" },
      { data: PAGE_TWO, nextCursor: null },
    ]);

    await renderPage();

    await waitFor(() => expect(visibleSessionIds()).toHaveLength(4));
    // The second request echoes the first response's cursor back, so this is
    // the paging contract and not just "four rows arrived somehow".
    expect(requestedCursors).toEqual([
      null,
      "2026-03-09T00:00:00.000Z|conv-created-2nd",
    ]);
    expect(screen.queryByTestId("sessions-incomplete")).not.toBeInTheDocument();
  });

  it("keeps the default creation order across the page boundary", async () => {
    mockPagedSessions([
      { data: PAGE_ONE, nextCursor: "2026-03-09T00:00:00.000Z|conv-created-2nd" },
      { data: PAGE_TWO, nextCursor: null },
    ]);

    await renderPage();

    expect(screen.getByLabelText("Sort sessions")).toHaveValue("created");
    await waitFor(() => expect(visibleSessionIds()).toEqual(CREATED_ORDER));
  });

  it("sorts by last activity across every page, not within one", async () => {
    mockPagedSessions([
      { data: PAGE_ONE, nextCursor: "2026-03-09T00:00:00.000Z|conv-created-2nd" },
      { data: PAGE_TWO, nextCursor: null },
    ]);

    await renderPage();
    await waitFor(() => expect(visibleSessionIds()).toHaveLength(4));

    fireEvent.change(screen.getByLabelText("Sort sessions"), {
      target: { value: "last_activity" },
    });

    // The two most recently active sessions both live on page 2. A list that
    // stopped at page 1 would still produce a *plausible* order here — it
    // would just quietly be missing the rows that belong on top.
    expect(visibleSessionIds()).toEqual(ACTIVITY_ORDER);
  });

  it("does not lose a sort chosen while the remaining pages are still loading", async () => {
    let releasePageTwo: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releasePageTwo = resolve;
    });

    mockPagedSessions([
      { data: PAGE_ONE, nextCursor: "2026-03-09T00:00:00.000Z|conv-created-2nd" },
      { data: PAGE_TWO, nextCursor: null, release: gate },
    ]);

    // Page 1 paints and clears the loading state; page 2 is still in flight.
    await renderPage();
    expect(visibleSessionIds()).toEqual([
      "sess-created-1st",
      "conv-created-2nd",
    ]);

    fireEvent.change(screen.getByLabelText("Sort sessions"), {
      target: { value: "last_activity" },
    });
    expect(visibleSessionIds()).toEqual([
      "conv-created-2nd",
      "sess-created-1st",
    ]);

    releasePageTwo();

    // The tail lands into the sort the user already chose: the control still
    // reads "last activity" and the rows it brought are merged into that
    // order, not appended in creation order underneath it.
    await waitFor(() => expect(visibleSessionIds()).toHaveLength(4));
    expect(screen.getByLabelText("Sort sessions")).toHaveValue("last_activity");
    expect(visibleSessionIds()).toEqual(ACTIVITY_ORDER);
  });

  it("marks the list incomplete rather than showing a prefix as the whole list", async () => {
    // A server that keeps handing back the same cursor. The loop must refuse
    // it: the band's counts and both sort orders are derived from every row,
    // so a missing tail is wrong data, not merely less of it.
    //
    // Each response carries fresh ids — a stuck cursor is the failure under
    // test, and replaying identical rows would add a duplicate-React-key
    // problem on top of it that the page does not otherwise have.
    let served = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const parsed = new URL(String(url), "http://localhost");
        if (parsed.pathname.includes("/build/night-runs")) {
          return { ok: true, json: async () => ({ data: [] }) };
        }
        const batch = served++;
        return {
          ok: true,
          json: async () => ({
            data: [agentSession({ id: `sess-endless-${batch}` })],
            nextCursor: "stuck",
          }),
        };
      })
    );

    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId("sessions-incomplete")).toBeInTheDocument()
    );
  });
});
