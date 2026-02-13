/**
 * Tests for the session lock check logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let mockAllResult: Array<{ id: string; mode: string; status: string }> = [];

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    all: vi.fn(() => mockAllResult),
  };
  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  agentSessions: {
    id: "id",
    epicId: "epicId",
    userStoryId: "userStoryId",
    mode: "mode",
    status: "status",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
}));

describe("checkSessionLock", () => {
  beforeEach(() => {
    mockAllResult = [];
    vi.resetModules();
  });

  it("returns locked=false when no active sessions exist", async () => {
    mockAllResult = [];
    const { checkSessionLock } = await import("@/lib/session-lock");

    const result = checkSessionLock({ epicId: "epic-1" });

    expect(result.locked).toBe(false);
    expect(result.sessionId).toBeUndefined();
  });

  it("returns locked=true with sessionId when an active session exists for an epic", async () => {
    mockAllResult = [
      { id: "session-abc", mode: "code", status: "running" },
    ];
    const { checkSessionLock } = await import("@/lib/session-lock");

    const result = checkSessionLock({ epicId: "epic-1" });

    expect(result.locked).toBe(true);
    expect(result.sessionId).toBe("session-abc");
    expect(result.label).toContain("code");
  });

  it("returns locked=true when a pending session exists for a story", async () => {
    mockAllResult = [
      { id: "session-def", mode: "plan", status: "pending" },
    ];
    const { checkSessionLock } = await import("@/lib/session-lock");

    const result = checkSessionLock({ userStoryId: "story-1" });

    expect(result.locked).toBe(true);
    expect(result.sessionId).toBe("session-def");
    expect(result.label).toContain("plan");
    expect(result.label).toContain("story");
  });

  it("checks story first, then epic when both provided", async () => {
    // Story check returns active session — should not even check epic
    mockAllResult = [
      { id: "session-story", mode: "code", status: "running" },
    ];
    const { checkSessionLock } = await import("@/lib/session-lock");

    const result = checkSessionLock({
      userStoryId: "story-1",
      epicId: "epic-1",
    });

    expect(result.locked).toBe(true);
    expect(result.sessionId).toBe("session-story");
  });

  it("returns locked=false when no params are provided", async () => {
    mockAllResult = [];
    const { checkSessionLock } = await import("@/lib/session-lock");

    const result = checkSessionLock({});

    expect(result.locked).toBe(false);
  });
});
