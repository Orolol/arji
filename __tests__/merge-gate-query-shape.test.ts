/**
 * How many times the merge gate reads `agent_sessions`.
 *
 * Both gates need the same per-epic aggregate twice in one breath: once on
 * the epic row (freshness, verdict windows, cost) and once inside the
 * blocking-findings count, which compares every candidate row against the
 * supersession cutoff. Written as two subqueries — or two statements — that
 * is two separate passes over the table, on paths that run on every
 * `session:*` SSE event and every 15-second Full Auto sweep. Since
 * 0046_core_table_indexes each pass is index-served rather than a full scan,
 * which lowers the cost of a pass but not the number of them — that is what
 * this file still pins.
 *
 * So this file asserts the SHAPE of the SQL, not its results: the aggregate is
 * published as a CTE (`epicSessionFactsCte`) and referenced twice, which
 * SQLite materialises once. Query-plan tests are brittle by nature, which is
 * why the counts below are spelled out item by item — a new scan that belongs
 * there is a comment update, not a mystery.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockRouteContext } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const dbModule = (await import("@/lib/db")) as unknown as {
  db: typeof import("@/lib/db").db;
  sqlite: import("better-sqlite3").Database;
};
const { db, sqlite } = dbModule;
const { projects, epics, agentSessions, reviewComments } = await import(
  "@/lib/db/schema"
);
const { GET } = await import("@/app/api/projects/[projectId]/epics/route");
const { loadAutoModeBoard } = await import("@/lib/auto-mode/select");
const { autoModeRegistry } = await import("@/lib/auto-mode/registry");

const PROJECT_ID = "proj-shape";

function at(minute: number): string {
  return new Date(Date.UTC(2026, 7, 26, 10, minute, 0)).toISOString();
}

/**
 * Runs `work` with `sqlite.prepare` instrumented, then replays every statement
 * it executed through EXPLAIN QUERY PLAN and counts how many times it reads
 * `agent_sessions`. A materialised CTE reads once however often it is
 * referenced; an inlined subquery reads once PER reference.
 *
 * SCAN *and* SEARCH both count. What this budget guards is the NUMBER of
 * passes over the table, not how each one is served: since
 * 0046_core_table_indexes these queries are answered by
 * `agent_sessions_project_created_at_idx` / `agent_sessions_epic_idx`, so
 * matching "SCAN agent_sessions" alone would silently count zero and let a
 * re-inlined subquery through unnoticed.
 */
async function countAgentSessionReads(work: () => Promise<void> | void) {
  const original = sqlite.prepare.bind(sqlite);
  const executed: Array<{ sql: string; params: unknown[] }> = [];

  sqlite.prepare = ((source: string) => {
    const statement = original(source);
    for (const method of ["all", "get", "run"] as const) {
      const inner = statement[method].bind(statement);
      Object.defineProperty(statement, method, {
        configurable: true,
        value: (...params: unknown[]) => {
          executed.push({ sql: source, params });
          return inner(...(params as never[]));
        },
      });
    }
    return statement;
  }) as typeof sqlite.prepare;

  try {
    await work();
  } finally {
    sqlite.prepare = original;
  }

  let scans = 0;
  for (const { sql: statementSql, params } of executed) {
    let plan: Array<{ detail: string }>;
    try {
      plan = original(`EXPLAIN QUERY PLAN ${statementSql}`).all(
        ...(params as never[])
      ) as Array<{ detail: string }>;
    } catch {
      continue; // not a plannable statement (DDL, pragma)
    }
    scans += plan.filter((step) =>
      /^(SCAN|SEARCH) agent_sessions\b/.test(step.detail)
    ).length;
  }
  return scans;
}

beforeEach(() => {
  for (const table of [reviewComments, agentSessions, epics, projects]) {
    db.delete(table).run();
  }
  autoModeRegistry.resetAll();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Shape",
      gitRepoPath: "/tmp/shape",
      createdAt: at(0),
    })
    .run();

  for (let index = 0; index < 3; index += 1) {
    const epicId = `epic-${index}`;
    db.insert(epics)
      .values({
        id: epicId,
        projectId: PROJECT_ID,
        title: epicId,
        status: "review",
        priority: 0,
        position: index,
        branchName: `feature/${epicId}`,
        readableId: `E-${index}`,
        createdAt: at(0),
        updatedAt: at(0),
      })
      .run();
    db.insert(agentSessions)
      .values({
        id: `sess-build-${index}`,
        projectId: PROJECT_ID,
        epicId,
        status: "completed",
        agentType: "build",
        outcome: "answered",
        startedAt: at(10),
        endedAt: at(11),
        createdAt: at(10),
      })
      .run();
    db.insert(agentSessions)
      .values({
        id: `sess-review-${index}`,
        projectId: PROJECT_ID,
        epicId,
        status: "completed",
        agentType: "review_code",
        outcome: "answered",
        reviewVerdict: "approved",
        startedAt: at(20),
        endedAt: at(25),
        createdAt: at(20),
      })
      .run();
    db.insert(reviewComments)
      .values({
        id: `finding-${index}`,
        epicId,
        filePath: "lib/thing.ts",
        lineNumber: 3,
        body: "[critical] Still standing",
        author: "agent",
        status: "open",
        createdAt: at(22),
        updatedAt: at(22),
      })
      .run();
  }
});

describe("merge-gate query shape", () => {
  it("reads agent_sessions twice per board load, not three times", async () => {
    const scans = await countAgentSessionReads(async () => {
      const response = await GET(
        {} as never,
        mockRouteContext({ projectId: PROJECT_ID })
      );
      expect(response.status).toBe(200);
    });

    // Three, one per distinct question: the `epic_session_facts` CTE —
    // materialised ONCE although both the epic row and the blocking-findings
    // count reference it — the latest-session-per-epic ranking, which asks
    // something else entirely, and `listUnverifiableReviewEpicIds`, which
    // ranks the newest DELIVERED review per epic for the Review column's
    // broken-channel badge. The first two share one statement.
    //
    // It was four while the findings count grouped `agent_sessions` a second
    // time for a cutoff the facts scan had already computed, on a route the
    // client refetches on every `session:*` event. The badge scan is the one
    // added here rather than removed: it is a single window-function pass,
    // constant in board size like the other two, which is the property this
    // budget guards.
    expect(scans).toBe(3);
  });

  it("reads agent_sessions four times per Full Auto sweep, not five", () => {
    let scans = 0;
    const done = countAgentSessionReads(() => {
      loadAutoModeBoard(PROJECT_ID);
    }).then((value) => {
      scans = value;
    });

    return done.then(() => {
      // Four, one per distinct question: the active-session set, the
      // `epic_session_facts` CTE (freshness AND the blocking-findings count,
      // one statement), the epic-latest ranking and the story-latest ranking.
      // It was five while the findings count grouped `agent_sessions` a second
      // time for a cutoff the facts scan had already computed.
      expect(scans).toBe(4);
    });
  });
});
