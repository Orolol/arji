import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDbChainMock,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

// Real drizzle-orm + real schema; the shared chain mock ignores column
// identity. `sqlite` keeps the local stub (lifecycle only uses `db`).
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return {
    ...dbModuleMock(),
    sqlite: {
      prepare: vi.fn(),
      transaction: vi.fn(),
    },
  };
});

import {
  buildSessionTransitionPatch,
  transitionSessionStatus,
} from "@/lib/agent-sessions/lifecycle";

function tmpLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-failmsg-"));
  return path.join(dir, "logs.json");
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMockState();
});

describe("buildSessionTransitionPatch — failed session error synthesis", () => {
  it("synthesizes the explicit no-output message when the caller brings no error", () => {
    const patch = buildSessionTransitionPatch(
      {
        id: "s1",
        status: "running",
        startedAt: null,
        endedAt: null,
        completedAt: null,
        lastNonEmptyText: null,
        logsPath: "/tmp/logs.json",
      },
      "failed",
      "2026-02-12T00:01:00.000Z",
      null
    );

    expect(patch.error).toBeDefined();
    expect(patch.error).toMatch(/failed without any error message and without any output/i);
    expect(patch.error).toContain("/tmp/logs.json");
    // Never a bare label anymore.
    expect(patch.error).not.toBe("Agent error");
    expect(patch.error).not.toBe("Unknown error");
  });

  it("uses the had-output wording when the session captured text before failing", () => {
    const patch = buildSessionTransitionPatch(
      {
        id: "s2",
        status: "running",
        startedAt: null,
        endedAt: null,
        completedAt: null,
        lastNonEmptyText: "Analyzing the codebase…",
        logsPath: null,
      },
      "failed",
      "2026-02-12T00:01:00.000Z",
      undefined
    );

    expect(patch.error).toMatch(/did produce output/i);
    expect(patch.error).toMatch(/session view/i);
  });

  it("keeps a caller-provided error verbatim (real stderr stays the message)", () => {
    const patch = buildSessionTransitionPatch(
      {
        id: "s3",
        status: "running",
        startedAt: null,
        endedAt: null,
        completedAt: null,
      },
      "failed",
      "2026-02-12T00:01:00.000Z",
      "Claude CLI exited with code 1"
    );

    expect(patch.error).toBe("Claude CLI exited with code 1");
  });

  it("does not synthesize for completed or cancelled transitions", () => {
    const base = {
      id: "s4",
      status: "running",
      startedAt: null,
      endedAt: null,
      completedAt: null,
    };

    const completed = buildSessionTransitionPatch(
      base,
      "completed",
      "2026-02-12T00:01:00.000Z",
      null
    );
    expect(completed.error).toBeNull();

    const cancelled = buildSessionTransitionPatch(
      base,
      "cancelled",
      "2026-02-12T00:01:00.000Z",
      undefined
    );
    expect(cancelled.error).toBeUndefined();
  });

  it("works for hand-built snapshots without the new optional fields", () => {
    const patch = buildSessionTransitionPatch(
      { id: "s5", status: "running", startedAt: null, endedAt: null, completedAt: null },
      "failed",
      "2026-02-12T00:01:00.000Z",
      null
    );
    expect(patch.error).toMatch(/failed without any error message and without any output/i);
  });
});

describe("transitionSessionStatus — log backstop for silent failures", () => {
  it("writes the missing log file with the synthesized error for a failed session", () => {
    const logsPath = tmpLogPath();
    getDbChainMock().get.mockReturnValue({
      id: "s6",
      status: "running",
      startedAt: null,
      endedAt: null,
      completedAt: null,
      lastNonEmptyText: null,
      logsPath,
      projectId: "p1",
    });

    transitionSessionStatus({
      sessionId: "s6",
      toStatus: "failed",
      error: null,
      at: "2026-02-12T00:01:00.000Z",
    });

    expect(fs.existsSync(logsPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(logsPath, "utf8"));
    expect(record.success).toBe(false);
    expect(record.error).toMatch(/failed without any error message and without any output/i);
  });

  it("never overwrites a log file the dispatch route already wrote", () => {
    const logsPath = tmpLogPath();
    fs.writeFileSync(logsPath, JSON.stringify({ success: false, error: "real stderr here", duration: 10 }));
    getDbChainMock().get.mockReturnValue({
      id: "s7",
      status: "running",
      startedAt: null,
      endedAt: null,
      completedAt: null,
      lastNonEmptyText: null,
      logsPath,
      projectId: "p1",
    });

    transitionSessionStatus({
      sessionId: "s7",
      toStatus: "failed",
      error: "real stderr here",
      at: "2026-02-12T00:01:00.000Z",
    });

    const record = JSON.parse(fs.readFileSync(logsPath, "utf8"));
    expect(record.error).toBe("real stderr here");
  });

  it("skips the backstop when the session has no logsPath", () => {
    getDbChainMock().get.mockReturnValue({
      id: "s8",
      status: "running",
      startedAt: null,
      endedAt: null,
      completedAt: null,
      lastNonEmptyText: null,
      logsPath: null,
      projectId: "p1",
    });

    const patch = transitionSessionStatus({
      sessionId: "s8",
      toStatus: "failed",
      error: null,
      at: "2026-02-12T00:01:00.000Z",
    });
    expect(patch.error).toMatch(/failed without any error message and without any output/i);
  });

  it("does not backfill for cancelled sessions even when the log is missing", () => {
    const logsPath = tmpLogPath();
    getDbChainMock().get.mockReturnValue({
      id: "s9",
      status: "running",
      startedAt: null,
      endedAt: null,
      completedAt: null,
      lastNonEmptyText: null,
      logsPath,
      projectId: "p1",
    });

    transitionSessionStatus({
      sessionId: "s9",
      toStatus: "cancelled",
      error: "Cancelled by user",
      at: "2026-02-12T00:01:00.000Z",
    });

    expect(fs.existsSync(logsPath)).toBe(false);
  });
});