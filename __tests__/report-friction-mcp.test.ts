/**
 * Contract tests for report_friction's HTTP backend: strict payload,
 * bearer-token attribution, project-local soft dedupe, and board isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/test-utils";
import { mockNextRequest } from "@/__tests__/helpers/db-mock";
import {
  agentSessions,
  epics,
  frictions,
  projects,
  ticketActivityLog,
  ticketComments,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import {
  _resetMcpTokenStoreForTests,
  mintMcpToken,
  revokeMcpTokensForSession,
} from "@/lib/mcp/token-store";
import { FRICTION_CATEGORIES } from "@/lib/frictions/constants";

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

import { POST as reportFrictionPost } from "@/app/api/mcp/report-friction/route";

let projectId: string;
let otherProjectId: string;
let epicId: string;
let siblingEpicId: string;
let otherProjectEpicId: string;
let sessionId: string;
let siblingSessionId: string;
let otherSessionId: string;
let token: string;
let siblingToken: string;
let otherToken: string;

function db() {
  return testDb.instance!.db;
}

function call(body: unknown, bearer?: string) {
  return reportFrictionPost(
    mockNextRequest({
      url: "http://localhost:3000/api/mcp/report-friction",
      body,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
    }) as NextRequest
  );
}

beforeEach(() => {
  testDb.instance = createTestDb();
  _resetMcpTokenStoreForTests();

  projectId = createId();
  otherProjectId = createId();
  epicId = createId();
  siblingEpicId = createId();
  otherProjectEpicId = createId();
  sessionId = createId();
  siblingSessionId = createId();
  otherSessionId = createId();

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
        status: "in_progress",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: siblingEpicId,
        projectId,
        title: "Sibling epic",
        status: "in_progress",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherProjectEpicId,
        projectId: otherProjectId,
        title: "Foreign epic",
        status: "in_progress",
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
        agentType: "build",
        createdAt: now,
      },
      {
        id: siblingSessionId,
        projectId,
        epicId: siblingEpicId,
        status: "running",
        agentType: "build",
        createdAt: now,
      },
      {
        id: otherSessionId,
        projectId: otherProjectId,
        epicId: otherProjectEpicId,
        status: "running",
        agentType: "build",
        createdAt: now,
      },
    ])
    .run();

  token = mintMcpToken({
    sessionId,
    projectId,
    epicId,
    agentType: "build",
  });
  siblingToken = mintMcpToken({
    sessionId: siblingSessionId,
    projectId,
    epicId: siblingEpicId,
    agentType: "build",
  });
  otherToken = mintMcpToken({
    sessionId: otherSessionId,
    projectId: otherProjectId,
    epicId: otherProjectEpicId,
    agentType: "build",
  });
});

describe("POST /api/mcp/report-friction — payload validation", () => {
  it("accepts every closed category and trims the free-text fields", async () => {
    for (const [index, category] of FRICTION_CATEGORIES.entries()) {
      const res = await call(
        {
          category,
          description: `  Friction ${index}  `,
          filePath: `  path/${index}.ts  `,
        },
        token
      );
      expect(res.status).toBe(200);
    }

    const rows = db().select().from(frictions).all();
    expect(rows.map((row) => row.category)).toEqual([...FRICTION_CATEGORIES]);
    expect(rows[0]).toMatchObject({
      description: "Friction 0",
      filePath: "path/0.ts",
      occurrences: 1,
      status: "new",
    });
  });

  it("rejects an unknown category with a readable MCP error", async () => {
    const res = await call(
      { category: "slow_test", description: "This is not a valid category" },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("INVALID_PAYLOAD");
    expect(json.error).toContain("category");
    expect(json.error).toContain("report_friction");
    expect(db().select().from(frictions).all()).toHaveLength(0);
  });

  it.each([
    [{ category: "other", description: "" }, "description"],
    [{ category: "other", description: "ok", filePath: "  " }, "filePath"],
    [
      { category: "other", description: "ok", projectId: "injected" },
      "payload",
    ],
  ])("rejects strict invalid input %# and names %s", async (body, field) => {
    const res = await call(body, token);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("INVALID_PAYLOAD");
    expect(json.error).toContain(field);
    expect(db().select().from(frictions).all()).toHaveLength(0);
  });
});

describe("POST /api/mcp/report-friction — bearer scope", () => {
  it("takes project, session, and epic attribution only from the token", async () => {
    const res = await call(
      {
        category: "misleading_docs",
        description: "The setup guide names an obsolete command.",
        filePath: "README.md",
      },
      token
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({
      frictionId: expect.any(String),
      occurrences: 1,
      deduplicated: false,
    });
    expect(db().select().from(frictions).get()).toMatchObject({
      id: json.data.frictionId,
      projectId,
      epicId,
      agentSessionId: sessionId,
    });
  });

  it("keeps identical reports isolated by token project", async () => {
    const payload = {
      category: "flaky_test" as const,
      description: "The same-looking flaky test in two projects.",
      filePath: "__tests__/worker.test.ts",
    };

    await call(payload, token);
    await call(payload, otherToken);

    const rows = db().select().from(frictions).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.projectId).sort()).toEqual(
      [projectId, otherProjectId].sort()
    );
    expect(rows.map((row) => row.agentSessionId).sort()).toEqual(
      [sessionId, otherSessionId].sort()
    );
  });

  it("rejects missing, unknown, revoked, and chat tokens", async () => {
    const payload = { category: "other", description: "A friction" };

    expect((await call(payload)).status).toBe(401);
    expect((await call(payload, "unknown-token")).status).toBe(401);

    revokeMcpTokensForSession(sessionId);
    expect((await call(payload, token)).status).toBe(401);

    const chatToken = mintMcpToken({
      sessionId: "chat-turn",
      projectId,
      agentType: "chat",
    });
    const chatResponse = await call(payload, chatToken);
    expect(chatResponse.status).toBe(403);
    expect((await chatResponse.json()).error).toContain("agent sessions");
    expect(db().select().from(frictions).all()).toHaveLength(0);
  });

  it("allows ticketless agent sessions and stores a null epic scope", async () => {
    const ticketlessSessionId = createId();
    db()
      .insert(agentSessions)
      .values({
        id: ticketlessSessionId,
        projectId,
        status: "running",
        agentType: "team_build",
      })
      .run();
    const ticketlessToken = mintMcpToken({
      sessionId: ticketlessSessionId,
      projectId,
      agentType: "team_build",
    });

    const res = await call(
      { category: "unclear_convention", description: "No owner is documented." },
      ticketlessToken
    );

    expect(res.status).toBe(200);
    expect(db().select().from(frictions).get()).toMatchObject({
      projectId,
      epicId: null,
      agentSessionId: ticketlessSessionId,
    });
  });
});

describe("POST /api/mcp/report-friction — soft deduplication", () => {
  it("increments one open row by category and filePath across sessions", async () => {
    const first = await call(
      {
        category: "broken_tooling",
        description: "The script exits 1 without output.",
        filePath: "scripts/check.sh",
      },
      token
    );
    const firstJson = await first.json();
    db()
      .update(frictions)
      .set({ status: "triaged" })
      .where(eq(frictions.id, firstJson.data.frictionId))
      .run();

    const second = await call(
      {
        category: "broken_tooling",
        description: "A second agent hit the same script.",
        filePath: "scripts/check.sh",
      },
      siblingToken
    );
    const secondJson = await second.json();

    expect(second.status).toBe(200);
    expect(secondJson.data).toEqual({
      frictionId: firstJson.data.frictionId,
      occurrences: 2,
      deduplicated: true,
    });
    const rows = db().select().from(frictions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      occurrences: 2,
      status: "triaged",
      agentSessionId: sessionId,
      epicId,
    });
  });

  it("keeps path-less reports distinct so unrelated descriptions are preserved", async () => {
    await call(
      {
        category: "unclear_convention",
        description: "The convention has no documented owner.",
      },
      token
    );
    const res = await call(
      {
        category: "unclear_convention",
        description: "The release checklist does not name the base branch.",
      },
      siblingToken
    );

    expect((await res.json()).data).toMatchObject({
      occurrences: 1,
      deduplicated: false,
    });
    const rows = db().select().from(frictions).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.description)).toEqual([
      "The convention has no documented owner.",
      "The release checklist does not name the base branch.",
    ]);
    expect(rows.every((row) => row.filePath === null)).toBe(true);
  });

  it("does not dedupe different keys or closed rows", async () => {
    const base = {
      category: "flaky_test" as const,
      description: "Intermittent timeout.",
      filePath: "__tests__/api.test.ts",
    };
    await call(base, token);
    await call({ ...base, category: "other" }, token);
    await call({ ...base, filePath: "__tests__/other.test.ts" }, token);

    const first = db()
      .select()
      .from(frictions)
      .where(eq(frictions.category, "flaky_test"))
      .get()!;
    db()
      .update(frictions)
      .set({ status: "dismissed" })
      .where(eq(frictions.id, first.id))
      .run();
    const closedRepeat = await call(base, siblingToken);

    expect((await closedRepeat.json()).data.deduplicated).toBe(false);
    expect(db().select().from(frictions).all()).toHaveLength(4);
  });

  it("never changes the board or creates ticket activity/comments", async () => {
    await call(
      {
        category: "misleading_docs",
        description: "The docs disagree with the implementation.",
        filePath: "docs/setup.md",
      },
      token
    );

    expect(
      db().select().from(epics).where(eq(epics.id, epicId)).get()?.status
    ).toBe("in_progress");
    expect(db().select().from(ticketComments).all()).toHaveLength(0);
    expect(db().select().from(ticketActivityLog).all()).toHaveLength(0);
  });
});
