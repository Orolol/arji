/**
 * The Arij-actions list, and what reading it costs.
 *
 * The list has two halves. The durable half is three indexed, session-scoped
 * reads. The other half only exists in the provider's raw output, and finding
 * it used to mean `listSessionChunks(sessionId, "raw")` — one unbounded
 * SELECT — inside the session-detail handler. On the live database the
 * largest raw stream is 3,015 rows / 113.6 MB and replaying that SELECT takes
 * 276-287 ms before any JSON parsing, while the detail page polls this
 * handler every three seconds on the one shared synchronous connection. The
 * response was small; the stall was not.
 *
 * So these tests instrument the handler's ACTUAL chunk reads rather than
 * measuring the payload: a bounded response produced by an unbounded read is
 * exactly the bug that was missed the first time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: { cancel: vi.fn() },
}));
vi.mock("@/lib/agents/scheduler", () => ({
  agentScheduler: { remove: vi.fn() },
}));
vi.mock("@/lib/activity-registry", () => ({
  activityRegistry: { cancelInProject: vi.fn(() => false) },
}));
vi.mock("@/lib/agent-sessions/backfill", () => ({
  runBackfillRecentSessionLastNonEmptyTextOnce: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions, ticketComments } = await import(
  "@/lib/db/schema"
);
const chunks = await import("@/lib/agent-sessions/chunks");
const { appendSessionChunk } = chunks;
const { GET } = await import(
  "@/app/api/projects/[projectId]/sessions/[sessionId]/route"
);
const {
  scanArijToolCalls,
  resetArijToolCallScans,
  ARIJ_ACTION_SCAN_MAX_BYTES,
} = await import("@/lib/agent-sessions/arij-action-scan");
const { SESSION_DETAIL_PREVIEW_BYTES, SESSION_STREAM_TYPES } = await import(
  "@/lib/agent-sessions/session-detail"
);

const PROJECT = "proj-1";
const SESSION = "sess-1";

interface ActionItem {
  kind: string;
  summary: string;
}

function get(searchParams: Record<string, string> = {}) {
  return GET(
    mockNextRequest({ searchParams }),
    mockRouteContext({ projectId: PROJECT, sessionId: SESSION })
  );
}

function toolUseLine(id: string, tool: string): string {
  return `${JSON.stringify({
    type: "tool_use",
    id,
    name: `mcp__arij__${tool}`,
    input: {},
  })}\n`;
}

function seedRaw(contents: string[]): void {
  for (const content of contents) {
    appendSessionChunk({ sessionId: SESSION, streamType: "raw", content });
  }
}

/**
 * Counts the content the chunk store actually hands back, and whether anyone
 * asked for a whole stream. This is the measurement the response-size
 * assertions cannot make.
 */
function instrumentChunkReads() {
  const stats = { pageCalls: 0, charactersRead: 0, wholeStreamCalls: 0 };

  vi.spyOn(chunks, "listSessionChunkPage").mockImplementation(
    (sessionId, streamType, options) => {
      stats.pageCalls += 1;
      const page = actualListChunkPage(sessionId, streamType, options);
      for (const chunk of page.chunks) stats.charactersRead += chunk.content.length;
      return page;
    }
  );
  vi.spyOn(chunks, "listSessionChunks").mockImplementation(
    (sessionId, streamType) => {
      stats.wholeStreamCalls += 1;
      return actualListChunks(sessionId, streamType);
    }
  );

  return stats;
}

const actualListChunkPage = chunks.listSessionChunkPage;
const actualListChunks = chunks.listSessionChunks;

beforeEach(() => {
  vi.restoreAllMocks();
  resetArijToolCallScans();
  db.delete(ticketComments).run();
  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(projects).run();
  db.insert(projects).values({ id: PROJECT, name: "One" }).run();
  db.insert(epics)
    .values({ id: "epic-1", projectId: PROJECT, title: "Epic" })
    .run();
  db.insert(agentSessions)
    .values({
      id: SESSION,
      projectId: PROJECT,
      epicId: "epic-1",
      status: "completed",
      mode: "build",
      agentType: "build",
      provider: "codex",
    })
    .run();
});

describe("session detail payload", () => {
  it("never reads a whole stream, whatever the raw stream weighs", async () => {
    // 3 MB of raw output with a tool call buried at the end — the shape that
    // made every 3-second poll of this handler a full-stream read.
    seedRaw(Array.from({ length: 48 }, () => "x".repeat(64 * 1024)));
    seedRaw([toolUseLine("tu_1", "get_ticket")]);

    const stats = instrumentChunkReads();
    const json = await (await get()).json();

    expect(json.data.arijActions).toEqual([]);
    // The bug: the response was small and the read was not.
    expect(stats.wholeStreamCalls).toBe(0);
    // Three stream previews, each under its own byte budget, and nothing else.
    expect(stats.pageCalls).toBe(SESSION_STREAM_TYPES.length);
    expect(stats.charactersRead).toBeLessThanOrEqual(
      SESSION_STREAM_TYPES.length * SESSION_DETAIL_PREVIEW_BYTES
    );
  });

  it("still carries the durable half of the list", async () => {
    db.insert(ticketComments)
      .values({
        id: "c1",
        epicId: "epic-1",
        author: "agent",
        agentSessionId: SESSION,
        content: "**Question** which base branch?",
      })
      .run();

    const json = await (await get()).json();
    const actions = json.data.arijActions as ActionItem[];

    expect(actions.map((a) => a.kind)).toEqual(["question"]);
  });
});

describe("?view=arij-actions", () => {
  it("finds the chunk-derived calls, reading the stream in bounded pages", async () => {
    // Two 2 MB filler chunks so the scan cannot finish in one call, with the
    // tool call in the tail.
    seedRaw([
      `${"x".repeat(2 * 1024 * 1024)}\n`,
      `${"y".repeat(2 * 1024 * 1024)}\n`,
      toolUseLine("tu_1", "get_ticket"),
    ]);

    const stats = instrumentChunkReads();
    const perCall: number[] = [];
    let actions: ActionItem[] = [];

    for (let page = 0; page < 20; page++) {
      const before = stats.charactersRead;
      const json = await (await get({ view: "arij-actions" })).json();
      perCall.push(stats.charactersRead - before);
      actions = json.data.actions;
      if (!json.data.hasMore) break;
    }

    expect(actions.map((a) => a.summary)).toEqual([
      "Read ticket state (get_ticket)",
    ]);
    // It took more than one call — so the bound is doing something…
    expect(perCall.length).toBeGreaterThan(1);
    // …and no single call read more than the budget allows.
    for (const read of perCall) {
      expect(read).toBeLessThanOrEqual(ARIJ_ACTION_SCAN_MAX_BYTES);
    }
    expect(stats.wholeStreamCalls).toBe(0);
  });

  it("merges both halves, and does not double-count a call with an artifact", async () => {
    db.insert(ticketComments)
      .values({
        id: "c1",
        epicId: "epic-1",
        author: "agent",
        agentSessionId: SESSION,
        content: "Refactored the exporter.",
      })
      .run();
    seedRaw([
      toolUseLine("tu_1", "get_ticket"),
      toolUseLine("tu_2", "post_comment"),
    ]);

    const json = await (await get({ view: "arij-actions" })).json();
    const actions = json.data.actions as ActionItem[];

    // post_comment is covered by the comment row; get_ticket has no artifact.
    expect(actions.map((a) => a.summary).sort()).toEqual([
      "Posted a comment",
      "Read ticket state (get_ticket)",
    ]);
    expect(json.data.hasMore).toBe(false);
  });

  it("re-polls cheaply and picks up what the session appended since", async () => {
    seedRaw([toolUseLine("tu_1", "get_ticket")]);

    const first = await (await get({ view: "arij-actions" })).json();
    expect(first.data.actions).toHaveLength(1);

    // A poll against an unchanged stream must not re-read it.
    const stats = instrumentChunkReads();
    const second = await (await get({ view: "arij-actions" })).json();
    expect(second.data.actions).toHaveLength(1);
    expect(stats.charactersRead).toBe(0);

    // …and a call the session makes afterwards still shows up.
    seedRaw([toolUseLine("tu_2", "get_ticket")]);
    const third = await (await get({ view: "arij-actions" })).json();
    expect(third.data.actions).toHaveLength(2);
  });

  it("404s for a session belonging to another project", async () => {
    db.insert(projects).values({ id: "proj-2", name: "Two" }).run();
    const response = await GET(
      mockNextRequest({ searchParams: { view: "arij-actions" } }),
      mockRouteContext({ projectId: "proj-2", sessionId: SESSION })
    );
    expect(response.status).toBe(404);
  });

  it("keeps the durable half when the scan fails, and says so", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db.insert(ticketComments)
      .values({
        id: "c1",
        epicId: "epic-1",
        author: "agent",
        agentSessionId: SESSION,
        content: "Refactored the exporter.",
      })
      .run();
    vi.spyOn(chunks, "listSessionChunkPage").mockImplementation(() => {
      throw new Error("chunk table is damaged");
    });

    const json = await (await get({ view: "arij-actions" })).json();

    expect(json.data.arijActionsUnavailable).toBe(true);
    expect((json.data.actions as ActionItem[]).map((a) => a.kind)).toEqual([
      "comment",
    ]);
  });
});

describe("the scan itself", () => {
  it("reassembles a tool call split across two pages", async () => {
    // The reason the scan is stateful rather than "read N chunks and parse".
    // A page boundary lands in the middle of the JSON line, and a stateless
    // pass over each page would parse two halves and find nothing.
    const line = toolUseLine("tu_1", "submit_findings");
    const half = Math.floor(line.length / 2);
    seedRaw([line.slice(0, half), line.slice(half)]);

    // A budget small enough that each chunk is its own page.
    let result = scanArijToolCalls(SESSION, { maxBytes: 8, limit: 1 });
    expect(result.toolCalls).toEqual([]);
    expect(result.hasMore).toBe(true);

    for (let i = 0; i < 10 && result.hasMore; i++) {
      result = scanArijToolCalls(SESSION, { maxBytes: 8, limit: 1 });
    }

    expect(result.toolCalls.map((c) => c.tool)).toEqual(["submit_findings"]);
  });

  it("does not double-count a call parsed tentatively from an unterminated tail", async () => {
    // No trailing newline: the line is parsed as a snapshot each call, but is
    // never accumulated, so scanning again cannot report it twice.
    seedRaw([toolUseLine("tu_1", "get_ticket").trimEnd()]);

    expect(scanArijToolCalls(SESSION).toolCalls).toHaveLength(1);
    expect(scanArijToolCalls(SESSION).toolCalls).toHaveLength(1);

    // And once the line IS terminated by a later chunk, it stays one call.
    seedRaw(["\n"]);
    expect(scanArijToolCalls(SESSION).toolCalls).toHaveLength(1);
  });
});
