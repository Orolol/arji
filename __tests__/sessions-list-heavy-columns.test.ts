/**
 * `GET /api/projects/:projectId/sessions` — the PROJECTION, derived from the
 * schema instead of restated.
 *
 * The route used to be `db.select().from(agentSessions)`. On the live board
 * that shipped 44.91 MB for 391 sessions, of which `prompt` alone was
 * 44.21 MB — 98.4% of a payload whose list view never reads the column. It is
 * an explicit projection now, and the sibling suites pin the consequences:
 * `sessions-list-response-budget` pins the bytes, `sessions-list-pagination`
 * pins the rows, and `sessions-list-route` names the columns.
 *
 * That last one is the closest thing to this file, and its two limits are why
 * this one exists. It asserts on the argument handed to `select()`, through
 * the chain mock, against a hand-written list of names
 * (`expect(selected).not.toContain("prompt")`, and five more):
 *
 *   - a denylist cannot name a column that does not exist yet. The next heavy
 *     column added to `agent_sessions` is on nobody's list, and enters the
 *     list view unnoticed;
 *   - it checks the QUERY rather than the RESPONSE, and matches the key
 *     rather than the value. Measured: aliasing the same column as
 *     `promptText: agentSessions.prompt` ships all 4.96 MB of the largest
 *     stored prompt again and leaves all 8 of its tests green.
 *
 * This file inverts both. The schema is the source of truth — every column
 * `agent_sessions` declares is forbidden in the response until it is named in
 * the allowlist below, so a new column has to be admitted deliberately rather
 * than escape by never having been enumerated. And the assertions are on the
 * parsed response and on its serialised bytes, so a column returning under
 * another name is caught by the sentinel value it carries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
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

const { db, sqlite } = await import("@/lib/db");
const {
  agentSessions,
  chatConversations,
  chatMessages,
  epics,
  namedAgents,
  projects,
} = await import("@/lib/db/schema");
const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");

const PROJECT_ID = "projection-project";
const EPIC_ID = "projection-epic";
const NAMED_AGENT_ID = "projection-agent";

/**
 * `agent_sessions` columns the Sessions list is allowed to serve.
 *
 * Adding a name here is a decision that the column is safe to ship on every
 * row of every page — i.e. that it is bounded, or bounded on the way out.
 * `error` is the one entry of the second kind: it is unbounded in the store
 * and the route cuts it to a preview with `substr` in SQL
 * (SESSION_LIST_ERROR_PREVIEW_CHARS), which `sessions-list-response-budget`
 * pins. Everything else here is an id, a status, a timestamp or a scalar.
 */
const SESSION_COLUMNS_THE_LIST_SERVES = new Set([
  "id",
  "epicId",
  "userStoryId",
  "status",
  "mode",
  "provider",
  "agentType",
  "branchName",
  "startedAt",
  "endedAt",
  "completedAt",
  "createdAt",
  "error",
  "outcome",
  "inputTokens",
  "outputTokens",
  "totalCostUsd",
  "batchRunId",
  "namedAgentId",
  "namedAgentName",
  "model",
  "cliSessionId",
]);

/** Same contract for the chat half of the unified list. */
const CONVERSATION_COLUMNS_THE_LIST_SERVES = new Set([
  "id",
  "projectId",
  "type",
  "label",
  "status",
  "epicId",
  "provider",
  "namedAgentId",
  "createdAt",
]);

/**
 * Columns with no ceiling at the WRITE side, so no ceiling in a response that
 * carries them. `prompt` is the finding; the others are its neighbours in the
 * same table and would be the next 44 MB.
 *
 * This list is not what the assertions below are derived from — they are
 * derived from the schema. It is a floor under the allowlist: adding any of
 * these names to `SESSION_COLUMNS_THE_LIST_SERVES` would silence the
 * projection test, and fails here instead.
 */
const UNBOUNDED_SESSION_COLUMNS = [
  // The finding: the whole dispatch prompt, spec + memory + ticket context
  // included. Largest single stored value measured at 4.96 MB.
  "prompt",
  // Written from the last non-empty LINE of a chunk, uncapped: a CLI emitting
  // one 4 MB line without a newline stores 4 MB.
  "lastNonEmptyText",
  // Carries the prompt inline for providers that pass it as an argv value.
  "cliCommand",
  // JSON blobs, unbounded by construction.
  "cliOptions",
  "estimatedPromptBreakdown",
];

/** Keys the route synthesises; they answer to no schema column. */
const DERIVED_RESPONSE_KEYS = new Set([
  "kind",
  "lastActivityAt",
  "producedOutput",
  "messageCount",
  "lastMessagePreview",
  "namedAgentName",
]);

/**
 * The schema's columns minus the ones the list is allowed to serve. This is
 * the point of the file: the forbidden set is whatever the table declares, so
 * a column added to `agent_sessions` is forbidden the moment it exists.
 */
function forbiddenColumns(table: SQLiteTable, served: Set<string>): string[] {
  return Object.keys(getTableColumns(table)).filter((name) => !served.has(name));
}

/** A per-column value unique enough to search the serialised response for. */
function sentinel(column: string): string {
  return `SENTINEL_${column}_VALUE`;
}

/**
 * SQL names of the columns carrying a foreign key, read from the migrated
 * database rather than from the drizzle table object.
 *
 * The two disagree: `named_agent_id` has a real `REFERENCES named_agents(id)`
 * in the migration chain that `lib/db/schema.ts` never declares. A seed built
 * from the schema alone therefore violates a constraint the schema cannot see
 * — and a hand-written list of "the FK columns" would go stale the same way.
 * Asking the database keeps the seed exhaustive: a foreign key added later is
 * left NULL instead of failing the insert.
 */
function foreignKeyColumnNames(table: string): Set<string> {
  const rows = sqlite.pragma(`foreign_key_list(${table})`) as { from: string }[];
  return new Set(rows.map((row) => row.from));
}

/**
 * One session with EVERY column populated — built from the schema, so a
 * column added later is seeded, and therefore searched for, without touching
 * this file. Only what the route interprets is overridden: the timestamps it
 * sorts and merges on, the status it normalises, and the foreign keys.
 */
function seedFullyPopulatedSession(id: string, createdAt: string): void {
  const foreignKeys = foreignKeyColumnNames("agent_sessions");
  const values: Record<string, unknown> = {};
  for (const [name, column] of Object.entries(getTableColumns(agentSessions))) {
    if (foreignKeys.has(column.name)) {
      values[name] = null;
      continue;
    }
    values[name] = column.dataType === "number" ? 7 : sentinel(name);
  }

  Object.assign(values, {
    id,
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    namedAgentId: NAMED_AGENT_ID,
    status: "failed",
    createdAt,
    startedAt: "2026-09-01 10:00:00",
    endedAt: "2026-09-01 10:05:00",
    completedAt: "2026-09-01 10:05:00",
  });

  db.insert(agentSessions)
    .values(values as typeof agentSessions.$inferInsert)
    .run();
}

interface ListedRow {
  id: string;
  kind: string;
  [key: string]: unknown;
}

async function list(): Promise<{ rows: ListedRow[]; body: string }> {
  const response = await GET(
    mockNextRequest({}),
    mockRouteContext({ projectId: PROJECT_ID })
  );
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: ListedRow[] };
  return { rows: parsed.data, body: JSON.stringify(parsed) };
}

const sessionRows = (rows: ListedRow[]) =>
  rows.filter((row) => row.kind === "agent_session");

beforeEach(() => {
  db.delete(chatMessages).run();
  db.delete(agentSessions).run();
  db.delete(chatConversations).run();
  db.delete(epics).run();
  db.delete(namedAgents).run();
  db.delete(projects).run();
  db.insert(projects).values({ id: PROJECT_ID, name: "Projection" }).run();
  db.insert(epics)
    .values({ id: EPIC_ID, projectId: PROJECT_ID, title: "Epic" })
    .run();
  db.insert(namedAgents)
    .values({
      id: NAMED_AGENT_ID,
      name: "projection-agent",
      provider: "claude-code",
      model: "opus",
    })
    .run();
});

describe("sessions list projection", () => {
  it("never serves prompt, on any row", async () => {
    // The finding itself, stated as its own assertion so it survives any
    // rewrite of the derivation below.
    seedFullyPopulatedSession("sess-a", "2026-09-01 10:00:00");
    seedFullyPopulatedSession("sess-b", "2026-09-01 11:00:00");

    const { rows, body } = await list();

    expect(sessionRows(rows)).toHaveLength(2);
    for (const row of sessionRows(rows)) {
      expect(Object.keys(row)).not.toContain("prompt");
    }
    // Also absent by value: a projection aliasing the column under another
    // key would pass the check above.
    expect(body).not.toContain(sentinel("prompt"));
  });

  it("serves no agent_sessions column outside its allowlist", async () => {
    const forbidden = forbiddenColumns(
      agentSessions,
      SESSION_COLUMNS_THE_LIST_SERVES
    );
    seedFullyPopulatedSession("sess-full", "2026-09-01 10:00:00");

    const { rows, body } = await list();

    expect(sessionRows(rows)).toHaveLength(1);
    const served = new Set(Object.keys(sessionRows(rows)[0]));
    expect(forbidden.filter((name) => served.has(name))).toEqual([]);
    // Every forbidden column was populated with its own sentinel, so this
    // catches one re-entering under a renamed key as well.
    expect(forbidden.filter((name) => body.includes(sentinel(name)))).toEqual(
      []
    );
  });

  it("serves no chat_conversations column outside its allowlist", async () => {
    const forbidden = forbiddenColumns(
      chatConversations,
      CONVERSATION_COLUMNS_THE_LIST_SERVES
    );
    expect(forbidden.length).toBeGreaterThan(0);
    db.insert(chatConversations)
      .values({
        id: "conv-full",
        projectId: PROJECT_ID,
        label: "Conversation",
        createdAt: "2026-09-01 10:00:00",
        claudeSessionId: sentinel("claudeSessionId"),
        cliSessionId: sentinel("cliSessionId"),
      })
      .run();

    const { rows, body } = await list();

    const conversations = rows.filter((row) => row.kind === "chat_session");
    expect(conversations).toHaveLength(1);
    const served = new Set(Object.keys(conversations[0]));
    expect(forbidden.filter((name) => served.has(name))).toEqual([]);
    expect(forbidden.filter((name) => body.includes(sentinel(name)))).toEqual(
      []
    );
  });

  it("keeps every allowlist entry answering to a real column", async () => {
    // A renamed column takes care of itself: the new name is not in the
    // allowlist, so it is forbidden. What does not is the stale entry the
    // rename leaves behind — it widens the allowlist by one name that means
    // nothing today and would silently admit whatever column claims it next.
    const declared = new Set(Object.keys(getTableColumns(agentSessions)));
    expect(
      [...SESSION_COLUMNS_THE_LIST_SERVES].filter((name) => !declared.has(name))
    ).toEqual([]);

    const declaredConversation = new Set(
      Object.keys(getTableColumns(chatConversations))
    );
    expect(
      [...CONVERSATION_COLUMNS_THE_LIST_SERVES].filter(
        (name) => !declaredConversation.has(name)
      )
    ).toEqual([]);
  });

  it("keeps the unbounded columns outside the allowlist", async () => {
    // Guards the guard: the assertions above are only as strong as the
    // allowlist they subtract, and the cheapest way to make them pass is to
    // widen it. Doing that to any column with no write-side ceiling fails
    // here, by name.
    const forbidden = forbiddenColumns(
      agentSessions,
      SESSION_COLUMNS_THE_LIST_SERVES
    );

    for (const column of UNBOUNDED_SESSION_COLUMNS) {
      expect(
        Object.keys(getTableColumns(agentSessions)),
        `${column} is no longer a column of agent_sessions`
      ).toContain(column);
      expect(forbidden, `${column} must never be in the list projection`).toContain(
        column
      );
    }
  });

  it("keeps every response key accounted for", async () => {
    // The mirror image of the forbidden check: nothing reaches the client
    // that is neither an allowed column nor a documented derived key. A
    // heavy column re-entering under a new name lands here too.
    seedFullyPopulatedSession("sess-full", "2026-09-01 10:00:00");
    db.insert(chatConversations)
      .values({
        id: "conv-full",
        projectId: PROJECT_ID,
        label: "Conversation",
        createdAt: "2026-09-01 09:00:00",
      })
      .run();

    const { rows } = await list();
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      const allowed =
        row.kind === "agent_session"
          ? SESSION_COLUMNS_THE_LIST_SERVES
          : CONVERSATION_COLUMNS_THE_LIST_SERVES;
      const unexpected = Object.keys(row).filter(
        (key) => !allowed.has(key) && !DERIVED_RESPONSE_KEYS.has(key)
      );
      expect(unexpected, `unexpected keys on ${row.kind} ${row.id}`).toEqual([]);
    }
  });

  it("serves a chat message as a bounded preview, never in full", async () => {
    // The chat half has the same shape of column one table over:
    // `chat_messages.content` is uncapped, and the list paints one line of it.
    const huge = `${"m".repeat(4_000_000)}${sentinel("content")}`;
    db.insert(chatConversations)
      .values({
        id: "conv-huge",
        projectId: PROJECT_ID,
        label: "Conversation",
        createdAt: "2026-09-01 10:00:00",
      })
      .run();
    db.insert(chatMessages)
      .values({
        id: "msg-huge",
        projectId: PROJECT_ID,
        conversationId: "conv-huge",
        role: "assistant",
        content: huge,
        createdAt: "2026-09-01 10:01:00",
      })
      .run();

    const { rows, body } = await list();

    const conversation = rows.find((row) => row.kind === "chat_session")!;
    expect(
      (conversation.lastMessagePreview as string).length
    ).toBeLessThanOrEqual(120);
    expect(body).not.toContain(sentinel("content"));
    expect(Buffer.byteLength(body, "utf-8")).toBeLessThan(64 * 1024);
  });
});
