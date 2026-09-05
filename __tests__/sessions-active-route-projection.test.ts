/**
 * `GET /api/projects/:projectId/sessions/active` — the PROJECTION, against a
 * real sqlite database.
 *
 * The route selected `prompt: agentSessions.prompt` for every running and
 * queued session to serve three substring tests in `inferDbActivityType`, and
 * never returned the column. So the defect is invisible to a response-level
 * assertion: the response was already prompt-free while the query materialised
 * every byte. These tests assert on what the query MATERIALISES instead, by
 * tapping `better-sqlite3` under drizzle — the only layer where "the column
 * was read" and "the column was returned" are distinguishable.
 *
 * Measured on the live database (2026-09-05, 1053 sessions carrying a prompt,
 * 77.58 MB total, 73.7 KB average, 4.96 MB largest), for the 7 sessions then
 * active — 704 KB of prompt:
 *
 *   3.424 ms/poll  selecting the column and lowercasing it in JS (the defect)
 *   1.687 ms/poll  `instr(lower(prompt), …)` booleans projected in SQL
 *   1.262 ms/poll  `substr(prompt, 1, 40000)` prefix
 *   0.068 ms/poll  not reading the column at all
 *
 * Both fixes the ticket suggested only halve the cost: SQLite still has to
 * read the blob off the page store and `lower()` it. better-sqlite3 is
 * synchronous on one shared connection, so that time is the whole event loop
 * — every other request and every SSE heartbeat — on a route the monitor
 * polls. Hence the third option: stop reading the column.
 *
 * That is sound because the heuristic was measurably unable to be right. It
 * sat behind `agent_type` branches that catch every session it claimed to
 * classify, so on the live database:
 *
 *   - all 15 sessions whose prompt IS the merge-resolution prompt carry
 *     `agent_type = 'merge'`, caught before the fallback;
 *   - all 198 sessions carrying the review header carry `review_code` or
 *     `review_feature`, likewise caught before it;
 *   - no row in the table has a NULL `agent_type` at all;
 *   - of the 515 sessions that DID reach the fallback, 389 fired the merge
 *     substring test — 212 `ticket_build`, 172 `build`, 4 `forensic`, 1
 *     `spec_generation`. Every prompt carries the project spec and memory, so
 *     any project whose spec says the words "merge conflict" turned three
 *     quarters of its builds into "Merging" cards.
 *
 * `lib/control-desk/aggregate.ts` reached the same conclusion for the desk's
 * `inferTaskType` and left this route to its own ticket; the two
 * classifications are meant to agree, and now do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/activity-registry", () => ({
  activityRegistry: { listByProject: () => [] },
}));

vi.mock("@/lib/agent-sessions/chunks", () => ({
  lastSessionChunkAt: () => null,
}));

const { db, sqlite } = await import("@/lib/db");
const { agentSessions, epics, projects, userStories } = await import(
  "@/lib/db/schema"
);
const { GET } = await import(
  "@/app/api/projects/[projectId]/sessions/active/route"
);

const PROJECT_ID = "active-projection-project";
const EPIC_ID = "active-projection-epic";

/** Unique enough to find in a materialised row whatever key carries it. */
const PROMPT_SENTINEL = "SENTINEL_PROMPT_VALUE";

/**
 * A prompt shaped like the real thing: multi-megabyte, and carrying both
 * heuristic markers at the depth they actually sit at. On the live database
 * the "merge conflict" marker was measured between 159 and 37,037 characters
 * in (26.6 KB on average) — after the spec and memory sections — which is why
 * a short `substr` prefix cannot sample it either.
 */
function hugePrompt(): string {
  return [
    "## Project Specification\n",
    "s".repeat(2_000_000),
    `\n${PROMPT_SENTINEL}\n`,
    "## Merge Conflict Resolution\nA `git merge main` was started.\n",
    "You are performing a **security review** on the code changes.\n",
    "m".repeat(2_000_000),
  ].join("");
}

interface Materialised {
  /** Every row object any statement handed back to drizzle during the call. */
  rows: unknown[];
  /** SQL text of every statement prepared during the call. */
  sql: string[];
}

/**
 * Runs the route with `sqlite.prepare` tapped, and reports what came back
 * across the driver boundary.
 *
 * Tapping the driver rather than `db.select` is deliberate: it sees the query
 * whatever shape drizzle's builder API takes, and it measures VALUES, so a
 * column re-entering under an alias (`promptText: agentSessions.prompt`) is
 * caught by the sentinel it carries rather than escaping a check on key names.
 */
async function activityWithMaterialisedRows(): Promise<{
  data: Array<Record<string, unknown>>;
  materialised: Materialised;
}> {
  const materialised: Materialised = { rows: [], sql: [] };
  const realPrepare = sqlite.prepare.bind(sqlite);

  const spy = vi
    .spyOn(sqlite, "prepare")
    .mockImplementation(((source: string) => {
      materialised.sql.push(source);
      const statement = realPrepare(source);
      const realAll = statement.all.bind(statement);
      statement.all = (...args: unknown[]) => {
        const rows = realAll(...(args as [])) as unknown[];
        materialised.rows.push(...rows);
        return rows;
      };
      return statement;
    }) as typeof sqlite.prepare);

  try {
    const response = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: PROJECT_ID })
    );
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      data: Array<Record<string, unknown>>;
    };
    return { data: parsed.data, materialised };
  } finally {
    spy.mockRestore();
  }
}

function materialisedBytes(materialised: Materialised): number {
  return Buffer.byteLength(JSON.stringify(materialised.rows), "utf-8");
}

function seedSession(
  id: string,
  values: Partial<typeof agentSessions.$inferInsert> = {}
): void {
  db.insert(agentSessions)
    .values({
      id,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: "running",
      mode: "code",
      provider: "claude-code",
      agentType: "build",
      orchestrationMode: "solo",
      startedAt: "2026-09-05 10:00:00",
      createdAt: "2026-09-05 10:00:00",
      ...values,
    })
    .run();
}

beforeEach(() => {
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  db.insert(projects).values({ id: PROJECT_ID, name: "Active" }).run();
  db.insert(epics)
    .values({ id: EPIC_ID, projectId: PROJECT_ID, title: "Payments" })
    .run();
});

describe("active sessions projection", () => {
  it("never materialises the prompt column", async () => {
    // The finding, stated as its own assertion so it survives any rewrite of
    // the byte ceiling below.
    seedSession("sess-huge", { prompt: hugePrompt() });

    const { materialised } = await activityWithMaterialisedRows();

    const carrying = materialised.rows.filter((row) =>
      JSON.stringify(row).includes(PROMPT_SENTINEL)
    );
    expect(carrying).toEqual([]);
  });

  it("keeps a poll bounded in bytes however large the stored prompts are", async () => {
    // The row count is bounded by how many sessions are active; nothing bounds
    // how large a row is. Five sessions at ~4 MB of prompt each is 20 MB read,
    // lowercased and thrown away per poll — and the write-side cap
    // (SESSION_PROMPT_MAX_STORED_BYTES) only lowers that ceiling, it does not
    // remove it. The bound has to hold on the materialised row.
    for (let i = 0; i < 5; i += 1) {
      seedSession(`sess-huge-${i}`, { prompt: hugePrompt() });
    }

    const { data, materialised } = await activityWithMaterialisedRows();

    expect(data).toHaveLength(5);
    expect(materialisedBytes(materialised)).toBeLessThan(64 * 1024);
  });

  it("does not read the prompt column in SQL either", async () => {
    // A `substr`/`instr` projection would keep the response and the
    // materialised rows small while SQLite still read and lowercased every
    // byte — measured at only half the saving (see the header). This pins the
    // column out of the query text, not just out of its result.
    seedSession("sess-huge", { prompt: hugePrompt() });

    const { materialised } = await activityWithMaterialisedRows();

    const readingPrompt = materialised.sql.filter((source) =>
      /\bprompt\b/.test(source)
    );
    expect(readingPrompt).toEqual([]);
  });
});

describe("active sessions classification", () => {
  it("does not label a build as merging because its prompt says the words", async () => {
    // The false positive the heuristic could only ever produce: this session
    // is a build, and its prompt carries the spec that mentions a merge
    // conflict. 389 of the 515 live sessions reaching the fallback looked
    // exactly like this.
    seedSession("sess-build", {
      agentType: "build",
      prompt: hugePrompt(),
    });

    const { data } = await activityWithMaterialisedRows();

    expect(data[0]).toMatchObject({
      id: "sess-build",
      type: "build",
      label: "Building: Payments",
    });
  });

  it("still classifies a real merge session by its agent type", async () => {
    // The behaviour the heuristic claimed to provide, delivered by the branch
    // that was already catching it: every merge-resolution dispatch site
    // writes `agent_type = 'merge'`.
    seedSession("sess-merge", { agentType: "merge", prompt: hugePrompt() });

    const { data } = await activityWithMaterialisedRows();

    expect(data[0]).toMatchObject({
      id: "sess-merge",
      type: "merge",
      label: "Merging: Payments",
    });
  });

  it("still classifies a real review session by its agent type", async () => {
    seedSession("sess-review", {
      agentType: "review_security",
      prompt: hugePrompt(),
    });

    const { data } = await activityWithMaterialisedRows();

    expect(data[0]).toMatchObject({
      id: "sess-review",
      type: "review",
      label: "Reviewing: Payments",
    });
  });
});
