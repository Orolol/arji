import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbChain, cancelRegistryActivity, cancelProcess, markSessionCancelled } =
  vi.hoisted(() => ({
    dbChain: {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn(),
      get: vi.fn(),
    },
    cancelRegistryActivity: vi.fn(),
    cancelProcess: vi.fn(),
    markSessionCancelled: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  db: dbChain,
}));

vi.mock("@/lib/db/schema", () => ({
  agentSessions: {
    id: "id",
  },
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    cancel: cancelProcess,
  },
}));

vi.mock("@/lib/activity-registry", () => ({
  activityRegistry: {
    cancel: cancelRegistryActivity,
  },
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  getSessionStatusForApi: vi.fn((status: string) => status),
  isSessionLifecycleConflictError: vi.fn(() => false),
  isSessionNotFoundError: vi.fn(() => false),
  markSessionCancelled,
}));

vi.mock("@/lib/agent-sessions/backfill", () => ({
  runBackfillRecentSessionLastNonEmptyTextOnce: vi.fn(),
}));

describe("sessions/[sessionId] delete registry fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbChain.select.mockReturnValue(dbChain);
    dbChain.from.mockReturnValue(dbChain);
    dbChain.where.mockReturnValue(dbChain);
  });

  it("cancels registry-backed chat activity when no db session exists", async () => {
    dbChain.get.mockReturnValue(undefined);
    cancelRegistryActivity.mockReturnValue(true);

    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/sessions/[sessionId]/route"
    );
    const response = await DELETE({} as never, {
      params: Promise.resolve({
        projectId: "proj-1",
        sessionId: "chat-activity-1",
      }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.cancelled).toBe(true);
    expect(cancelRegistryActivity).toHaveBeenCalledWith("chat-activity-1");
    expect(cancelProcess).not.toHaveBeenCalled();
    expect(markSessionCancelled).not.toHaveBeenCalled();
  });
});
