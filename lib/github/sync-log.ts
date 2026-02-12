import { db } from "@/lib/db";
import { gitSyncLog } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";

type SyncOperation =
  | "push"
  | "pull"
  | "fetch"
  | "pr_create"
  | "pr_sync"
  | "release_create"
  | "release_publish";

type SyncStatus = "success" | "failure";

/**
 * Logs a git/GitHub sync operation to the audit log.
 */
export function logSyncOperation(
  projectId: string,
  operation: SyncOperation,
  branch: string | null,
  status: SyncStatus,
  detail?: Record<string, unknown>
): void {
  db.insert(gitSyncLog)
    .values({
      id: createId(),
      projectId,
      operation,
      branch,
      status,
      detail: detail ? JSON.stringify(detail) : null,
      createdAt: new Date().toISOString(),
    })
    .run();
}
