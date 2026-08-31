import { db } from "@/lib/db";
import { gitSyncLog } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { eq, desc } from "drizzle-orm";

export type GitSyncOperation =
  | "clone"
  | "detect"
  | "fetch"
  | "pull"
  | "push"
  | "pr_create"
  | "pr_sync"
  | "release"
  | "tag_push"
  | "issues_sync"
  // App-managed clone lifecycle (lib/git/clone.ts, lib/projects/clone-cleanup.ts).
  | "clone_removed";

export type GitSyncStatus = "success" | "failed" | "failure";

interface LogSyncOperationInput {
  /**
   * Null for operations that happen before the project exists — a first-time
   * clone is audited while the import is still deciding what to create.
   */
  projectId: string | null;
  operation: GitSyncOperation;
  status: GitSyncStatus;
  branch?: string | null;
  detail?: string | Record<string, unknown> | null;
}

/**
 * `git_sync_log.project_id` carries the table's only foreign key, so a
 * violation on this insert can mean exactly one thing: the referenced project
 * row is gone. That happens on a routine race — the audit row is written after
 * the git command returns, so a project deleted while a push/pull is in flight
 * lands between the two.
 */
function isDeletedProjectViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY"
  );
}

/**
 * The retained row loses its project link, so the deleted id is folded into
 * the detail payload — without it an orphaned row is indistinguishable from a
 * pre-project clone audit, which legitimately carries a null `projectId`.
 */
function orphanedDetail(
  detail: string | null,
  deletedProjectId: string
): string {
  return JSON.stringify({ deletedProjectId, detail });
}

export function logSyncOperation(input: LogSyncOperationInput): void {
  const now = new Date().toISOString();
  const detail =
    input.detail == null
      ? null
      : typeof input.detail === "string"
        ? input.detail
        : JSON.stringify(input.detail);

  const id = createId();
  const row = {
    id,
    projectId: input.projectId ?? null,
    operation: input.operation,
    status: input.status,
    branch: input.branch ?? null,
    detail,
    createdAt: now,
  };

  try {
    db.insert(gitSyncLog).values(row).run();
  } catch (error) {
    // Chosen behaviour for the deleted-project race: RETAIN, don't skip. The
    // operation really happened and the spec makes `git_sync_log` the record of
    // it, so the row is rewritten with a null `projectId` (the column is
    // already nullable for pre-project operations) rather than dropped. It is
    // then invisible to `getRecentSyncLogs`, which is correct — the project it
    // belonged to no longer exists — but the trail keeps the entry.
    if (input.projectId != null && isDeletedProjectViolation(error)) {
      try {
        db.insert(gitSyncLog)
          .values({
            ...row,
            projectId: null,
            detail: orphanedDetail(detail, input.projectId),
          })
          .run();
        console.debug(
          "[git/sync-log] project deleted mid-operation; audit row retained without project link",
          { operation: input.operation, deletedProjectId: input.projectId }
        );
      } catch (retentionError) {
        console.error(
          "[git/sync-log] failed to retain orphaned audit row",
          retentionError
        );
      }
      return;
    }

    console.error("[git/sync-log] failed to write audit row", error);
  }
}

/** Alias kept for backward compat with main's naming */
export const writeGitSyncLog = logSyncOperation;

export function getRecentSyncLogs(projectId: string, limit = 50) {
  return db
    .select()
    .from(gitSyncLog)
    .where(eq(gitSyncLog.projectId, projectId))
    .orderBy(desc(gitSyncLog.createdAt))
    .limit(limit)
    .all();
}
