/**
 * Keyset pagination of the unified sessions list, against a REAL sqlite
 * database — the chain mock cannot exercise a `WHERE` clause, and the whole
 * point of this route's cursor is that its SQL predicate and its JS
 * comparator agree exactly. What is asserted here is the property that
 * matters to callers: paging through at any page size yields the same rows,
 * in the same order, as one unpaginated read — no duplicate at a page
 * boundary, no row skipped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/agent-sessions/backfill", () => ({
  runBackfillRecentSessionLastNonEmptyTextOnce: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/chunks", () => ({
  lastSessionChunkAt: () => null,
}));

const { db } = await import("@/lib/db");
const { agentSessions, chatConversations, projects } =
  await import("@/lib/db/schema");
const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
const { SESSION_LIST_DEFAULT_PAGE_SIZE, SESSION_LIST_MAX_PAGE_SIZE } =
  await import("@/lib/agent-sessions/session-list");

const PROJECT_ID = "paging-project";

interface ListedRow {
  id: string;
  kind: string;
  createdAt: string | null;
}

async function fetchPage(
  searchParams: Record<string, string> = {}
): Promise<{ data: ListedRow[]; nextCursor: string | null }> {
  const response = await GET(
    mockNextRequest({ searchParams }),
    mockRouteContext({ projectId: PROJECT_ID })
  );
  expect(response.status).toBe(200);
  return response.json();
}

/** Follow `nextCursor` to exhaustion and return the concatenated rows. */
async function fetchAllPages(
  limit?: number
): Promise<{ rows: ListedRow[]; pages: number }> {
  const rows: ListedRow[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const params: Record<string, string> = {};
    if (limit !== undefined) params.limit = String(limit);
    if (cursor) params.cursor = cursor;

    const body = await fetchPage(params);
    rows.push(...body.data);
    pages++;
    cursor = body.nextCursor;
    if (!cursor) return { rows, pages };
    // The seeds below are far smaller than this; a runaway means the cursor
    // stopped advancing.
    expect(pages).toBeLessThan(200);
  }
}

const key = (rows: ListedRow[]) => rows.map((row) => `${row.kind}:${row.id}`);

beforeEach(() => {
  db.delete(agentSessions).run();
  db.delete(chatConversations).run();
  db.delete(projects).run();
  db.insert(projects)
    .values([
      { id: PROJECT_ID, name: "Paging" },
      { id: "other-project", name: "Other" },
    ])
    .run();
});

/**
 * `n` sessions one minute apart, newest last. Ids are deliberately mixed
 * case: nanoid's alphabet is `A-Za-z0-9_-`, and SQLite's BINARY collation
 * orders those differently from `String.localeCompare`, so a tie-breaking
 * mismatch between the SQL keyset and the JS sort shows up here.
 */
function seedSessions(n: number, projectId = PROJECT_ID): void {
  const prefix = projectId === PROJECT_ID ? "" : `${projectId}-`;
  db.insert(agentSessions)
    .values(
      Array.from({ length: n }, (_, index) => ({
        id: `${prefix}${index % 2 === 0 ? "S" : "s"}ess-${String(index).padStart(3, "0")}`,
        projectId,
        status: "completed",
        createdAt: `2026-02-${String(10 + Math.floor(index / 60)).padStart(2, "0")}T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      }))
    )
    .run();
}

describe("sessions list route — keyset pagination", () => {
  it("defaults to a bounded page and reports a cursor for the rest", async () => {
    seedSessions(SESSION_LIST_DEFAULT_PAGE_SIZE + 5);

    const first = await fetchPage();

    expect(first.data).toHaveLength(SESSION_LIST_DEFAULT_PAGE_SIZE);
    expect(first.nextCursor).toBeTruthy();
  });

  it("stops paging when the last row has been delivered", async () => {
    seedSessions(4);

    const { rows, pages } = await fetchAllPages(2);

    expect(pages).toBe(2);
    expect(rows).toHaveLength(4);
    // The page that emptied the list must not advertise another one.
    const last = await fetchPage({ limit: "10" });
    expect(last.nextCursor).toBeNull();
  });

  it("pages a mixed session/conversation list without gaps or duplicates", async () => {
    seedSessions(25);
    db.insert(chatConversations)
      .values([
        // Interleaved with the sessions, including an exact timestamp tie.
        {
          id: "Conv-a",
          projectId: PROJECT_ID,
          label: "A",
          createdAt: "2026-02-10T00:05:00.000Z",
        },
        {
          id: "conv-b",
          projectId: PROJECT_ID,
          label: "B",
          createdAt: "2026-02-10T00:17:30.000Z",
        },
        {
          id: "conv-c",
          projectId: PROJECT_ID,
          label: "C",
          createdAt: "2026-02-10T00:24:00.000Z",
        },
      ])
      .run();

    const unpaginated = await fetchPage({ limit: "500" });
    expect(unpaginated.data).toHaveLength(28);
    expect(unpaginated.nextCursor).toBeNull();

    for (const limit of [1, 2, 3, 7, 27]) {
      const { rows } = await fetchAllPages(limit);
      expect(key(rows), `limit=${limit}`).toEqual(key(unpaginated.data));
      expect(new Set(key(rows)).size, `limit=${limit}`).toBe(rows.length);
    }
  });

  it("keeps rows without a created_at reachable on the last page", async () => {
    // Legacy rows: `created_at` is nullable, and the sort puts them last. A
    // keyset that compared NULL directly would drop them from every page
    // after the first.
    db.insert(agentSessions)
      .values([
        {
          id: "with-date",
          projectId: PROJECT_ID,
          status: "completed",
          createdAt: "2026-02-10T00:00:00.000Z",
        },
        { id: "legacy-a", projectId: PROJECT_ID, status: "failed", createdAt: null },
        { id: "legacy-b", projectId: PROJECT_ID, status: "failed", createdAt: null },
      ])
      .run();

    const { rows } = await fetchAllPages(1);

    expect(rows.map((row) => row.id)).toEqual([
      "with-date",
      "legacy-a",
      "legacy-b",
    ]);
  });

  it("scopes every page to the requested project", async () => {
    seedSessions(6);
    // Same timestamps, so the other project's rows sit inside the paged range
    // rather than after it — a cursor that lost its project filter would pull
    // them in.
    seedSessions(6, "other-project");
    expect(db.select({ id: agentSessions.id }).from(agentSessions).all())
      .toHaveLength(12);

    const { rows } = await fetchAllPages(2);

    expect(rows).toHaveLength(6);
    expect(rows.every((row) => !row.id.startsWith("other-project-"))).toBe(true);
  });

  it("clamps the page size and ignores an unusable cursor", async () => {
    seedSessions(12);

    expect((await fetchPage({ limit: "0" })).data).toHaveLength(1);
    expect((await fetchPage({ limit: "-4" })).data).toHaveLength(1);
    expect((await fetchPage({ limit: "not-a-number" })).data).toHaveLength(12);
    expect(
      (await fetchPage({ limit: String(SESSION_LIST_MAX_PAGE_SIZE * 10) })).data
    ).toHaveLength(12);
    // A cursor that never came from this route restarts at the first page
    // instead of erroring or silently returning nothing.
    expect((await fetchPage({ cursor: "garbage" })).data).toHaveLength(12);
  });
});
