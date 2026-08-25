/** Agent create_bug route: canonical creation, traceability and anti-abuse. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/test-utils";
import { mockNextRequest } from "@/__tests__/helpers/db-mock";
import {
  agentSessions,
  epics,
  projects,
  ticketActivityLog,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import {
  _resetMcpTokenStoreForTests,
  mintMcpToken,
} from "@/lib/mcp/token-store";
import {
  MAX_MCP_BUGS_PER_SESSION,
  MCP_CREATE_BUG_ACTION_HEADER,
  MCP_CREATE_BUG_ACTIVITY_PREFIX,
  MCP_CREATE_BUG_SOURCE_TICKET_HEADER,
} from "@/lib/mcp/create-bug-contract";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<
    typeof import("@/lib/db/test-utils").createTestDb
  > | null,
}));

const mockTryExportArjiJson = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: mockTryExportArjiJson,
}));

import { POST as createBugPost } from "@/app/api/mcp/create-bug/route";
import { POST as createEpicPost } from "@/app/api/projects/[projectId]/epics/route";

const ORIGIN = "http://localhost:3000";

let projectId: string;
let otherProjectId: string;
let sourceEpicId: string;
let sessionId: string;
let token: string;
let chatToken: string;
let fetchMock: ReturnType<typeof vi.fn>;

function db() {
  return testDb.instance!.db;
}

function call(body: unknown, bearer = token) {
  return createBugPost(
    mockNextRequest({
      url: `${ORIGIN}/api/mcp/create-bug`,
      body,
      headers: { authorization: `Bearer ${bearer}` },
    }) as NextRequest,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installCanonicalCreationStub() {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    return createEpicPost(
      mockNextRequest({
        url,
        method: "POST",
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
      }),
      { params: Promise.resolve({ projectId }) },
    );
  });
}

beforeEach(() => {
  testDb.instance = createTestDb();
  _resetMcpTokenStoreForTests();
  mockTryExportArjiJson.mockReset();

  projectId = createId();
  otherProjectId = createId();
  sourceEpicId = createId();
  sessionId = createId();
  const now = new Date().toISOString();

  db()
    .insert(projects)
    .values([
      { id: projectId, name: "Main", ticketCounter: 1, createdAt: now, updatedAt: now },
      { id: otherProjectId, name: "Other", createdAt: now, updatedAt: now },
    ])
    .run();
  db()
    .insert(epics)
    .values({
      id: sourceEpicId,
      projectId,
      title: "Source feature",
      readableId: "E-main-001",
      status: "in_progress",
      type: "feature",
      position: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db()
    .insert(agentSessions)
    .values({
      id: sessionId,
      projectId,
      epicId: sourceEpicId,
      status: "running",
      agentType: "build",
      createdAt: now,
    })
    .run();

  token = mintMcpToken({
    sessionId,
    projectId,
    epicId: sourceEpicId,
    agentType: "build",
  });
  chatToken = mintMcpToken({
    sessionId: `chat-${createId()}`,
    projectId,
    agentType: "chat",
  });

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/mcp/create-bug", () => {
  it("creates a project-scoped bug through the canonical route and attributes its activity", async () => {
    installCanonicalCreationStub();

    const response = await call({
      title: "Board refresh loses moves",
      description: "## Context\n\nAfter reconnect, the card stays in the old column.",
      severity: "critical",
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    const bugId = json.data.bug.id as string;
    expect(json.data).toMatchObject({
      bug: {
        readable_id: "B-main-002",
        title: "Board refresh loses moves",
        status: "backlog",
        type: "bug",
        priority: 3,
      },
      source: {
        session_id: sessionId,
        ticket_id: sourceEpicId,
        story_id: null,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/projects/${projectId}/epics`);
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Board refresh loses moves",
      description: "## Context\n\nAfter reconnect, the card stays in the old column.",
      type: "bug",
      priority: 3,
      status: "backlog",
    });
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      [MCP_CREATE_BUG_ACTION_HEADER]: "create_bug",
      [MCP_CREATE_BUG_SOURCE_TICKET_HEADER]: sourceEpicId,
    });

    const created = db()
      .select()
      .from(epics)
      .where(eq(epics.id, bugId))
      .get();
    expect(created).toMatchObject({
      projectId,
      readableId: "B-main-002",
      type: "bug",
      status: "backlog",
    });

    const activity = db()
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, bugId))
      .get();
    expect(activity).toMatchObject({
      projectId,
      actor: "agent",
      sessionId,
      fromStatus: "backlog",
      toStatus: "backlog",
    });
    expect(activity?.reason).toContain(MCP_CREATE_BUG_ACTIVITY_PREFIX);
    expect(activity?.reason).toContain("E-main-001");
    expect(activity?.reason).toContain(sessionId);
    expect(mockTryExportArjiJson).toHaveBeenCalledWith(projectId);
  });

  it("rolls back canonical creation when its session audit cannot be persisted", async () => {
    testDb.instance!.sqlite.exec(`
      CREATE TRIGGER reject_create_bug_audit
      BEFORE INSERT ON ticket_activity_log
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END
    `);
    installCanonicalCreationStub();

    const response = await call({
      title: "Audit must be atomic",
      description: "Do not create this ticket without its source session.",
    });

    expect(response.status).toBe(500);
    expect(
      db()
        .select()
        .from(epics)
        .where(eq(epics.title, "Audit must be atomic"))
        .all(),
    ).toHaveLength(0);
    expect(mockTryExportArjiJson).not.toHaveBeenCalled();
  });

  it("ignores spoofed create_bug provenance without a valid MCP bearer", async () => {
    const response = await createEpicPost(
      mockNextRequest({
        url: `${ORIGIN}/api/projects/${projectId}/epics`,
        method: "POST",
        body: {
          title: "Ordinary UI bug",
          description: "This is not an agent-attributed write.",
          type: "bug",
        },
        headers: {
          [MCP_CREATE_BUG_ACTION_HEADER]: "create_bug",
          [MCP_CREATE_BUG_SOURCE_TICKET_HEADER]: sourceEpicId,
        },
      }),
      { params: Promise.resolve({ projectId }) },
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(
      db()
        .select()
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.epicId, json.data.id))
        .all(),
    ).toHaveLength(0);
  });

  it("refuses a punctuation/case-equivalent open bug instead of duplicating it", async () => {
    const now = new Date().toISOString();
    db()
      .insert(epics)
      .values({
        id: "existing-bug",
        projectId,
        title: "Board—refresh loses moves!",
        readableId: "B-main-002",
        status: "todo",
        type: "bug",
        position: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const response = await call({
      title: "  board refresh   loses MOVES ",
      description: "Same observation.",
    });
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json).toMatchObject({
      code: "DUPLICATE_BUG",
      existing_bug: { id: "existing-bug", readable_id: "B-main-002" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializes the duplicate check with canonical creation under concurrent reports", async () => {
    installCanonicalCreationStub();

    const body = {
      title: "Concurrent board refresh bug",
      description: "Two tool calls observed the same problem at once.",
    };
    const [first, second] = await Promise.all([call(body), call(body)]);
    const responses = [first, second].sort(
      (left, right) => left.status - right.status,
    );

    expect(responses.map((response) => response.status)).toEqual([200, 409]);
    expect(await responses[1].json()).toMatchObject({
      code: "DUPLICATE_BUG",
      existing_bug: {
        title: body.title,
        status: "backlog",
      },
    });
    expect(
      db().select().from(epics).where(eq(epics.title, body.title)).all(),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockTryExportArjiJson).toHaveBeenCalledTimes(1);
  });

  it("enforces the per-session creation ceiling", async () => {
    const now = new Date().toISOString();
    for (let index = 0; index < MAX_MCP_BUGS_PER_SESSION; index += 1) {
      const bugId = `prior-bug-${index}`;
      db()
        .insert(epics)
        .values({
          id: bugId,
          projectId,
          title: `Prior bug ${index}`,
          status: "backlog",
          type: "bug",
          position: index + 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db()
        .insert(ticketActivityLog)
        .values({
          id: createId(),
          projectId,
          epicId: bugId,
          fromStatus: "backlog",
          toStatus: "backlog",
          actor: "agent",
          reason: `${MCP_CREATE_BUG_ACTIVITY_PREFIX} prior report`,
          sessionId,
          createdAt: now,
        })
        .run();
    }

    const response = await call({
      title: "One report too many",
      description: "This should be rate limited.",
    });
    const json = await response.json();

    expect(response.status).toBe(429);
    expect(json.code).toBe("BUG_CREATION_LIMIT_REACHED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts only source tickets from the token's project", async () => {
    const now = new Date().toISOString();
    const foreignEpicId = createId();
    db()
      .insert(epics)
      .values({
        id: foreignEpicId,
        projectId: otherProjectId,
        title: "Foreign",
        readableId: "E-other-001",
        status: "todo",
        position: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const response = await call({
      title: "Scoped report",
      description: "Must stay in Main.",
      source_ticket_id: foreignEpicId,
    });

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("SOURCE_TICKET_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects chat tokens and invalid payloads before canonical creation", async () => {
    const chatResponse = await call(
      { title: "Chat bug", description: "Use create_ticket instead." },
      chatToken,
    );
    expect(chatResponse.status).toBe(403);
    expect((await chatResponse.json()).code).toBe("FORBIDDEN");

    const invalidResponse = await call({ title: "No description" });
    expect(invalidResponse.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes canonical creation failures back to the agent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Failed to create epic", code: "CREATE_FAILED" }, 500),
    );

    const response = await call({
      title: "Canonical failure",
      description: "The route refused persistence.",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to create epic",
      code: "CREATE_FAILED",
    });
    expect(
      db()
        .select()
        .from(ticketActivityLog)
        .where(
          and(
            eq(ticketActivityLog.sessionId, sessionId),
            eq(ticketActivityLog.actor, "agent"),
          ),
        )
        .all(),
    ).toHaveLength(0);
  });
});
