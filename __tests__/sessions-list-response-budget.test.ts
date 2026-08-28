/**
 * `GET /api/projects/:projectId/sessions` — the BYTE bound, against a real
 * sqlite database.
 *
 * Pagination bounds how many rows a page carries; it does not bound how large
 * a row is. Two of the columns the list keeps are unbounded at the write side:
 *
 *   - `last_non_empty_text` is written from the last non-empty LINE of a
 *     chunk (`appendSessionChunk`), and a CLI that emits one 4 MB line without
 *     a newline stores 4 MB of it — the session-detail suite seeds exactly
 *     that shape.
 *   - `error` holds the complete terminal failure on purpose, and nothing
 *     truncates it.
 *
 * One such session was enough to push even a one-row page past the <1 MB
 * target the list is held to. These tests pin the bound where it has to hold:
 * on the response, for the worst row the store can produce.
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
const { agentSessions, chatConversations, epics, projects } = await import(
  "@/lib/db/schema"
);
const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
const { SESSION_LIST_ERROR_PREVIEW_CHARS } = await import(
  "@/lib/agent-sessions/session-list"
);
const { selectLatestFailures } = await import(
  "@/lib/agent-sessions/latest-failure"
);

const PROJECT_ID = "budget-project";

interface ListedSession {
  id: string;
  kind: string;
  error?: string | null;
  producedOutput?: boolean;
  epicId?: string | null;
  status: string;
  createdAt: string | null;
}

async function list(
  searchParams: Record<string, string> = {}
): Promise<{ body: { data: ListedSession[] }; bytes: number }> {
  const response = await GET(
    mockNextRequest({ searchParams }),
    mockRouteContext({ projectId: PROJECT_ID })
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  return { body, bytes: Buffer.byteLength(JSON.stringify(body), "utf-8") };
}

function seedSession(
  id: string,
  values: Partial<typeof agentSessions.$inferInsert> = {}
): void {
  db.insert(agentSessions)
    .values({
      id,
      projectId: PROJECT_ID,
      epicId: "epic-1",
      status: "failed",
      mode: "build",
      provider: "claude-code",
      agentType: "build",
      createdAt: "2026-08-21 10:00:00",
      endedAt: "2026-08-21 10:05:00",
      ...values,
    })
    .run();
}

beforeEach(() => {
  db.delete(agentSessions).run();
  db.delete(chatConversations).run();
  db.delete(epics).run();
  db.delete(projects).run();
  db.insert(projects).values({ id: PROJECT_ID, name: "Budget" }).run();
  db.insert(epics)
    .values({ id: "epic-1", projectId: PROJECT_ID, title: "Epic" })
    .run();
});

describe("sessions list response budget", () => {
  it("stays small for a page of sessions with megabyte-sized text columns", async () => {
    // 20 sessions, each carrying the worst row the store can produce: one 4 MB
    // output line and a 4 MB terminal error. Unprojected that is ~160 MB.
    for (let i = 0; i < 20; i += 1) {
      seedSession(`sess-${i}`, {
        lastNonEmptyText: "o".repeat(4_000_000),
        error: "E".repeat(4_000_000),
        createdAt: `2026-08-21 10:${String(i).padStart(2, "0")}:00`,
      });
    }

    const { body, bytes } = await list();

    expect(body.data).toHaveLength(20);
    expect(bytes).toBeLessThan(1024 * 1024);
  });

  it("keeps a single-row page bounded too", async () => {
    // The finding's exact shape: pagination alone would have called this a
    // one-row page and still shipped 8 MB.
    seedSession("sess-huge", {
      lastNonEmptyText: "o".repeat(4_000_000),
      error: "E".repeat(4_000_000),
    });

    const { body, bytes } = await list({ limit: "1" });

    expect(body.data).toHaveLength(1);
    expect(bytes).toBeLessThan(64 * 1024);
  });

  it("serves the error as a marked preview, not silently cut", async () => {
    seedSession("sess-long", { error: "E".repeat(10_000) });
    seedSession("sess-short", {
      error: "boom",
      createdAt: "2026-08-21 09:00:00",
    });

    const { body } = await list();
    const long = body.data.find((row) => row.id === "sess-long")!;
    const short = body.data.find((row) => row.id === "sess-short")!;

    expect(long.error).toBe(`${"E".repeat(SESSION_LIST_ERROR_PREVIEW_CHARS)}…`);
    // An error that fits comes back exactly as stored — no spurious ellipsis
    // on a value that happens to sit near the cap.
    expect(short.error).toBe("boom");

    const exact = "x".repeat(SESSION_LIST_ERROR_PREVIEW_CHARS);
    db.update(agentSessions).set({ error: exact }).run();
    const { body: after } = await list();
    expect(after.data.every((row) => row.error === exact)).toBe(true);
  });

  it("answers 'did the run speak' without shipping what it said", async () => {
    seedSession("spoke", { lastNonEmptyText: "Applying migrations" });
    seedSession("silent", {
      lastNonEmptyText: null,
      createdAt: "2026-08-21 09:00:00",
    });
    // Whitespace-only output is not output. This used to be decided in
    // JavaScript by `selectLatestFailures`; the trim moved into SQL with the
    // column, so this is where that rule is now covered.
    seedSession("whitespace", {
      lastNonEmptyText: "   \n  ",
      createdAt: "2026-08-21 08:00:00",
    });

    const { body } = await list();
    const byId = Object.fromEntries(body.data.map((row) => [row.id, row]));

    expect(byId.spoke.producedOutput).toBe(true);
    expect(byId.silent.producedOutput).toBe(false);
    expect(byId.whitespace.producedOutput).toBe(false);
    expect(byId.spoke).not.toHaveProperty("lastNonEmptyText");
  });

  it("still drives the board's failure badge", async () => {
    // End to end: the badge is the only consumer of that column in the list,
    // and it has to keep working off the flag that replaced it.
    seedSession("sess-failed", {
      lastNonEmptyText: "Trying to patch lib/foo.ts",
      error: "E".repeat(10_000),
    });

    const { body } = await list();
    const failed = selectLatestFailures(body.data, new Set());

    expect(failed["epic-1"].producedOutput).toBe(true);
    expect(failed["epic-1"].sessionId).toBe("sess-failed");
    expect(failed["epic-1"].error.length).toBeLessThanOrEqual(
      SESSION_LIST_ERROR_PREVIEW_CHARS + 1
    );
  });
});
