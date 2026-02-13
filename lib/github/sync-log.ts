import { db } from "@/lib/db";
import { gitSyncLog } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";

export type GitSyncOperation = "detect" | "fetch" | "pull" | "push";
export type GitSyncStatus = "success" | "failed";

interface WriteGitSyncLogInput {
  projectId: string;
  operation: GitSyncOperation;
  status: GitSyncStatus;
  branch?: string | null;
  detail?: Record<string, unknown> | null;
}

export function writeGitSyncLog(input: WriteGitSyncLogInput): void {
  const now = new Date().toISOString();
  const detail = input.detail ? JSON.stringify(input.detail) : null;

  try {
    db.insert(gitSyncLog)
      .values({
        id: createId(),
        projectId: input.projectId,
        operation: input.operation,
        status: input.status,
        branch: input.branch ?? null,
        detail,
        createdAt: now,
      })
      .run();
  } catch (error) {
    console.warn("[git/sync-log] failed to write audit row", error);
  }
}
