import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

// Real drizzle-orm + real @/lib/db/schema; the shared chain mock ignores
// column identity, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

import { validateResumeSession } from "@/lib/agent-sessions/validate-resume";

/** A stored session row, defaulting to the legacy Claude Code shape. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    cliSessionId: "cli-abc",
    claudeSessionId: null,
    epicId: "epic-1",
    userStoryId: null,
    ...overrides,
  };
}

describe("validateResumeSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("returns null when no resumeSessionId is provided", () => {
    const result = validateResumeSession({
      resumeSessionId: undefined,
      epicId: "epic-1",
      expectedProvider: "claude-code",
    });
    expect(result).toBeNull();
  });

  it("returns null when previous session is not found", () => {
    dbMockState.getQueue = [null];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "claude-code",
    });
    expect(result).toBeNull();
  });

  it("returns null when previous session has no cliSessionId", () => {
    dbMockState.getQueue = [row({ cliSessionId: null })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "claude-code",
    });
    expect(result).toBeNull();
  });

  it("returns cliSessionId when epicId matches (epic-scoped)", () => {
    dbMockState.getQueue = [row()];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "claude-code",
    });
    expect(result).toEqual({ cliSessionId: "cli-abc" });
  });

  it("returns null when epicId does not match", () => {
    dbMockState.getQueue = [row({ epicId: "epic-2" })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "claude-code",
    });
    expect(result).toBeNull();
  });

  it("returns cliSessionId when userStoryId matches (story-scoped)", () => {
    dbMockState.getQueue = [row({ userStoryId: "story-1" })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      userStoryId: "story-1",
      expectedProvider: "claude-code",
    });
    expect(result).toEqual({ cliSessionId: "cli-abc" });
  });

  it("returns null when userStoryId does not match", () => {
    dbMockState.getQueue = [row({ userStoryId: "story-2" })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      userStoryId: "story-1",
      expectedProvider: "claude-code",
    });
    expect(result).toBeNull();
  });

  it("falls back to claudeSessionId when cliSessionId is null", () => {
    dbMockState.getQueue = [
      row({ cliSessionId: null, claudeSessionId: "claude-xyz" }),
    ];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "claude-code",
    });
    expect(result).toEqual({ cliSessionId: "claude-xyz" });
  });

  it("treats a legacy row with no provider as claude-code", () => {
    dbMockState.getQueue = [row({ provider: null })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "claude-code",
    });
    expect(result).toEqual({ cliSessionId: "cli-abc" });
  });

  it("returns the cliSessionId of an oh-my-pi session with the id omp reported", () => {
    dbMockState.getQueue = [
      row({
        cliSessionId: "3f1c9a52-1b7e-4f21-9a6f-7b1c2d3e4f50",
        provider: "oh-my-pi",
      }),
    ];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "oh-my-pi",
    });
    expect(result).toEqual({
      cliSessionId: "3f1c9a52-1b7e-4f21-9a6f-7b1c2d3e4f50",
    });
  });

  it("returns null for a provider that cannot resume", () => {
    dbMockState.getQueue = [row({ provider: "codex" })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "codex",
    });
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Cross-provider guard: a stored id only means something to the CLI that
  // minted it, so a same-scope id from another provider must be refused.
  // ---------------------------------------------------------------------

  it("refuses a claude-code session id when launching oh-my-pi", () => {
    dbMockState.getQueue = [row({ cliSessionId: "cli-claude", provider: "claude-code" })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "oh-my-pi",
    });
    expect(result).toBeNull();
  });

  it("refuses an oh-my-pi session id when launching claude-code", () => {
    dbMockState.getQueue = [row({ cliSessionId: "cli-omp", provider: "oh-my-pi" })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "claude-code",
    });
    expect(result).toBeNull();
  });

  // Legacy rows from the removed pi provider must never resume into anything,
  // not even its oh-my-pi fork: pi is no longer resumable at all.
  it("refuses a legacy pi session id when launching oh-my-pi", () => {
    dbMockState.getQueue = [row({ cliSessionId: "cli-pi", provider: "pi" })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "oh-my-pi",
    });
    expect(result).toBeNull();
  });

  it("refuses a legacy claude-code row when launching another provider", () => {
    dbMockState.getQueue = [row({ provider: null })];
    const result = validateResumeSession({
      resumeSessionId: "sess-1",
      epicId: "epic-1",
      expectedProvider: "oh-my-pi",
    });
    expect(result).toBeNull();
  });
});
