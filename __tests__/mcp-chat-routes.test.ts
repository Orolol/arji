/**
 * Tests for the chat-toolset /api/mcp/* board routes (list-tickets,
 * create-ticket, update-ticket, get-agent-status, start-build) and the
 * chat-token guards on the agent-only routes (ask-question,
 * submit-findings, submit-grading).
 *
 * Real handlers against an isolated in-memory database (createTestDb) and
 * real tokens from the MCP token store — same harness as mcp-routes.test.ts.
 * The board executors reach the canonical project routes over HTTP, so
 * global fetch is stubbed per test: assertions cover BOTH sides — the token
 * (never the body) decides the project scope, and the canonical route is
 * called with the exact method/path/payload the fast-mode tools use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/test-utils";
import { mockNextRequest } from "@/__tests__/helpers/db-mock";
import { epics, projects, ticketComments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import {
  _resetMcpTokenStoreForTests,
  mintMcpToken,
  revokeMcpTokensForSession,
} from "@/lib/mcp/token-store";

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
import { POST as listTicketsPost } from "@/app/api/mcp/list-tickets/route";
import { POST as createTicketPost } from "@/app/api/mcp/create-ticket/route";
import { POST as updateTicketPost } from "@/app/api/mcp/update-ticket/route";
import { POST as getAgentStatusPost } from "@/app/api/mcp/get-agent-status/route";
import { POST as startBuildPost } from "@/app/api/mcp/start-build/route";
import { POST as askQuestionPost } from "@/app/api/mcp/ask-question/route";
import { POST as submitFindingsPost } from "@/app/api/mcp/submit-findings/route";
import { POST as submitGradingPost } from "@/app/api/mcp/submit-grading/route";
import { POST as postCommentPost } from "@/app/api/mcp/post-comment/route";

type RouteHandler = (request: NextRequest) => Promise<Response>;

const ORIGIN = "http://localhost:3000";

let projectId: string;
let otherProjectId: string;
let epicId: string;
let otherProjectEpicId: string;
let chatSessionId: string;
let chatToken: string;
let fetchMock: ReturnType<typeof vi.fn>;

function call(handler: RouteHandler, body: unknown, bearer?: string) {
  return handler(
    mockNextRequest({
      url: `${ORIGIN}/api/mcp/test`,
      body,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
    })
  );
}

function db() {
  return testDb.instance!.db;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function fetchCallAt(index = 0): FetchCall {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: (init.headers ?? {}) as Record<string, string>,
    body:
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null,
  };
}

beforeEach(() => {
  testDb.instance = createTestDb();
  _resetMcpTokenStoreForTests();

  projectId = createId();
  otherProjectId = createId();
  epicId = createId();
  otherProjectEpicId = createId();
  chatSessionId = `chat-tools-${createId()}`;

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
        readableId: "E-main-001",
        status: "todo",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherProjectEpicId,
        projectId: otherProjectId,
        title: "Foreign epic",
        readableId: "E-other-001",
        status: "todo",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();

  chatToken = mintMcpToken({
    sessionId: chatSessionId,
    projectId,
    epicId: null,
    userStoryId: null,
    agentType: "chat",
  });

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth — every board route requires a live MCP token", () => {
  const routes: Array<[string, RouteHandler, unknown]> = [
    ["list-tickets", listTicketsPost, {}],
    ["create-ticket", createTicketPost, { title: "T" }],
    ["update-ticket", updateTicketPost, { ticket_id: "x", title: "T" }],
    ["get-agent-status", getAgentStatusPost, {}],
    ["start-build", startBuildPost, { ticket_id: "x" }],
  ];

  it.each(routes)("%s: 401 without, with bogus, and with revoked tokens", async (_name, handler, body) => {
    expect((await call(handler, body)).status).toBe(401);
    expect((await call(handler, body, "arij-mcp-bogus")).status).toBe(401);

    revokeMcpTokensForSession(chatSessionId);
    expect((await call(handler, body, chatToken)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp/list-tickets", () => {
  it("reads the token's project's board through the canonical epics route", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: epicId,
            readableId: "E-main-001",
            title: "Main epic",
            status: "todo",
            type: "feature",
            priority: 1,
            usDone: 1,
            usCount: 3,
          },
        ],
      })
    );

    const response = await call(listTicketsPost, {}, chatToken);
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: { count: number; tickets: Array<{ readable_id: string }> };
    };
    expect(data.count).toBe(1);
    expect(data.tickets[0].readable_id).toBe("E-main-001");

    // Token — not the body — picked the project.
    expect(fetchCallAt()).toMatchObject({
      method: "GET",
      url: `${ORIGIN}/api/projects/${projectId}/epics`,
    });
  });

  it("rejects unknown status filters at the validation layer", async () => {
    const response = await call(listTicketsPost, { status: "nope" }, chatToken);
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp/create-ticket", () => {
  it("creates through the canonical epics route with mapped user stories", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { id: "new-1", readableId: "E-main-002", title: "New", status: "backlog" },
      })
    );

    const response = await call(
      createTicketPost,
      {
        title: "New",
        type: "bug",
        priority: 2,
        user_stories: [{ title: "US1", acceptance_criteria: "It works" }],
      },
      chatToken
    );

    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: { created: { readable_id: string } };
    };
    expect(data.created.readable_id).toBe("E-main-002");

    expect(fetchCallAt()).toMatchObject({
      method: "POST",
      url: `${ORIGIN}/api/projects/${projectId}/epics`,
      body: {
        title: "New",
        type: "bug",
        priority: 2,
        userStories: [{ title: "US1", acceptanceCriteria: "It works" }],
      },
    });
  });

  it("maps upstream route failures onto the MCP error envelope", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "title too long", code: "VALIDATION" }, 422)
    );

    const response = await call(createTicketPost, { title: "New" }, chatToken);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "title too long", code: "VALIDATION" });
  });
});

describe("POST /api/mcp/update-ticket", () => {
  it("resolves readable ids case-insensitively within the token's project", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));

    const response = await call(
      updateTicketPost,
      { ticket_id: "e-MAIN-001", title: "Renamed" },
      chatToken
    );

    expect(response.status).toBe(200);
    expect(fetchCallAt()).toMatchObject({
      method: "PATCH",
      url: `${ORIGIN}/api/projects/${projectId}/epics/${epicId}`,
      body: { title: "Renamed" },
    });
  });

  it("does not resolve tickets from other projects", async () => {
    const response = await call(
      updateTicketPost,
      { ticket_id: otherProjectEpicId, title: "Hijack" },
      chatToken
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("No ticket");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty patches before touching the canonical route", async () => {
    const response = await call(updateTicketPost, { ticket_id: epicId }, chatToken);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Nothing to update");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp/get-agent-status", () => {
  it("reads the token's project's live activity", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            type: "build",
            label: "Build: Main epic",
            status: "running",
            provider: "claude-code",
            epicId,
            startedAt: "2026-08-20T10:00:00.000Z",
          },
        ],
      })
    );

    const response = await call(getAgentStatusPost, {}, chatToken);
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: { count: number; activities: Array<{ type: string }> };
    };
    expect(data.count).toBe(1);
    expect(data.activities[0].type).toBe("build");

    expect(fetchCallAt()).toMatchObject({
      method: "GET",
      url: `${ORIGIN}/api/projects/${projectId}/sessions/active`,
    });
  });
});

describe("POST /api/mcp/start-build", () => {
  it("posts the instruction as an agent comment, then launches the canonical build route", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/build")
          ? jsonResponse({ data: { sessionId: "sess-1", branchName: "feat/main-epic" } })
          : jsonResponse({ data: { commentId: "c1" } })
      )
    );

    const response = await call(
      startBuildPost,
      { ticket_id: "E-main-001", comment: "Ship it" },
      chatToken
    );

    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: { started: { ticket: string; session_id: string; instruction_posted: boolean } };
    };
    expect(data.started).toMatchObject({
      ticket: "E-main-001",
      session_id: "sess-1",
      instruction_posted: true,
    });

    // Instruction first (agent comment through the epic comments route)…
    expect(fetchCallAt(0)).toMatchObject({
      method: "POST",
      url: `${ORIGIN}/api/projects/${projectId}/epics/${epicId}/comments`,
      body: { author: "agent", content: "Ship it" },
    });
    // …then the build itself, with no user-impersonating comment field.
    expect(fetchCallAt(1)).toMatchObject({
      method: "POST",
      url: `${ORIGIN}/api/projects/${projectId}/epics/${epicId}/build`,
      body: {},
    });
  });

  it("passes the one-agent-per-ticket 409 through, code included", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "An agent is already working on this ticket", code: "AGENT_RUNNING" }, 409)
    );

    const response = await call(startBuildPost, { ticket_id: epicId }, chatToken);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "An agent is already working on this ticket",
      code: "AGENT_RUNNING",
    });
  });
});

describe("POST /api/mcp/post-comment — chat tokens", () => {
  it("accepts a chat token and leaves the comment unlinked (no agent_sessions row)", async () => {
    const response = await call(
      postCommentPost,
      { ticket_id: epicId, body: "Chat-side note" },
      chatToken
    );

    expect(response.status).toBe(200);
    const row = db()
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .get();
    expect(row).toMatchObject({
      author: "agent",
      content: "Chat-side note",
      agentSessionId: null,
    });
  });
});

describe("agent-only routes — chat tokens are rejected", () => {
  it("ask-question: 403 FORBIDDEN, no side effects", async () => {
    const response = await call(
      askQuestionPost,
      { question: "May I?", ticket_id: epicId },
      chatToken
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("submit-findings: 403 FORBIDDEN", async () => {
    const response = await call(
      submitFindingsPost,
      { verdict: "approved", summary: "ok", findings: [] },
      chatToken
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("submit-grading: 403 FORBIDDEN", async () => {
    const response = await call(
      submitGradingPost,
      {
        gradings: [
          {
            storyId: "story-id",
            criterion: "criterion",
            status: "met",
            evidence: "evidence",
          },
        ],
        summary: "ok",
      },
      chatToken
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });
});
