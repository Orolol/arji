/**
 * "Arij actions" — session-scoped structured board effects surfaced on the
 * session detail page.
 *
 * Covers the three layers:
 *   - extractArijToolCalls: mcp__arij__* tool_use parsing over raw chunks
 *     (cross-chunk line reassembly, id-dedupe, non-arij/junk filtering)
 *   - mergeArijActions: DB-artifact dedupe + "no recorded effect" surfacing
 *   - collectArijActions: real-migration in-memory DB round-trip over
 *     ticket_comments + ticket_activity_log
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import type { ArijDatabase } from "@/lib/db";
import {
  projects,
  epics,
  agentSessions,
  ticketComments,
} from "@/lib/db/schema";
import { logTransition } from "@/lib/workflow/log";
import { createId } from "@/lib/utils/nanoid";
import {
  extractArijToolCalls,
  mergeArijActions,
  collectArijActions,
  type ArijAction,
} from "@/lib/agent-sessions/arij-actions";

// ---------------------------------------------------------------------------
// extractArijToolCalls
// ---------------------------------------------------------------------------

describe("extractArijToolCalls", () => {
  it("extracts mcp__arij__* tool_use blocks from claude stream-json events", () => {
    const chunks = [
      {
        content:
          JSON.stringify({
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              id: "toolu_01",
              name: "mcp__arij__post_comment",
            },
          }) + "\n",
        createdAt: "2026-08-17T10:00:00.000Z",
      },
    ];
    expect(extractArijToolCalls(chunks)).toEqual([
      { tool: "post_comment", at: "2026-08-17T10:00:00.000Z" },
    ]);
  });

  it("dedupes the same tool_use id echoed across events, keeps distinct calls", () => {
    const start = JSON.stringify({
      type: "content_block_start",
      content_block: {
        type: "tool_use",
        id: "toolu_A",
        name: "mcp__arij__ask_question",
      },
    });
    const assistantEcho = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_A",
            name: "mcp__arij__ask_question",
            input: { question: "Which DB?" },
          },
          {
            type: "tool_use",
            id: "toolu_B",
            name: "mcp__arij__get_ticket",
            input: {},
          },
        ],
      },
    });
    const calls = extractArijToolCalls([
      { content: `${start}\n${assistantEcho}\n`, createdAt: "t1" },
    ]);
    expect(calls.map((c) => c.tool)).toEqual(["ask_question", "get_ticket"]);
  });

  it("reassembles a JSON line split across chunk boundaries", () => {
    const line = JSON.stringify({
      type: "tool_use",
      id: "toolu_split",
      name: "mcp__arij__update_ticket_status",
      input: { status: "review" },
    });
    const cut = Math.floor(line.length / 2);
    const calls = extractArijToolCalls([
      { content: line.slice(0, cut), createdAt: "t-early" },
      { content: line.slice(cut) + "\n", createdAt: "t-late" },
    ]);
    // Timestamp comes from the chunk that completed the line.
    expect(calls).toEqual([{ tool: "update_ticket_status", at: "t-late" }]);
  });

  it("supports codex-style records ({ server: 'arij', tool })", () => {
    const chunks = [
      {
        content:
          JSON.stringify({
            type: "item.completed",
            item: { type: "mcp_tool_call", server: "arij", tool: "get_ticket" },
          }) + "\n",
        createdAt: "t-codex",
      },
    ];
    expect(extractArijToolCalls(chunks)).toEqual([
      { tool: "get_ticket", at: "t-codex" },
    ]);
  });

  it("supports omp xd:// device records, deduping start/end/echo of one call", () => {
    // Shapes captured verbatim from a live omp 17.2.1 session's raw chunks:
    // one MCP call = a tool_execution_start (write to the xd:// device), an
    // assistant toolCall echo, and a tool_execution_end whose result embeds
    // { serverName, mcpToolName } — all sharing one call id.
    const id = "89ba21e6|fc_tmp_fazrfghprin";
    const start = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "write",
      args: { content: '{"action": "get_ticket"}', path: "xd://mcp__arij_get_ticket" },
      intent: "Reading Arij ticket details",
    });
    const echo = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: {
          type: "toolCall",
          id,
          name: "write",
          arguments: { path: "xd://mcp__arij_get_ticket" },
        },
      },
    });
    const end = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "write",
      result: {
        content: [{ type: "text", text: "Error: Error (UNAUTHORIZED): Invalid or expired MCP token" }],
        details: {
          xdev: {
            tool: "mcp__arij_get_ticket",
            mode: "execute",
            args: {},
            inner: { serverName: "arij", mcpToolName: "get_ticket", isError: true },
          },
        },
        isError: true,
      },
    });
    const calls = extractArijToolCalls([
      { content: `${start}\n${echo}\n${end}\n`, createdAt: "t-omp" },
    ]);
    expect(calls).toEqual([{ tool: "get_ticket", at: "t-omp" }]);
  });

  it("keeps distinct omp calls (different call ids) as separate entries", () => {
    const call = (id: string, tool: string) =>
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: "write",
        args: { path: `xd://mcp__arij_${tool}` },
      });
    const calls = extractArijToolCalls([
      {
        content: `${call("c1", "get_ticket")}\n${call("c2", "post_comment")}\n`,
        createdAt: "t-omp",
      },
    ]);
    expect(calls.map((c) => c.tool)).toEqual(["get_ticket", "post_comment"]);
  });

  it("ignores omp writes to non-arij xd:// devices and plain paths", () => {
    const chunks = [
      {
        content:
          JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "c3",
            toolName: "write",
            args: { path: "xd://mcp__other_get_thing" },
          }) +
          "\n" +
          JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "c4",
            toolName: "write",
            args: { path: "/tmp/notes.md", content: "hello" },
          }) +
          "\n",
        createdAt: "t-omp",
      },
    ];
    expect(extractArijToolCalls(chunks)).toEqual([]);
  });

  it("ignores non-arij tools, other servers, and non-JSON output", () => {
    const chunks = [
      { content: "Working on it... using mcp__arij__post_comment soon\n", createdAt: "t1" },
      {
        content:
          JSON.stringify({ type: "tool_use", id: "x", name: "Bash" }) + "\n",
        createdAt: "t2",
      },
      {
        content:
          JSON.stringify({ server: "github", tool: "create_pr" }) + "\n",
        createdAt: "t3",
      },
      { content: "{ not json at all\n", createdAt: "t4" },
    ];
    expect(extractArijToolCalls(chunks)).toEqual([]);
  });

  it("parses a trailing line without a final newline", () => {
    const calls = extractArijToolCalls([
      {
        content: JSON.stringify({
          type: "tool_use",
          name: "mcp__arij__submit_findings",
        }),
        createdAt: "t-end",
      },
    ]);
    expect(calls).toEqual([{ tool: "submit_findings", at: "t-end" }]);
  });
});

// ---------------------------------------------------------------------------
// mergeArijActions
// ---------------------------------------------------------------------------

describe("mergeArijActions", () => {
  const commentAction: ArijAction = {
    kind: "comment",
    summary: "Posted a comment",
    detail: "Done.",
    at: "2026-08-17T10:05:00.000Z",
  };

  it("always includes read-only get_ticket calls", () => {
    const merged = mergeArijActions(
      [commentAction],
      [{ tool: "get_ticket", at: "2026-08-17T10:01:00.000Z" }]
    );
    expect(merged.map((a) => a.kind)).toEqual(["tool_call", "comment"]);
    expect(merged[0].summary).toBe("Read ticket state (get_ticket)");
  });

  it("drops effectful calls already covered by a durable artifact of the same kind", () => {
    const merged = mergeArijActions(
      [commentAction],
      [{ tool: "post_comment", at: "2026-08-17T10:05:00.000Z" }]
    );
    expect(merged).toEqual([commentAction]);
  });

  it("surfaces uncovered effectful calls as 'no recorded effect'", () => {
    const merged = mergeArijActions(
      [],
      [{ tool: "update_ticket_status", at: "2026-08-17T10:02:00.000Z" }]
    );
    expect(merged).toEqual([
      {
        kind: "tool_call",
        summary: "Called update_ticket_status (no recorded effect)",
        at: "2026-08-17T10:02:00.000Z",
      },
    ]);
  });

  it("sorts chronologically with null timestamps last", () => {
    const merged = mergeArijActions(
      [
        { kind: "status_change", summary: "b", at: "2026-08-17T10:10:00.000Z" },
        { kind: "question", summary: "c", at: null },
      ],
      [{ tool: "get_ticket", at: "2026-08-17T10:00:00.000Z" }]
    );
    expect(merged.map((a) => a.summary)).toEqual([
      "Read ticket state (get_ticket)",
      "b",
      "c",
    ]);
  });
});

// ---------------------------------------------------------------------------
// collectArijActions — real in-memory DB round-trip
// ---------------------------------------------------------------------------

describe("collectArijActions", () => {
  let db: ArijDatabase;
  let projectId: string;
  let epicId: string;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb().db;
    projectId = createId();
    epicId = createId();
    sessionId = createId();
    const now = new Date().toISOString();

    db.insert(projects)
      .values({ id: projectId, name: "P", createdAt: now, updatedAt: now })
      .run();
    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "E",
        status: "in_progress",
        position: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(agentSessions).values({ id: sessionId, projectId, epicId }).run();
  });

  function insertAgentComment(content: string, createdAt: string): void {
    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId,
        author: "agent",
        content,
        agentSessionId: sessionId,
        createdAt,
      })
      .run();
  }

  it("maps agent comments, questions and findings summaries to typed actions", () => {
    insertAgentComment(
      "Implemented the schema change.",
      "2026-08-17T10:00:00.000Z"
    );
    insertAgentComment(
      "**Question**\n\nShould I migrate the legacy rows too?",
      "2026-08-17T10:01:00.000Z"
    );
    insertAgentComment(
      "**Review findings (changes requested)**\n\nTwo critical issues found.",
      "2026-08-17T10:02:00.000Z"
    );

    const actions = collectArijActions({ sessionId, database: db, chunks: [] });

    expect(actions.map((a) => a.kind)).toEqual([
      "comment",
      "question",
      "findings",
    ]);
    expect(actions[0].detail).toBe("Implemented the schema change.");
    expect(actions[1].summary).toBe("Asked the user a question");
    expect(actions[1].detail).toBe("Should I migrate the legacy rows too?");
    expect(actions[2].summary).toBe(
      "Submitted review findings (changes requested)"
    );
    expect(actions[2].detail).toBe("Two critical issues found.");
  });

  it("includes this session's agent status changes and skips held (from == to) entries", () => {
    logTransition({
      database: db,
      projectId,
      epicId,
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      reason: "Agent MCP: update_ticket_status",
      sessionId,
    });
    // Held-ticket log entry (asked_question): from == to, actor system.
    logTransition({
      database: db,
      projectId,
      epicId,
      fromStatus: "in_progress",
      toStatus: "in_progress",
      actor: "system",
      reason: "Agent asked a question",
      sessionId,
    });

    const actions = collectArijActions({ sessionId, database: db, chunks: [] });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "status_change",
      summary: "Ticket moved in_progress → review",
      detail: "Agent MCP: update_ticket_status",
    });
  });

  it("ignores artifacts from other sessions and user comments", () => {
    const otherSession = createId();
    db.insert(agentSessions)
      .values({ id: otherSession, projectId, epicId })
      .run();
    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId,
        author: "agent",
        content: "Other session's note",
        agentSessionId: otherSession,
        createdAt: new Date().toISOString(),
      })
      .run();
    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId,
        author: "user",
        content: "A user reply",
        agentSessionId: sessionId,
        createdAt: new Date().toISOString(),
      })
      .run();
    logTransition({
      database: db,
      projectId,
      epicId,
      fromStatus: "todo",
      toStatus: "in_progress",
      actor: "agent",
      sessionId: otherSession,
    });

    expect(
      collectArijActions({ sessionId, database: db, chunks: [] })
    ).toEqual([]);
  });

  it("merges chunk-derived tool calls with DB artifacts (full round-trip)", () => {
    insertAgentComment("Progress update.", "2026-08-17T10:05:00.000Z");
    const chunks = [
      {
        content:
          [
            JSON.stringify({
              type: "tool_use",
              id: "t1",
              name: "mcp__arij__get_ticket",
            }),
            JSON.stringify({
              type: "tool_use",
              id: "t2",
              name: "mcp__arij__post_comment",
            }),
            JSON.stringify({
              type: "tool_use",
              id: "t3",
              name: "mcp__arij__update_ticket_status",
            }),
          ].join("\n") + "\n",
        createdAt: "2026-08-17T10:04:00.000Z",
      },
    ];

    const actions = collectArijActions({ sessionId, database: db, chunks });

    expect(actions.map((a) => a.summary)).toEqual([
      "Read ticket state (get_ticket)",
      // update_ticket_status left no activity-log row -> rejected/no effect
      "Called update_ticket_status (no recorded effect)",
      "Posted a comment",
      // post_comment is covered by its ticket_comments artifact (no dupe)
    ]);
  });
});
