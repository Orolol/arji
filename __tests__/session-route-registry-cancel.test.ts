import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const { cancelRegistryActivity, cancelProcess, markSessionCancelled } =
  vi.hoisted(() => ({
    cancelRegistryActivity: vi.fn(),
    cancelProcess: vi.fn(),
    markSessionCancelled: vi.fn(),
  }));

// Real drizzle-orm + real @/lib/db/schema; the shared chain mock ignores
// column identity, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    cancel: cancelProcess,
  },
}));

vi.mock("@/lib/activity-registry", () => ({
  activityRegistry: {
    // The route cancels through the project-scoped door: an id alone must not
    // reach an activity registered under another project.
    cancelInProject: cancelRegistryActivity,
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
    resetDbMockState();
  });

  it("cancels registry-backed chat activity when no db session exists", async () => {
    dbMockState.getQueue = [undefined];
    cancelRegistryActivity.mockReturnValue(true);

    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/sessions/[sessionId]/route"
    );
    const response = await DELETE(mockNextRequest(), mockRouteContext({ projectId: "proj-1", sessionId: "chat-activity-1" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.cancelled).toBe(true);
    expect(cancelRegistryActivity).toHaveBeenCalledWith(
      "chat-activity-1",
      "proj-1"
    );
    expect(cancelProcess).not.toHaveBeenCalled();
    expect(markSessionCancelled).not.toHaveBeenCalled();
  });
});
