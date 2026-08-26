/**
 * Tests for the /api/mcp/* routes (the HTTP backend of the agent tool
 * channel).
 *
 * Real handlers against an isolated in-memory database built from the real
 * migration chain (createTestDb), with real tokens from the MCP token store.
 * Focus areas per route: happy path, auth failures (401 for missing, bogus,
 * and revoked tokens alike), and scope enforcement — the token, never the
 * body, decides which project can be written to.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createTestDb } from "@/lib/db/test-utils";
import { mockNextRequest } from "@/__tests__/helpers/db-mock";
import {
  agentSessions,
  epics,
  gradingReports,
  projects,
  reviewComments,
  sessionArtifacts,
  ticketActivityLog,
  ticketComments,
  userStories,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import {
  _resetMcpTokenStoreForTests,
  mintMcpToken,
  revokeMcpTokensForSession,
  wasQuestionAskedViaMcp,
} from "@/lib/mcp/token-store";
import { eq, ne } from "drizzle-orm";
import { eventBus, type TicketEvent } from "@/lib/events/bus";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<
    typeof import("@/lib/db/test-utils").createTestDb
  > | null,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.db;
  },
  get sqlite() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.sqlite;
  },
}));

// ---- Import route handlers AFTER mocks ----
import { POST as getTicketPost } from "@/app/api/mcp/get-ticket/route";
import { POST as updateStatusPost } from "@/app/api/mcp/update-ticket-status/route";
import { POST as postCommentPost } from "@/app/api/mcp/post-comment/route";
import { POST as attachArtifactPost } from "@/app/api/mcp/attach-artifact/route";
import { POST as askQuestionPost } from "@/app/api/mcp/ask-question/route";
import { POST as submitFindingsPost } from "@/app/api/mcp/submit-findings/route";
import { POST as submitGradingPost } from "@/app/api/mcp/submit-grading/route";

type RouteHandler = (request: NextRequest) => Promise<Response>;

let projectId: string;
let otherProjectId: string;
let epicId: string; // in_progress, bound to the main token
let todoEpicId: string; // todo, same project
let reviewEpicId: string; // review, same project (has a completed review)
let otherProjectEpicId: string; // lives in the OTHER project
let sessionId: string;
let noEpicSessionId: string;
let token: string;
let noEpicToken: string;

function call(handler: RouteHandler, body: unknown, bearer?: string) {
  return handler(
    mockNextRequest({
      url: "http://localhost:3000/api/mcp/test",
      body,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
    })
  );
}

function db() {
  return testDb.instance!.db;
}

beforeEach(() => {
  testDb.instance = createTestDb();
  _resetMcpTokenStoreForTests();

  projectId = createId();
  otherProjectId = createId();
  epicId = createId();
  todoEpicId = createId();
  reviewEpicId = createId();
  otherProjectEpicId = createId();
  sessionId = createId();
  noEpicSessionId = createId();

  const now = new Date().toISOString();

  db()
    .insert(projects)
    .values([
      { id: projectId, name: "Main", createdAt: now, updatedAt: now },
      { id: otherProjectId, name: "Other", createdAt: now, updatedAt: now },
    ])
    .run();

  db()
    .insert(epics)
    .values([
      {
        id: epicId,
        projectId,
        title: "Main epic",
        description: "The epic under work",
        status: "in_progress",
        type: "feature",
        branchName: "feat/main-epic",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: todoEpicId,
        projectId,
        title: "Todo epic",
        status: "todo",
        position: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: reviewEpicId,
        projectId,
        title: "Review epic",
        status: "review",
        position: 2,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherProjectEpicId,
        projectId: otherProjectId,
        title: "Foreign epic",
        status: "todo",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();

  db()
    .insert(agentSessions)
    .values([
      {
        id: sessionId,
        projectId,
        epicId,
        status: "running",
        agentType: "developer",
        createdAt: now,
      },
      {
        id: noEpicSessionId,
        projectId,
        status: "running",
        agentType: "developer",
        createdAt: now,
      },
      // Completed review on the review epic, so review→done rejections come
      // from the approval guard, not the missing-review guard.
      {
        id: createId(),
        projectId,
        epicId: reviewEpicId,
        status: "completed",
        agentType: "code_reviewer",
        createdAt: now,
      },
    ])
    .run();

  token = mintMcpToken({
    sessionId,
    projectId,
    epicId,
    agentType: "developer",
  });
  noEpicToken = mintMcpToken({ sessionId: noEpicSessionId, projectId });
});

// ---------------------------------------------------------------------------
// Auth — every route behaves identically
// ---------------------------------------------------------------------------

describe("MCP route auth", () => {
  const routes: Array<[string, RouteHandler, unknown]> = [
    ["get-ticket", getTicketPost, {}],
    ["update-ticket-status", updateStatusPost, { status: "review" }],
    ["post-comment", postCommentPost, { body: "hello" }],
    [
      "attach-artifact",
      attachArtifactPost,
      { path: "proof.png", caption: "Visual proof" },
    ],
    ["ask-question", askQuestionPost, { question: "which db?" }],
    [
      "submit-findings",
      submitFindingsPost,
      { verdict: "approved", summary: "ok", findings: [] },
    ],
    [
      "submit-grading",
      submitGradingPost,
      {
        gradings: [
          {
            storyId: "story-id",
            criterion: "It works",
            status: "met",
            evidence: "Covered by a test",
          },
        ],
        summary: "ok",
      },
    ],
  ];

  it.each(routes)("%s → 401 without an Authorization header", async (_name, handler, body) => {
    const res = await call(handler, body);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toEqual({
      error: "Invalid or expired MCP token",
      code: "UNAUTHORIZED",
    });
  });

  it.each(routes)("%s → 401 with an unknown token", async (_name, handler, body) => {
    const res = await call(handler, body, "arij-mcp-not-a-real-token");
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.code).toBe("UNAUTHORIZED");
  });

  it.each(routes)("%s → 401 with a revoked token", async (_name, handler, body) => {
    revokeMcpTokensForSession(sessionId);

    const res = await call(handler, body, token);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// attach-artifact
// ---------------------------------------------------------------------------

describe("POST /api/mcp/attach-artifact", () => {
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  function createWorktreeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "arij-mcp-artifact-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    db()
      .update(agentSessions)
      .set({ worktreePath: worktree })
      .where(eq(agentSessions.id, sessionId))
      .run();
    return { root, worktree };
  }

  it("copies the file before returning and records an agent-readable artifact", async () => {
    const { root, worktree } = createWorktreeFixture();
    const source = path.join(worktree, "proof.png");
    const durableSessionDir = path.join(
      process.cwd(),
      "data",
      "sessions",
      sessionId
    );
    fs.writeFileSync(source, Buffer.concat([pngHeader, Buffer.from("proof")]));

    try {
      const res = await call(
        attachArtifactPost,
        { path: "proof.png", caption: "Feature rendered successfully" },
        token
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.artifact).toMatchObject({
        agentSessionId: sessionId,
        epicId,
        caption: "Feature rendered successfully",
      });
      const row = db()
        .select()
        .from(sessionArtifacts)
        .where(eq(sessionArtifacts.agentSessionId, sessionId))
        .get();
      expect(row).toEqual(json.data.artifact);

      const durableFile = path.join(
        durableSessionDir,
        "artifacts",
        row!.filename
      );
      fs.rmSync(worktree, { recursive: true });
      expect(fs.readFileSync(durableFile)).toEqual(
        Buffer.concat([pngHeader, Buffer.from("proof")])
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(durableSessionDir, { recursive: true, force: true });
    }
  });

  it("emits a project-scoped SSE event after the durable artifact is registered", async () => {
    const { root, worktree } = createWorktreeFixture();
    const source = path.join(worktree, "proof.png");
    const durableSessionDir = path.join(
      process.cwd(),
      "data",
      "sessions",
      sessionId
    );
    const events: TicketEvent[] = [];
    const unsubscribe = eventBus.subscribe(projectId, (event) =>
      events.push(event)
    );
    fs.writeFileSync(source, pngHeader);

    try {
      const res = await call(
        attachArtifactPost,
        { path: "proof.png", caption: "Feature rendered successfully" },
        token
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "artifact:created",
          projectId,
          epicId,
          data: {
            sessionId,
            artifactId: json.data.artifact.id,
          },
        })
      );
    } finally {
      unsubscribe();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(durableSessionDir, { recursive: true, force: true });
    }
  });

  it("returns a readable coded error for traversal without copying", async () => {
    const { root } = createWorktreeFixture();
    const outside = path.join(root, "outside.png");
    const durableSessionDir = path.join(
      process.cwd(),
      "data",
      "sessions",
      sessionId
    );
    fs.writeFileSync(outside, pngHeader);

    try {
      const res = await call(
        attachArtifactPost,
        { path: "../outside.png", caption: "Should not attach" },
        token
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe("PATH_OUTSIDE_WORKTREE");
      expect(json.error).toContain("inside this session's worktree");
      expect(
        db()
          .select()
          .from(sessionArtifacts)
          .where(eq(sessionArtifacts.agentSessionId, sessionId))
          .all()
      ).toHaveLength(0);
      expect(fs.existsSync(durableSessionDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(durableSessionDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// get-ticket
// ---------------------------------------------------------------------------

describe("POST /api/mcp/get-ticket", () => {
  it("returns the token's ticket with stories, comments, and findings", async () => {
    const now = new Date().toISOString();
    db()
      .insert(userStories)
      .values({
        id: createId(),
        epicId,
        title: "Story A",
        description: "Do the thing",
        acceptanceCriteria: "It works",
        status: "todo",
        position: 0,
        createdAt: now,
      })
      .run();
    db()
      .insert(ticketComments)
      .values({
        id: createId(),
        epicId,
        author: "user",
        content: "Please also handle X",
        createdAt: now,
      })
      .run();
    db()
      .insert(reviewComments)
      .values({
        id: createId(),
        epicId,
        filePath: "lib/a.ts",
        lineNumber: 42,
        body: "[major] Missing null check",
        author: "agent",
        status: "open",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await call(getTicketPost, {}, token);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.ticket).toEqual({
      id: epicId,
      title: "Main epic",
      description: "The epic under work",
      status: "in_progress",
      type: "feature",
      branchName: "feat/main-epic",
    });
    expect(json.data.userStories).toEqual([
      {
        id: expect.any(String),
        title: "Story A",
        description: "Do the thing",
        status: "todo",
        acceptanceCriteria: "It works",
      },
    ]);
    expect(json.data.comments).toEqual([
      { author: "user", content: "Please also handle X", createdAt: now },
    ]);
    expect(json.data.reviewFindings).toEqual([
      {
        id: expect.any(String),
        filePath: "lib/a.ts",
        lineNumber: 42,
        body: "[major] Missing null check",
        severityNote: null,
        status: "open",
        author: "agent",
      },
    ]);
  });

  it("targets another ticket of the same project via ticket_id", async () => {
    const res = await call(getTicketPost, { ticket_id: todoEpicId }, token);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.ticket.id).toBe(todoEpicId);
    expect(json.data.ticket.status).toBe("todo");
  });

  it("404s for a ticket_id belonging to another project", async () => {
    const res = await call(
      getTicketPost,
      { ticket_id: otherProjectEpicId },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.code).toBe("TICKET_NOT_FOUND");
  });

  it("404s for an unknown ticket_id", async () => {
    const res = await call(getTicketPost, { ticket_id: "nope" }, token);

    expect(res.status).toBe(404);
  });

  it("400s MISSING_TICKET for a ticketless session without ticket_id", async () => {
    const res = await call(getTicketPost, {}, noEpicToken);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("MISSING_TICKET");
  });

  it("400s on unknown body keys (strict schema)", async () => {
    const res = await call(getTicketPost, { ticketId: epicId }, token);

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// update-ticket-status
// ---------------------------------------------------------------------------

describe("POST /api/mcp/update-ticket-status", () => {
  it("applies a valid transition and logs it as agent actor", async () => {
    const res = await call(
      updateStatusPost,
      { status: "in_progress", ticket_id: todoEpicId },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      ticketId: todoEpicId,
      fromStatus: "todo",
      toStatus: "in_progress",
    });

    const epic = db()
      .select()
      .from(epics)
      .where(eq(epics.id, todoEpicId))
      .get();
    expect(epic?.status).toBe("in_progress");

    const logs = db()
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, todoEpicId))
      .all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      fromStatus: "todo",
      toStatus: "in_progress",
      actor: "agent",
      sessionId,
      reason: "Agent MCP: update_ticket_status",
    });
  });

  it("records a custom reason", async () => {
    await call(
      updateStatusPost,
      {
        status: "in_progress",
        ticket_id: todoEpicId,
        reason: "Implementation started",
      },
      token
    );

    const logs = db()
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, todoEpicId))
      .all();
    expect(logs[0]?.reason).toBe("Implementation started");
  });

  it("lets the owning build session move its own in-progress ticket to review", async () => {
    // The session calling the tool is the build session that owns the
    // ticket — the lock protects against CONCURRENT movers, not the owner.
    db()
      .update(agentSessions)
      .set({ agentType: "build" })
      .where(eq(agentSessions.id, sessionId))
      .run();

    const res = await call(updateStatusPost, { status: "review" }, token);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      ticketId: epicId,
      fromStatus: "in_progress",
      toStatus: "review",
    });

    const epic = db()
      .select()
      .from(epics)
      .where(eq(epics.id, epicId))
      .get();
    expect(epic?.status).toBe("review");

    const logs = db()
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      sessionId,
    });
  });

  it("refuses a move by a different session while a build owns the ticket", async () => {
    // The main session is a live build on epicId; a second, non-owning
    // session must stay locked out of the in-progress ticket.
    db()
      .update(agentSessions)
      .set({ agentType: "build" })
      .where(eq(agentSessions.id, sessionId))
      .run();

    const res = await call(
      updateStatusPost,
      { status: "review", ticket_id: epicId },
      noEpicToken
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("INVALID_TRANSITION");
    expect(json.error).toContain("session is queued or running");

    const epic = db()
      .select()
      .from(epics)
      .where(eq(epics.id, epicId))
      .get();
    expect(epic?.status).toBe("in_progress");

    const logs = db()
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      fromStatus: "in_progress",
      toStatus: "in_progress",
      actor: "agent",
      sessionId: noEpicSessionId,
    });
    expect(logs[0].reason).toContain(
      "Transition in_progress → review refused"
    );
  });

  it("refuses the owning session's move while a second build is also live", async () => {
    // Two concurrent code-producing sessions: neither is the sole owner, so
    // the ticket stays locked until one of them settles.
    db()
      .update(agentSessions)
      .set({ agentType: "build" })
      .where(eq(agentSessions.id, sessionId))
      .run();
    db()
      .insert(agentSessions)
      .values({
        id: createId(),
        projectId,
        epicId,
        status: "running",
        agentType: "ticket_build",
        createdAt: new Date().toISOString(),
      })
      .run();

    const res = await call(updateStatusPost, { status: "review" }, token);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("INVALID_TRANSITION");

    const epic = db()
      .select()
      .from(epics)
      .where(eq(epics.id, epicId))
      .get();
    expect(epic?.status).toBe("in_progress");
  });

  it("treats same-status as a no-op (no log entry)", async () => {
    const res = await call(updateStatusPost, { status: "in_progress" }, token);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      ticketId: epicId,
      fromStatus: "in_progress",
      toStatus: "in_progress",
    });
    const logs = db()
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(logs).toHaveLength(0);
  });

  it("409s review→done — approval stays human even with a completed review", async () => {
    const res = await call(
      updateStatusPost,
      { status: "done", ticket_id: reviewEpicId },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("INVALID_TRANSITION");
    expect(json.error).toContain("approval");

    const epic = db()
      .select()
      .from(epics)
      .where(eq(epics.id, reviewEpicId))
      .get();
    expect(epic?.status).toBe("review");
  });

  it("409s structurally invalid transitions (todo→done)", async () => {
    const res = await call(
      updateStatusPost,
      { status: "done", ticket_id: todoEpicId },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("INVALID_TRANSITION");

    const epic = db()
      .select()
      .from(epics)
      .where(eq(epics.id, todoEpicId))
      .get();
    expect(epic?.status).toBe("todo");
  });

  it("rejects 'released' at validation (system-only status)", async () => {
    const res = await call(updateStatusPost, { status: "released" }, token);

    expect(res.status).toBe(400);
  });

  it("404s and does not move tickets from another project", async () => {
    const res = await call(
      updateStatusPost,
      { status: "in_progress", ticket_id: otherProjectEpicId },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.code).toBe("TICKET_NOT_FOUND");

    const epic = db()
      .select()
      .from(epics)
      .where(eq(epics.id, otherProjectEpicId))
      .get();
    expect(epic?.status).toBe("todo");
  });

  it("400s MISSING_TICKET for a ticket-less team_build session", async () => {
    // Team builds are dispatched ticket-less: the session row has no epicId,
    // so the token carries none and the route cannot address a ticket at
    // all — the move the prompt no longer promises team_build.
    const teamSessionId = createId();
    db()
      .insert(agentSessions)
      .values({
        id: teamSessionId,
        projectId,
        status: "running",
        agentType: "team_build",
        createdAt: new Date().toISOString(),
      })
      .run();
    const teamToken = mintMcpToken({
      sessionId: teamSessionId,
      projectId,
      agentType: "team_build",
    });

    const res = await call(updateStatusPost, { status: "review" }, teamToken);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("MISSING_TICKET");

    // Nothing moved.
    expect(
      db().select().from(epics).where(eq(epics.id, epicId)).get()?.status
    ).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// update-ticket-status — story-scoped sessions
//
// A ticket_build session's own ticket is its story. The default target must
// be the story (story-scoped context), and the parent epic must stay subject
// to the sibling-story rule that transitionBuildCompleted enforces — the
// in_progress lock used to be the only thing keeping that bypass unreachable.
// ---------------------------------------------------------------------------

describe("POST /api/mcp/update-ticket-status — story-scoped sessions", () => {
  let storyId1: string; // in_progress, the session's own story
  let storyId2: string; // todo, the sibling
  let storySessionId: string;
  let storyToken: string;

  beforeEach(() => {
    const now = new Date().toISOString();
    storyId1 = createId();
    storyId2 = createId();
    db()
      .insert(userStories)
      .values([
        {
          id: storyId1,
          epicId,
          title: "Story one",
          description: "The built story",
          status: "in_progress",
          position: 0,
          createdAt: now,
        },
        {
          id: storyId2,
          epicId,
          title: "Story two",
          description: "The sibling story",
          status: "todo",
          position: 1,
          createdAt: now,
        },
      ])
      .run();
    storySessionId = createId();
    db()
      .insert(agentSessions)
      .values({
        id: storySessionId,
        projectId,
        epicId,
        userStoryId: storyId1,
        status: "running",
        agentType: "ticket_build",
        createdAt: new Date().toISOString(),
      })
      .run();
    storyToken = mintMcpToken({
      sessionId: storySessionId,
      projectId,
      epicId,
      userStoryId: storyId1,
      agentType: "ticket_build",
    });
  });

  function storyStatus(storyId: string) {
    return db()
      .select()
      .from(userStories)
      .where(eq(userStories.id, storyId))
      .get()?.status;
  }

  it("lets the story build move its own story to review, holding the epic", async () => {
    const res = await call(updateStatusPost, { status: "review" }, storyToken);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      ticketId: storyId1,
      fromStatus: "in_progress",
      toStatus: "review",
    });

    // The story moved; the epic stays in_progress while its sibling story
    // is still todo — epic promotion belongs to the terminal handler.
    expect(storyStatus(storyId1)).toBe("review");
    expect(storyStatus(storyId2)).toBe("todo");
    expect(
      db().select().from(epics).where(eq(epics.id, epicId)).get()?.status
    ).toBe("in_progress");

    // The story move is audited on the epic's activity feed.
    const logs = db()
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      sessionId: storySessionId,
    });
    expect(logs[0].reason).toContain(storyId1);
  });

  it("refuses the story build moving its parent epic while its build is live", async () => {
    // Explicit ticket_id targets the epic (epic-scoped context); a
    // story-scoped session never grants the owning-session exemption there.
    const res = await call(
      updateStatusPost,
      { status: "review", ticket_id: epicId },
      storyToken
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("INVALID_TRANSITION");
    // The refusal names the scope rule, not a phantom concurrent session —
    // there is no "another agent session" here.
    expect(json.error).toContain("may only move its own story");
    expect(json.error).not.toContain("another agent session");
    expect(storyStatus(storyId1)).toBe("in_progress");
    expect(
      db().select().from(epics).where(eq(epics.id, epicId)).get()?.status
    ).toBe("in_progress");
  });

  it("refuses Backlog for a story target (stories have no backlog column)", async () => {
    const res = await call(updateStatusPost, { status: "backlog" }, storyToken);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("INVALID_TRANSITION");
    expect(json.error).toContain("Backlog");
    expect(storyStatus(storyId1)).toBe("in_progress");
  });

  it("404s when the story build echoes the returned story id back as ticket_id", async () => {
    // Pins the current ticket_id contract: the story branch returns the
    // story id it moved, but resolveTicketForToken resolves epics only —
    // an agent echoing that id into either tool's ticket_id gets a clean
    // 404, not a silent mis-target. If the routes ever converge on story
    // ids, flip this expectation.
    const res = await call(
      updateStatusPost,
      { status: "review", ticket_id: storyId1 },
      storyToken
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.code).toBe("TICKET_NOT_FOUND");
    expect(storyStatus(storyId1)).toBe("in_progress");
  });

  it("refuses a second live build on the same story from moving it", async () => {
    // Two concurrent story builds: neither is the sole owner, so the story
    // stays locked until one of them settles.
    const secondStorySessionId = createId();
    db()
      .insert(agentSessions)
      .values({
        id: secondStorySessionId,
        projectId,
        epicId,
        userStoryId: storyId1,
        status: "running",
        agentType: "ticket_build",
        createdAt: new Date().toISOString(),
      })
      .run();
    const secondStoryToken = mintMcpToken({
      sessionId: secondStorySessionId,
      projectId,
      epicId,
      userStoryId: storyId1,
      agentType: "ticket_build",
    });

    const res = await call(
      updateStatusPost,
      { status: "review" },
      secondStoryToken
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("INVALID_TRANSITION");
    expect(storyStatus(storyId1)).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// post-comment
// ---------------------------------------------------------------------------

describe("POST /api/mcp/post-comment", () => {
  it("inserts an agent comment linked to the calling session", async () => {
    const res = await call(postCommentPost, { body: "Progress: done with the parser" }, token);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.commentId).toEqual(expect.any(String));

    const rows = db()
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: json.data.commentId,
      author: "agent",
      content: "Progress: done with the parser",
      agentSessionId: sessionId,
    });
  });

  it("skips mention validation (agent text with @word must not bounce)", async () => {
    const res = await call(
      postCommentPost,
      { body: "See @does-not-exist.md for details" },
      token
    );

    expect(res.status).toBe(200);
  });

  it("posts to another same-project ticket via ticket_id", async () => {
    const res = await call(
      postCommentPost,
      { body: "cross-ticket note", ticket_id: todoEpicId },
      token
    );

    expect(res.status).toBe(200);
    const rows = db()
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, todoEpicId))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("404s for another project's ticket and writes nothing", async () => {
    const res = await call(
      postCommentPost,
      { body: "should not land", ticket_id: otherProjectEpicId },
      token
    );

    expect(res.status).toBe(404);
    expect(db().select().from(ticketComments).all()).toHaveLength(0);
  });

  it("400s on an empty body", async () => {
    const res = await call(postCommentPost, { body: "" }, token);
    expect(res.status).toBe(400);
  });

  it("400s past the 8000-char cap", async () => {
    const res = await call(postCommentPost, { body: "x".repeat(8001) }, token);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// ask-question
// ---------------------------------------------------------------------------

describe("POST /api/mcp/ask-question", () => {
  it("marks the session, posts a **Question** comment, and acknowledges the hold", async () => {
    expect(wasQuestionAskedViaMcp(sessionId)).toBe(false);

    const res = await call(
      askQuestionPost,
      { question: "Should I use SQLite or Postgres for this?" },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ acknowledged: true, holds_ticket: true });
    expect(wasQuestionAskedViaMcp(sessionId)).toBe(true);

    const rows = db()
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      author: "agent",
      content: "**Question**\n\nShould I use SQLite or Postgres for this?",
      agentSessionId: sessionId,
    });
  });

  it("keeps the flag readable after the session's tokens are revoked", async () => {
    await call(askQuestionPost, { question: "blocked on schema?" }, token);

    revokeMcpTokensForSession(sessionId);

    // This is the ordering the outcome classifier depends on.
    expect(wasQuestionAskedViaMcp(sessionId)).toBe(true);
  });

  it("does not set the flag on auth failure", async () => {
    const res = await call(askQuestionPost, { question: "anyone there?" });

    expect(res.status).toBe(401);
    expect(wasQuestionAskedViaMcp(sessionId)).toBe(false);
  });

  it("400s MISSING_TICKET for a ticketless session and stays side-effect free", async () => {
    const res = await call(
      askQuestionPost,
      { question: "where do I put this?" },
      noEpicToken
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("MISSING_TICKET");
    expect(wasQuestionAskedViaMcp(noEpicSessionId)).toBe(false);
    expect(db().select().from(ticketComments).all()).toHaveLength(0);
  });

  it("works for a ticketless session when ticket_id is explicit", async () => {
    const res = await call(
      askQuestionPost,
      { question: "is this the right epic?", ticket_id: epicId },
      noEpicToken
    );

    expect(res.status).toBe(200);
    expect(wasQuestionAskedViaMcp(noEpicSessionId)).toBe(true);

    const rows = db()
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all();
    expect(rows[0]?.agentSessionId).toBe(noEpicSessionId);
  });
});

// ---------------------------------------------------------------------------
// submit-findings
// ---------------------------------------------------------------------------

describe("POST /api/mcp/submit-findings", () => {
  it("stores one open agent review comment per finding plus a summary comment", async () => {
    const res = await call(
      submitFindingsPost,
      {
        verdict: "changes_requested",
        summary: "Two issues to address before approval.",
        findings: [
          {
            file_path: "lib/parser.ts",
            line: 12,
            body: "Possible null dereference on `input`",
            severity: "critical",
          },
          {
            file_path: "lib/format.ts",
            line: 3,
            body: "Typo in identifier",
            severity: "minor",
          },
        ],
      },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.findingIds).toHaveLength(2);
    expect(json.data.commentId).toEqual(expect.any(String));

    const findings = db()
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.epicId, epicId))
      .orderBy(reviewComments.lineNumber)
      .all();
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.id).sort()).toEqual(
      [...json.data.findingIds].sort()
    );
    expect(findings[1]).toMatchObject({
      filePath: "lib/parser.ts",
      lineNumber: 12,
      body: "[critical] Possible null dereference on `input`",
      author: "agent",
      status: "open",
    });
    expect(findings[0]).toMatchObject({
      filePath: "lib/format.ts",
      lineNumber: 3,
      body: "[minor] Typo in identifier",
    });

    const comments = db()
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: json.data.commentId,
      author: "agent",
      content:
        "**Review findings (changes requested)**\n\nTwo issues to address before approval.",
      agentSessionId: sessionId,
    });
  });

  it("persists the verdict on the calling session row", async () => {
    // The structured verdict is what the transition drivers read
    // (lib/pipeline/findings.ts); a summary-only review still has one.
    const res = await call(
      submitFindingsPost,
      {
        verdict: "changes_requested",
        summary: "The retry path is still unbounded.",
        findings: [],
      },
      token
    );

    expect(res.status).toBe(200);
    const session = db()
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    expect(session?.reviewVerdict).toBe("changes_requested");
  });

  it("lets a second call overwrite the verdict — the last word wins", async () => {
    await call(
      submitFindingsPost,
      { verdict: "changes_requested", summary: "First pass.", findings: [] },
      token
    );
    await call(
      submitFindingsPost,
      {
        verdict: "approved",
        summary: "Re-read it; the concern was mine, not the code's.",
        findings: [],
      },
      token
    );

    const session = db()
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    expect(session?.reviewVerdict).toBe("approved");
  });

  it("leaves the verdict of every OTHER session untouched", async () => {
    const res = await call(
      submitFindingsPost,
      { verdict: "approved", summary: "ok", findings: [] },
      token
    );

    expect(res.status).toBe(200);
    const others = db()
      .select()
      .from(agentSessions)
      .where(ne(agentSessions.id, sessionId))
      .all();
    expect(others.length).toBeGreaterThan(0);
    for (const row of others) {
      expect(row.reviewVerdict).toBeNull();
    }
  });

  it("accepts an empty findings list (summary-only review)", async () => {
    const res = await call(
      submitFindingsPost,
      {
        verdict: "approved_with_minor_issues",
        summary: "Nit: naming could be tighter, nothing blocking.",
        findings: [],
      },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.findingIds).toEqual([]);

    expect(db().select().from(reviewComments).all()).toHaveLength(0);
    const comments = db().select().from(ticketComments).all();
    expect(comments).toHaveLength(1);
    expect(comments[0]?.content).toContain(
      "**Review findings (approved with minor issues)**"
    );
  });

  it("always targets the token's own ticket — ticket_id is rejected", async () => {
    const res = await call(
      submitFindingsPost,
      {
        verdict: "approved",
        summary: "ok",
        findings: [],
        ticket_id: todoEpicId,
      },
      token
    );

    expect(res.status).toBe(400);
  });

  it("400s MISSING_TICKET for a ticketless session", async () => {
    const res = await call(
      submitFindingsPost,
      { verdict: "approved", summary: "ok", findings: [] },
      noEpicToken
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("MISSING_TICKET");
    expect(db().select().from(reviewComments).all()).toHaveLength(0);
  });

  it("400s past 50 findings", async () => {
    const findings = Array.from({ length: 51 }, (_, i) => ({
      file_path: "lib/a.ts",
      line: i + 1,
      body: "x",
      severity: "info",
    }));

    const res = await call(
      submitFindingsPost,
      { verdict: "changes_requested", summary: "too many", findings },
      token
    );

    expect(res.status).toBe(400);
    expect(db().select().from(reviewComments).all()).toHaveLength(0);
  });

  it("400s on an unknown severity", async () => {
    const res = await call(
      submitFindingsPost,
      {
        verdict: "approved",
        summary: "ok",
        findings: [
          { file_path: "a.ts", line: 1, body: "x", severity: "blocker" },
        ],
      },
      token
    );

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// submit-grading
// ---------------------------------------------------------------------------

describe("POST /api/mcp/submit-grading", () => {
  function seedStory(storyId: string, parentEpicId = epicId) {
    db()
      .insert(userStories)
      .values({
        id: storyId,
        epicId: parentEpicId,
        title: `Story ${storyId}`,
        acceptanceCriteria: "The criterion",
        status: "in_progress",
      })
      .run();
  }

  it("stores one atomic report with strict grading statuses", async () => {
    const storyId = createId();
    seedStory(storyId);
    const gradings = [
      {
        storyId,
        criterion: "The happy path works",
        status: "met",
        evidence: "__tests__/feature.test.ts covers it",
      },
      {
        storyId,
        criterion: "The edge case is explained",
        status: "partial",
        evidence: "Implementation exists but lacks a regression test",
      },
      {
        storyId,
        criterion: "The fallback is implemented",
        status: "missed",
        evidence: "No fallback exists in the worktree",
      },
    ];

    const res = await call(
      submitGradingPost,
      { gradings, summary: "One criterion still needs work." },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.reportId).toEqual(expect.any(String));

    const reports = db().select().from(gradingReports).all();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      id: json.data.reportId,
      epicId,
      agentSessionId: sessionId,
      summary: "One criterion still needs work.",
    });
    expect(JSON.parse(reports[0].gradings)).toEqual(gradings);
  });

  it("rejects an unknown status without persisting a report", async () => {
    const storyId = createId();
    seedStory(storyId);

    const res = await call(
      submitGradingPost,
      {
        gradings: [
          {
            storyId,
            criterion: "The criterion",
            status: "almost",
            evidence: "Some evidence",
          },
        ],
        summary: "Invalid",
      },
      token
    );

    expect(res.status).toBe(400);
    expect(db().select().from(gradingReports).all()).toHaveLength(0);
  });

  it("rejects unknown payload keys at both levels", async () => {
    const storyId = createId();
    seedStory(storyId);

    const res = await call(
      submitGradingPost,
      {
        gradings: [
          {
            storyId,
            criterion: "The criterion",
            status: "met",
            evidence: "Some evidence",
            confidence: 0.9,
          },
        ],
        summary: "Invalid",
        verdict: "approved",
      },
      token
    );

    expect(res.status).toBe(400);
    expect(db().select().from(gradingReports).all()).toHaveLength(0);
  });

  it("rejects a story outside the token epic with a readable error and no partial write", async () => {
    const validStoryId = createId();
    const outsideStoryId = createId();
    seedStory(validStoryId);
    seedStory(outsideStoryId, todoEpicId);

    const res = await call(
      submitGradingPost,
      {
        gradings: [
          {
            storyId: validStoryId,
            criterion: "Valid criterion",
            status: "met",
            evidence: "Valid evidence",
          },
          {
            storyId: outsideStoryId,
            criterion: "Outside criterion",
            status: "missed",
            evidence: "Must not be written",
          },
        ],
        summary: "Mixed scope",
      },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("STORY_NOT_IN_EPIC");
    expect(json.error).toContain(outsideStoryId);
    expect(json.error).toContain("does not belong to ticket");
    expect(db().select().from(gradingReports).all()).toHaveLength(0);
  });

  it("always targets the token epic — ticket_id is rejected", async () => {
    const storyId = createId();
    seedStory(storyId);

    const res = await call(
      submitGradingPost,
      {
        gradings: [
          {
            storyId,
            criterion: "The criterion",
            status: "met",
            evidence: "Some evidence",
          },
        ],
        summary: "ok",
        ticket_id: todoEpicId,
      },
      token
    );

    expect(res.status).toBe(400);
    expect(db().select().from(gradingReports).all()).toHaveLength(0);
  });

  it("400s MISSING_TICKET for a ticketless session", async () => {
    const res = await call(
      submitGradingPost,
      {
        gradings: [
          {
            storyId: createId(),
            criterion: "The criterion",
            status: "met",
            evidence: "Some evidence",
          },
        ],
        summary: "ok",
      },
      noEpicToken
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("MISSING_TICKET");
    expect(db().select().from(gradingReports).all()).toHaveLength(0);
  });
});
