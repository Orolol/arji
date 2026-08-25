/**
 * GET/DELETE /api/projects/[projectId]/sessions/[sessionId] honour BOTH path
 * segments, against the real migrated schema (createTestDb) so the WHERE
 * clause is actually exercised — the shared chain mock ignores predicates and
 * would pass either way.
 *
 * The route used to look sessions up by id alone, which made the projectId
 * segment decorative: anyone holding a session id could read its prompt, logs
 * and raw output — or cancel the run — through ANY project's URL. Dreaming
 * navigates straight to this route after dispatching, so the id is now
 * routinely in the client's hands.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const { cancelProcess, schedulerRemove, cancelInProject } = vi.hoisted(() => ({
  cancelProcess: vi.fn(),
  schedulerRemove: vi.fn(),
  cancelInProject: vi.fn(() => false),
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: { cancel: cancelProcess },
}));

vi.mock("@/lib/agents/scheduler", () => ({
  agentScheduler: { remove: schedulerRemove },
}));

vi.mock("@/lib/activity-registry", () => ({
  activityRegistry: { cancelInProject },
}));

vi.mock("@/lib/agent-sessions/backfill", () => ({
  runBackfillRecentSessionLastNonEmptyTextOnce: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { projects, agentSessions } = await import("@/lib/db/schema");
const { GET, DELETE } = await import(
  "@/app/api/projects/[projectId]/sessions/[sessionId]/route"
);

const OWNER = "proj-owner";
const OTHER = "proj-other";
const SESSION_ID = "sess-secret";

beforeEach(() => {
  vi.clearAllMocks();
  db.delete(agentSessions).run();
  db.delete(projects).run();

  db.insert(projects).values({ id: OWNER, name: "Owner" }).run();
  db.insert(projects).values({ id: OTHER, name: "Other" }).run();
  db.insert(agentSessions)
    .values({
      id: SESSION_ID,
      projectId: OWNER,
      status: "running",
      agentType: "build",
      prompt: "the owner project's private prompt",
      createdAt: new Date().toISOString(),
    })
    .run();
});

describe("session detail GET — project scope", () => {
  it("serves the session under its own project", async () => {
    const response = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: OWNER, sessionId: SESSION_ID })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.id).toBe(SESSION_ID);
    expect(json.data.prompt).toBe("the owner project's private prompt");
  });

  it("404s — and leaks nothing — under a different project", async () => {
    const response = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: OTHER, sessionId: SESSION_ID })
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error).toBe("Session not found");
    expect(JSON.stringify(json)).not.toContain("private prompt");
  });
});

describe("session detail DELETE — project scope", () => {
  it("cancels the session under its own project", async () => {
    const response = await DELETE(
      mockNextRequest(),
      mockRouteContext({ projectId: OWNER, sessionId: SESSION_ID })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { cancelled: true } });
    expect(cancelProcess).toHaveBeenCalledWith(SESSION_ID);
    expect(
      db.select().from(agentSessions).all()[0]?.status
    ).toBe("cancelled");
  });

  it("refuses to cancel it from a different project", async () => {
    const response = await DELETE(
      mockNextRequest(),
      mockRouteContext({ projectId: OTHER, sessionId: SESSION_ID })
    );

    expect(response.status).toBe(404);
    // The run is untouched: no kill signal, no queue eviction, no status move.
    expect(cancelProcess).not.toHaveBeenCalled();
    expect(schedulerRemove).not.toHaveBeenCalled();
    expect(db.select().from(agentSessions).all()[0]?.status).toBe("running");
  });

  it("passes the project scope down to the ephemeral-activity fallback", async () => {
    // Chat/spec/release activities have no agent_sessions row, so the registry
    // is the only thing that can enforce the same boundary.
    const response = await DELETE(
      mockNextRequest(),
      mockRouteContext({ projectId: OTHER, sessionId: "chat-activity-1" })
    );

    expect(cancelInProject).toHaveBeenCalledWith("chat-activity-1", OTHER);
    expect(response.status).toBe(404);
  });
});
