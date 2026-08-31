/**
 * The deleted-project race on the git audit trail.
 *
 * `POST /api/projects/:id/git/push` writes its `git_sync_log` row AFTER the
 * git command returns, so a `DELETE /api/projects/:id` that lands while the
 * push is still in flight leaves the audit insert pointing at a row that no
 * longer exists — `git_sync_log.project_id` then rejects it with
 * `SQLITE_CONSTRAINT_FOREIGNKEY`. The trail must not lose the operation, and
 * the warning must not read the same as a genuinely broken audit table.
 *
 * These tests drive the real schema through `createTestDb()` (foreign keys ON,
 * full migration chain) so the FK violation is the production one, not a
 * hand-built error object standing in for it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const dbModule = (await import("@/lib/db")) as unknown as {
  db: typeof import("@/lib/db").db;
  sqlite: import("better-sqlite3").Database;
};
const { db, sqlite } = dbModule;
const { projects, gitSyncLog } = await import("@/lib/db/schema");
const { logSyncOperation } = await import("@/lib/github/sync-log");

const PROJECT_ID = "proj-race";

function seedProject(): void {
  db.insert(projects)
    .values({ id: PROJECT_ID, name: "Race", gitRepoPath: "/tmp/race" })
    .run();
}

/** The DELETE that lands while the git command is still running. */
function deleteProject(): void {
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function allLogRows() {
  return db.select().from(gitSyncLog).all();
}

/**
 * Forces every `git_sync_log` insert to throw, one error per attempt (the last
 * error repeats). Used only for the "the retention insert ALSO fails" branch,
 * which cannot be produced by a real database: the retained row is exactly the
 * one shape SQLite always accepts.
 */
function withFailingInserts(errors: unknown[], work: () => void): void {
  const original = sqlite.prepare.bind(sqlite);
  let attempt = 0;

  sqlite.prepare = ((source: string) => {
    const statement = original(source);
    if (!/insert into "git_sync_log"/i.test(source)) return statement;
    Object.defineProperty(statement, "run", {
      configurable: true,
      value: () => {
        throw errors[Math.min(attempt++, errors.length - 1)];
      },
    });
    return statement;
  }) as typeof sqlite.prepare;

  try {
    work();
  } finally {
    sqlite.prepare = original;
  }
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let debug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sqlite.exec("DELETE FROM git_sync_log; DELETE FROM projects;");
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  debug = vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logSyncOperation when the project is deleted mid-operation", () => {
  it("retains the audit row instead of dropping it on the FK violation", () => {
    seedProject();
    deleteProject();

    logSyncOperation({
      projectId: PROJECT_ID,
      operation: "push",
      status: "success",
      branch: "main",
      detail: { remote: "origin", pushed: 3 },
    });

    const rows = allLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        projectId: null,
        operation: "push",
        status: "success",
        branch: "main",
      })
    );
    // The project link is gone, so the deleted id lives in the detail payload —
    // otherwise the retained row is indistinguishable from a pre-project clone.
    expect(JSON.parse(String(rows[0].detail))).toEqual({
      deletedProjectId: PROJECT_ID,
      detail: JSON.stringify({ remote: "origin", pushed: 3 }),
    });
  });

  it("does not emit the generic FOREIGN KEY warning for the race", () => {
    seedProject();
    deleteProject();

    logSyncOperation({
      projectId: PROJECT_ID,
      operation: "pull",
      status: "failed",
      detail: "non-fast-forward",
    });

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0][0])).toMatch(/deleted/i);
  });

  it("still links the row to its project when the project survives", () => {
    seedProject();

    logSyncOperation({
      projectId: PROJECT_ID,
      operation: "push",
      status: "success",
      branch: "main",
      detail: { remote: "origin" },
    });

    const rows = allLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe(PROJECT_ID);
    expect(JSON.parse(String(rows[0].detail))).toEqual({ remote: "origin" });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });
});

describe("logSyncOperation on a genuine audit-write failure", () => {
  it("logs loudly and distinguishably when the audit table is broken", () => {
    seedProject();
    sqlite.exec('ALTER TABLE git_sync_log RENAME TO git_sync_log_hidden');

    try {
      logSyncOperation({
        projectId: PROJECT_ID,
        operation: "push",
        status: "success",
        branch: "main",
      });
    } finally {
      sqlite.exec('ALTER TABLE git_sync_log_hidden RENAME TO git_sync_log');
    }

    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0][0]);
    expect(message).toMatch(/failed to write audit row/i);
    expect(message).not.toMatch(/deleted/i);
    expect(debug).not.toHaveBeenCalled();
  });

  it("logs loudly when retaining the orphaned row also fails", () => {
    const foreignKey = Object.assign(
      new Error("FOREIGN KEY constraint failed"),
      { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }
    );
    const broken = new Error("database is locked");

    withFailingInserts([foreignKey, broken], () => {
      logSyncOperation({
        projectId: PROJECT_ID,
        operation: "push",
        status: "failed",
        branch: "main",
      });
    });

    expect(allLogRows()).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(/audit row/i);
    expect(error.mock.calls[0]).toContain(broken);
  });
});
