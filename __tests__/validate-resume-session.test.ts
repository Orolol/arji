import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbGet = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: mockDbGet,
  };
  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  agentSessions: {
    id: "agentSessions.id",
    cliSessionId: "agentSessions.cliSessionId",
    claudeSessionId: "agentSessions.claudeSessionId",
    epicId: "agentSessions.epicId",
    userStoryId: "agentSessions.userStoryId",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));

import { validateResumeSession } from "@/lib/agent-sessions/validate-resume";

describe("validateResumeSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no resumeSessionId is provided", () => {
    const result = validateResumeSession({ resumeSessionId: undefined, epicId: "epic-1" });
    expect(result).toBeNull();
  });

  it("returns null when previous session is not found", () => {
    mockDbGet.mockReturnValue(null);
    const result = validateResumeSession({ resumeSessionId: "sess-1", epicId: "epic-1" });
    expect(result).toBeNull();
  });

  it("returns null when previous session has no cliSessionId", () => {
    mockDbGet.mockReturnValue({ cliSessionId: null, claudeSessionId: null, epicId: "epic-1", userStoryId: null });
    const result = validateResumeSession({ resumeSessionId: "sess-1", epicId: "epic-1" });
    expect(result).toBeNull();
  });

  it("returns cliSessionId when epicId matches (epic-scoped)", () => {
    mockDbGet.mockReturnValue({ cliSessionId: "cli-abc", claudeSessionId: null, epicId: "epic-1", userStoryId: null });
    const result = validateResumeSession({ resumeSessionId: "sess-1", epicId: "epic-1" });
    expect(result).toEqual({ cliSessionId: "cli-abc" });
  });

  it("returns null when epicId does not match", () => {
    mockDbGet.mockReturnValue({ cliSessionId: "cli-abc", claudeSessionId: null, epicId: "epic-2", userStoryId: null });
    const result = validateResumeSession({ resumeSessionId: "sess-1", epicId: "epic-1" });
    expect(result).toBeNull();
  });

  it("returns cliSessionId when userStoryId matches (story-scoped)", () => {
    mockDbGet.mockReturnValue({ cliSessionId: "cli-abc", claudeSessionId: null, epicId: "epic-1", userStoryId: "story-1" });
    const result = validateResumeSession({ resumeSessionId: "sess-1", epicId: "epic-1", userStoryId: "story-1" });
    expect(result).toEqual({ cliSessionId: "cli-abc" });
  });

  it("returns null when userStoryId does not match", () => {
    mockDbGet.mockReturnValue({ cliSessionId: "cli-abc", claudeSessionId: null, epicId: "epic-1", userStoryId: "story-2" });
    const result = validateResumeSession({ resumeSessionId: "sess-1", epicId: "epic-1", userStoryId: "story-1" });
    expect(result).toBeNull();
  });

  it("falls back to claudeSessionId when cliSessionId is null", () => {
    mockDbGet.mockReturnValue({ cliSessionId: null, claudeSessionId: "claude-xyz", epicId: "epic-1", userStoryId: null });
    const result = validateResumeSession({ resumeSessionId: "sess-1", epicId: "epic-1" });
    expect(result).toEqual({ cliSessionId: "claude-xyz" });
  });
});
