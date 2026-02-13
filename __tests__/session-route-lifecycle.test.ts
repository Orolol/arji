import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbChain } = vi.hoisted(() => ({
  dbChain: {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  db: dbChain,
  sqlite: {
    prepare: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  agentSessions: {
    id: "id",
    status: "status",
    startedAt: "startedAt",
    endedAt: "endedAt",
    completedAt: "completedAt",
  },
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    cancel: vi.fn(() => true),
  },
}));

vi.mock("@/lib/agent-sessions/backfill", () => ({
  runBackfillRecentSessionLastNonEmptyTextOnce: vi.fn(),
}));

describe("sessions/[sessionId] DELETE lifecycle guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbChain.select.mockReturnValue(dbChain);
    dbChain.from.mockReturnValue(dbChain);
    dbChain.where.mockReturnValue(dbChain);
    dbChain.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: vi.fn() }),
      }),
    });
  });

  it("returns 409 and machine-readable code for invalid transitions", async () => {
    dbChain.get.mockReturnValue({
      id: "sess-1",
      status: "completed",
      startedAt: "2026-02-12T00:00:00.000Z",
      endedAt: "2026-02-12T00:01:00.000Z",
      completedAt: "2026-02-12T00:01:00.000Z",
    });

    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/sessions/[sessionId]/route"
    );

    const response = await DELETE({} as never, {
      params: Promise.resolve({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    });

    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json.code).toBe("INVALID_SESSION_TRANSITION");
    expect(json.details).toMatchObject({
      sessionId: "sess-1",
      fromStatus: "completed",
      toStatus: "cancelled",
    });
  });

  it("includes lastNonEmptyText in session detail payload", async () => {
    dbChain.get.mockReturnValue({
      id: "sess-2",
      status: "running",
      lastNonEmptyText: "Implementing API route",
      logsPath: null,
    });

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/[sessionId]/route"
    );

    const response = await GET({} as never, {
      params: Promise.resolve({
        projectId: "proj-1",
        sessionId: "sess-2",
      }),
    });

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.lastNonEmptyText).toBe("Implementing API route");
  });
});
