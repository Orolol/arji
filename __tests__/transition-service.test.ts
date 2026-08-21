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
  agentSessions: {
    _name: "agentSessions",
    epicId: "epicId",
    status: "status",
  },
  reviewComments: {
    _name: "reviewComments",
    epicId: "epicId",
    status: "status",
  },
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

describe("applyTransition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateCalls = [];
  });

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

  it("rejects review -> done via drag (guard fires)", async () => {
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
    // Guard fires for no completed review (first guard in chain)
    expect(result.error).toContain("Done");
  });
});
