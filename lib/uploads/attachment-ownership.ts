/**
 * The lifecycle of an uploaded file: who claims it, and what removes it.
 *
 * `POST /chat/upload` writes bytes to `data/uploads/<projectId>/<file>` and a
 * `chat_attachments` row. Until 0030 that row had a single relation — the chat
 * message it was sent with — so a bug screenshot, which is referenced only by
 * path from `epics.images`, was owned by nothing: every screenshot ever
 * attached stayed on disk forever, including the ones removed before the
 * report was even filed.
 *
 * Ownership now has three states, and each one answers a different question:
 *
 * | `chat_message_id` | `epic_id` | meaning                  | may be discarded |
 * |-------------------|-----------|--------------------------|------------------|
 * | NULL              | NULL      | staged in an open form   | yes              |
 * | set               | NULL      | sent in a chat message   | no               |
 * | NULL              | set       | filed as a bug's shot    | no               |
 *
 * `project_id` is orthogonal and always set: it is what makes deleting a
 * project take its uploads with it, whichever of the three states they are in.
 *
 * Rows are removed by the FK cascade. Bytes are not — SQLite cannot unlink a
 * file — so the delete paths read the paths *before* the row disappears and
 * unlink them *after* the transaction commits. Doing it the other way round
 * would delete a screenshot for a ticket delete that then rolled back.
 *
 * Server-only: `db`, `fs`, and the absolute paths `upload-paths.ts` builds.
 */

import fs from "fs";
import path from "path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, type ArijDatabase } from "@/lib/db";
import { chatAttachments } from "@/lib/db/schema";
import { uploadsDirectoryFor } from "./ticket-images";
import {
  projectUploadsDirectory,
  storedUploadAbsolutePath,
  uploadsRoot,
} from "./upload-paths";

/**
 * The subset of the database a claim needs. Typed as the `update` method
 * rather than the whole handle so a transaction (`db.transaction((tx) => …)`)
 * satisfies it — claiming has to happen inside the same transaction as the
 * insert that justifies it.
 */
type UpdateCapable = Pick<ArijDatabase, "update">;

/** Raised when the uploads a claim was about to take are no longer free. */
export class UploadClaimConflictError extends Error {
  constructor(message = "Screenshot is already attached to another ticket") {
    super(message);
    this.name = "UploadClaimConflictError";
  }
}

/**
 * Unlinks stored upload paths, skipping anything already gone.
 *
 * A missing file is not an error worth propagating: the row is what makes the
 * upload exist, and it is being deleted either way. Returns how many files
 * were actually removed.
 *
 * `file_path` is written by the upload route and never by a request, but this
 * is the one place that turns a database string into `fs.unlink`, so it is
 * checked rather than trusted: `storedUploadAbsolutePath` refuses anything not
 * genuinely under `data/uploads/`, whatever the column happens to hold. The
 * routes that serve and prompt with the same column read the rule from there
 * too.
 */
export function removeUploadFiles(relativePaths: readonly string[]): number {
  let removed = 0;

  for (const relativePath of relativePaths) {
    const absolute = storedUploadAbsolutePath(relativePath);
    if (!absolute) continue;

    try {
      fs.unlinkSync(absolute);
      removed++;
    } catch {
      // Already gone, or never written.
    }
  }

  return removed;
}

/** Stored paths of every upload a ticket owns, for deletion after the fact. */
export function ticketUploadPaths(epicId: string): string[] {
  return db
    .select({ filePath: chatAttachments.filePath })
    .from(chatAttachments)
    .where(eq(chatAttachments.epicId, epicId))
    .all()
    .map((row) => row.filePath);
}

/**
 * Hands a ticket the uploads it was created with.
 *
 * Only *unclaimed* rows are taken, and the count is checked: the caller has
 * already verified each path is servable and free, but that check and this
 * update are two statements, and between them a concurrent bug creation may
 * have claimed the same upload. Fewer rows than paths means exactly that, and
 * throwing here rolls back the ticket rather than filing it with a screenshot
 * that belongs to something else.
 *
 * `projectId` is written too, not just matched: it heals rows uploaded before
 * 0030 that the backfill could not attribute, and the paths were already
 * verified to live under this project's upload directory.
 */
export function claimUploadsForTicket(
  runner: UpdateCapable,
  projectId: string,
  epicId: string,
  filePaths: readonly string[]
): void {
  // Deduplicated because the count check compares rows to paths: the same
  // screenshot listed twice is one row, and that is not a conflict.
  const distinctPaths = [...new Set(filePaths)];
  if (distinctPaths.length === 0) return;

  const result = runner
    .update(chatAttachments)
    .set({ epicId, projectId })
    .where(
      and(
        inArray(chatAttachments.filePath, distinctPaths),
        isNull(chatAttachments.epicId),
        isNull(chatAttachments.chatMessageId)
      )
    )
    .run();

  if (result.changes !== distinctPaths.length) {
    throw new UploadClaimConflictError();
  }
}

export type DiscardStagedUploadResult = "discarded" | "not-found" | "claimed";

/**
 * Deletes an upload that is still staged — the thumbnail removed before
 * submitting, or the whole strip when the form is abandoned.
 *
 * Refuses anything already claimed by a ticket or a chat message. The staging
 * UI holds an attachment id for as long as the form is open, and a bug filed
 * from that form does not make the id stop existing; without this check a
 * stale client could delete the screenshot of a report it just created.
 *
 * Scoped by project, so an id from another project reads as absent rather than
 * as something this caller is not allowed to touch.
 */
export function discardStagedUpload(
  projectId: string,
  attachmentId: string
): DiscardStagedUploadResult {
  const attachment = db
    .select()
    .from(chatAttachments)
    .where(eq(chatAttachments.id, attachmentId))
    .get();

  if (!attachment) return "not-found";

  // Rows uploaded before 0030 may carry no project_id; the path they were
  // written to says the same thing, so fall back to it rather than refusing to
  // clean up the very rows that motivated the column.
  const belongsToProject = attachment.projectId
    ? attachment.projectId === projectId
    : attachment.filePath.startsWith(`${uploadsDirectoryFor(projectId)}/`);

  if (!belongsToProject) return "not-found";

  if (attachment.epicId !== null || attachment.chatMessageId !== null) {
    return "claimed";
  }

  db.delete(chatAttachments).where(eq(chatAttachments.id, attachmentId)).run();
  removeUploadFiles([attachment.filePath]);

  return "discarded";
}

export interface ProjectUploadCleanup {
  rowsDeleted: number;
  directoryRemoved: boolean;
}

/**
 * Removes every upload a project owns, rows and bytes, before the project row
 * itself goes.
 *
 * The whole `data/uploads/<projectId>` directory is removed rather than each
 * recorded file in turn: a project delete is the one moment where nothing
 * under it can still be wanted, and it is also the only thing that reaches
 * bytes whose row was already lost — a chat message deleted long ago cascaded
 * its attachment row away and left the file behind.
 */
export function deleteProjectUploads(projectId: string): ProjectUploadCleanup {
  const rows = db
    .select({ id: chatAttachments.id })
    .from(chatAttachments)
    .where(eq(chatAttachments.projectId, projectId))
    .all();

  if (rows.length > 0) {
    db.delete(chatAttachments)
      .where(eq(chatAttachments.projectId, projectId))
      .run();
  }

  const directory = projectUploadsDirectory(projectId);
  let directoryRemoved = false;

  // Guarded the same way single files are: a project id that somehow escaped
  // its own directory must not turn this into a recursive delete elsewhere.
  const relativeToRoot = path.relative(uploadsRoot(), directory);
  const insideUploads =
    relativeToRoot.length > 0 &&
    !relativeToRoot.startsWith("..") &&
    !path.isAbsolute(relativeToRoot);

  if (insideUploads && fs.existsSync(directory)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      directoryRemoved = true;
    } catch (error) {
      console.error(
        `[attachment-ownership] Failed to remove uploads for ${projectId}:`,
        error
      );
    }
  }

  return { rowsDeleted: rows.length, directoryRemoved };
}
