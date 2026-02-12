import { describe, expect, it, vi } from "vitest";
import {
  backfillRecentSessionLastNonEmptyText,
  extractLastNonEmptyFromLogPayload,
} from "@/lib/agent-sessions/backfill";

function createBackfillDbMock(
  sessions: Array<{ id: string; logsPath: string | null }>
) {
  const updateRun = vi.fn();
  const updateWhere = vi.fn().mockReturnValue({ run: updateRun });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  const all = vi.fn().mockReturnValue(sessions);
  const limit = vi.fn().mockReturnValue({ all });
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  return {
    db: {
      select,
      update,
    } as never,
    spies: {
      updateSet,
      updateWhere,
      updateRun,
    },
  };
}

describe("session lastNonEmptyText backfill", () => {
  it("extracts the last non-empty line from log payload result", () => {
    const extracted = extractLastNonEmptyFromLogPayload({
      result: "line one\n\n  final line  \n",
    });
    expect(extracted).toBe("final line");
  });

  it("backfills recent sessions when source logs exist", () => {
    const { db, spies } = createBackfillDbMock([
      { id: "s1", logsPath: "/tmp/s1.json" },
    ]);
    const existsSync = vi.fn(() => true);
    const readFileSync = vi.fn(() =>
      JSON.stringify({ result: "doing work\n\n latest non-empty  " })
    );

    const result = backfillRecentSessionLastNonEmptyText(
      { projectId: "proj-1", limit: 50 },
      {
        db,
        existsSync: existsSync as never,
        readFileSync: readFileSync as never,
      }
    );

    expect(result).toMatchObject({
      scanned: 1,
      backfilled: 1,
      skippedNoLogs: 0,
      skippedNoText: 0,
      errors: 0,
    });
    expect(spies.updateSet).toHaveBeenCalledWith({
      lastNonEmptyText: "latest non-empty",
    });
  });

  it("skips sessions that cannot be backfilled without throwing", () => {
    const { db, spies } = createBackfillDbMock([
      { id: "s2", logsPath: null },
      { id: "s3", logsPath: "/tmp/s3.json" },
      { id: "s4", logsPath: "/tmp/s4.json" },
    ]);
    const existsSync = vi.fn((path: string) => path !== "/tmp/s3.json");
    const readFileSync = vi.fn((path: string) => {
      if (path === "/tmp/s4.json") {
        return JSON.stringify({ result: "   \n\t" });
      }
      return "{invalid json";
    });

    const result = backfillRecentSessionLastNonEmptyText(
      {},
      {
        db,
        existsSync: existsSync as never,
        readFileSync: readFileSync as never,
      }
    );

    expect(result).toMatchObject({
      scanned: 3,
      backfilled: 0,
      skippedNoLogs: 2,
      skippedNoText: 1,
      errors: 0,
    });
    expect(spies.updateSet).not.toHaveBeenCalled();
  });
});
