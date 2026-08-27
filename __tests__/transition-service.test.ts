/**
 * Tests for the unified transition service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let updateCalls: { table: string; updates: Record<string, unknown> }[] = [];

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    all: vi.fn(() => []),
    update: vi.fn((table: { _name?: string }) => ({
      set: vi.fn((updates: Record<string, unknown>) => {
        updateCalls.push({ table: table?._name ?? "unknown", updates });
        return {
          where: vi.fn().mockReturnValue({ run: vi.fn() }),
        };
      }),
    })),
  };
  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  epics: { _name: "epics", id: "id", status: "status", updatedAt: "updatedAt" },
  userStories: { _name: "userStories", id: "id", status: "status" },
  agentSessions: {
    _name: "agentSessions",
    epicId: "epicId",
    status: "status",
  },
  reviewComments: {
    _name: "reviewComments",
    epicId: "epicId",
    status: "status",
    // Read by the batched unverifiable-review check: a review session with
    // findings rows of its own proved its channel worked.
    agentSessionId: "agentSessionId",
  },
  // Same check reads the mcp_tools_enabled toggle when a session row carries
  // no recorded channel state (every legacy row).
  settings: { _name: "settings", key: "key", value: "value" },
  ticketActivityLog: {
    _name: "ticketActivityLog",
    id: "id",
    projectId: "projectId",
    epicId: "epicId",
    fromStatus: "fromStatus",
    toStatus: "toStatus",
    actor: "actor",
    reason: "reason",
    sessionId: "sessionId",
    createdAt: "createdAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "test-id"),
}));

const mockEmitTicketMoved = vi.fn();
vi.mock("@/lib/events/emit", () => ({
  emitTicketMoved: (...args: unknown[]) => mockEmitTicketMoved(...args),
}));

const mockLogTransition = vi.fn();
vi.mock("@/lib/workflow/log", () => ({
  logTransition: (...args: unknown[]) => mockLogTransition(...args),
}));

// Shared reset for every describe block in this file: the db mock is one
// module-level chain, so mock queues and updateCalls must be clean per test.
beforeEach(() => {
  vi.clearAllMocks();
  updateCalls = [];
});

describe("applyTransition", () => {
  it("returns valid:true for same-status transitions (no-op)", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "backlog",
      toStatus: "backlog",
      actor: "user",
      source: "drag",
    });
    expect(result.valid).toBe(true);
    expect(mockEmitTicketMoved).not.toHaveBeenCalled();
    expect(mockLogTransition).not.toHaveBeenCalled();
  });

  it("validates and applies a valid transition", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "backlog",
      toStatus: "todo",
      actor: "user",
      source: "drag",
      reason: "Manual move",
    });
    expect(result.valid).toBe(true);

    // Should update DB
    const epicUpdate = updateCalls.find((c) => c.table === "epics");
    expect(epicUpdate).toBeDefined();
    expect(epicUpdate!.updates.status).toBe("todo");

    // Should emit event
    expect(mockEmitTicketMoved).toHaveBeenCalledWith("p1", "e1", "backlog", "todo");

    // Should log transition
    expect(mockLogTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        epicId: "e1",
        fromStatus: "backlog",
        toStatus: "todo",
        actor: "user",
        reason: "Manual move",
      })
    );
  });

  it("rejects invalid structural transitions", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "backlog",
      toStatus: "done",
      actor: "user",
      source: "drag",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid transition");
    expect(mockEmitTicketMoved).not.toHaveBeenCalled();
  });

  it("logs a refused transition with its ticket and guard reason", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "backlog",
      toStatus: "done",
      actor: "user",
      source: "drag",
      reason: "Manual move",
    });
    expect(result.valid).toBe(false);

    const epicUpdate = updateCalls.find((c) => c.table === "epics");
    expect(epicUpdate).toBeUndefined();
    expect(mockEmitTicketMoved).not.toHaveBeenCalled();
    expect(mockLogTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        epicId: "e1",
        fromStatus: "backlog",
        toStatus: "backlog",
        reason: expect.stringContaining("Transition backlog → done refused"),
      })
    );
  });

  it("only validates when validateOnly is true", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "backlog",
      toStatus: "todo",
      actor: "user",
      source: "drag",
      validateOnly: true,
    });
    expect(result.valid).toBe(true);

    // Should NOT update DB, emit, or log
    expect(updateCalls).toHaveLength(0);
    expect(mockEmitTicketMoved).not.toHaveBeenCalled();
    expect(mockLogTransition).not.toHaveBeenCalled();
  });

  it("rejects review -> done structurally (the merge boundary sits between)", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
      source: "drag",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid transition");
  });

  it("allows to_merge -> done only for the merge source", async () => {
    // The merge IS the approval: there is no manual approve step, so a drag
    // (or any other source) onto Done is refused, while the merge routes'
    // source passes through the same service call.
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    const opts = {
      projectId: "p1",
      epicId: "e1",
      fromStatus: "to_merge" as const,
      toStatus: "done" as const,
      actor: "user" as const,
      validateOnly: true,
    };

    const dragged = applyTransition({ ...opts, source: "drag" });
    expect(dragged.valid).toBe(false);
    expect(dragged.error).toContain("successful merge");

    const merged = applyTransition({ ...opts, source: "merge" });
    expect(merged.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Owning-session exemption — the session that owns an in-progress ticket may
// move it itself (MCP update_ticket_status), concurrent actors stay locked.
// ---------------------------------------------------------------------------

describe("applyTransition — owning session exemption", () => {
  // Context read order: completed reviews, running sessions. (The open-comment
  // read is gone with its guard: findings no longer gate transitions.)
  async function seedRunningSessions(rows: unknown[]) {
    const { db } = await import("@/lib/db");
    const all = (db as unknown as Record<string, ReturnType<typeof vi.fn>>).all;
    all
      .mockReturnValueOnce([]) // no completed review sessions
      .mockReturnValueOnce(rows);
  }

  it("lets the acting session move its own in-progress ticket to review", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    await seedRunningSessions([
      { id: "s1", status: "running", agentType: "build" },
    ]);

    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      source: "api",
      sessionId: "s1",
    });

    expect(result.valid).toBe(true);
    const epicUpdate = updateCalls.find((c) => c.table === "epics");
    expect(epicUpdate).toBeDefined();
    expect(epicUpdate!.updates.status).toBe("review");
    expect(mockEmitTicketMoved).toHaveBeenCalledWith(
      "p1",
      "e1",
      "in_progress",
      "review"
    );
  });

  it("lets the acting session move its ticket while its session is queued", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    await seedRunningSessions([
      { id: "s1", status: "queued", agentType: "build" },
    ]);

    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      source: "api",
      sessionId: "s1",
    });

    expect(result.valid).toBe(true);
  });

  it("refuses the same move for a different session", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    await seedRunningSessions([
      { id: "s2", status: "running", agentType: "build" },
    ]);

    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      source: "api",
      sessionId: "s1",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain("queued or running");
    expect(updateCalls.find((c) => c.table === "epics")).toBeUndefined();
  });

  it("refuses when a second code-producing session is also live", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    await seedRunningSessions([
      { id: "s1", status: "running", agentType: "build" },
      { id: "s3", status: "running", agentType: "ticket_build" },
    ]);

    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      source: "api",
      sessionId: "s1",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain("queued or running");
  });

  it("does not lock the ticket for non-code-producing sessions", async () => {
    // A live chat/review session on the ticket never owns in_progress; the
    // acting agent session (or any actor) may move it as usual.
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    await seedRunningSessions([
      { id: "s9", status: "running", agentType: "chat" },
    ]);

    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "user",
      source: "drag",
    });

    expect(result.valid).toBe(true);
  });

  it("refuses a user drag while a build session is live", async () => {
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    await seedRunningSessions([
      { id: "s1", status: "running", agentType: "build" },
    ]);

    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "user",
      source: "drag",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain("queued or running");
  });

  it("refuses a story-scoped session on an epic-scoped move (ownership stops at the story)", async () => {
    // The sole live build on the epic is a story build: it owns its story,
    // never the parent epic. Epic promotion must stay with the terminal
    // handler's sibling-story rule.
    const { applyTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    await seedRunningSessions([
      { id: "s1", status: "running", agentType: "ticket_build", userStoryId: "st1" },
    ]);

    const result = applyTransition({
      projectId: "p1",
      epicId: "e1",
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      source: "api",
      sessionId: "s1",
    });

    expect(result.valid).toBe(false);
    // The refusal names the scope rule, not a phantom concurrent session.
    expect(result.error).toContain("may only move its own story");
    expect(result.error).not.toContain("queued or running");
    expect(updateCalls.find((c) => c.table === "epics")).toBeUndefined();
  });
});

describe("applyStoryTransition — owning session exemption", () => {
  async function seedStoryReads(rows: unknown[]) {
    const { db } = await import("@/lib/db");
    const all = (db as unknown as Record<string, ReturnType<typeof vi.fn>>).all;
    // Context read order: completed reviews, running sessions (filtered to
    // the story). The story transition then writes userStories.
    all
      .mockReturnValueOnce([])
      .mockReturnValueOnce(rows);
  }

  it("lets the acting story build promote its own story to review", async () => {
    const { applyStoryTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    await seedStoryReads([
      { id: "s1", status: "running", agentType: "ticket_build" },
    ]);

    const result = applyStoryTransition({
      projectId: "p1",
      epicId: "e1",
      userStoryId: "st1",
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      source: "api",
      reason: "Story work committed",
      sessionId: "s1",
    });

    expect(result.valid).toBe(true);
    const storyUpdate = updateCalls.find((c) => c.table === "userStories");
    expect(storyUpdate).toBeDefined();
    expect(storyUpdate!.updates.status).toBe("review");
  });

  it("refuses the story move when another build still owns the story", async () => {
    const { applyStoryTransition } = await import(
      "@/lib/workflow/transition-service"
    );
    await seedStoryReads([
      { id: "s2", status: "running", agentType: "ticket_build" },
    ]);

    const result = applyStoryTransition({
      projectId: "p1",
      epicId: "e1",
      userStoryId: "st1",
      fromStatus: "in_progress",
      toStatus: "review",
      actor: "agent",
      source: "api",
      reason: "Story work committed",
      sessionId: "s1",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain("queued or running");
    expect(updateCalls.find((c) => c.table === "userStories")).toBeUndefined();
  });
});
