/**
 * The single answer to "can this project's upload actually be shown?".
 *
 * A bug ticket stores repo-relative paths in `epics.images`, and two sides
 * consult them: the route that serves the bytes, and the route that writes the
 * column in the first place. Both must agree, or a bug is created with a path
 * that renders as a broken thumbnail forever — so the rule lives here once and
 * neither side gets to re-implement it.
 *
 * Being *registered* is what makes a file servable: `POST /chat/upload` writes
 * the bytes and only then inserts the `chat_attachments` row, so a row is proof
 * the upload happened, and its recorded MIME type is proof of what it was. A
 * hand-written `epics.images` entry has neither.
 *
 * Server-only: `db`, `fs` and `process.cwd()`. The client-safe path rules stay
 * in `ticket-images.ts`, which this builds on.
 */

import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chatAttachments } from "@/lib/db/schema";
import { isAllowedImageMimeType } from "./image-attachments";
import { isServableUploadFileName, uploadsDirectoryFor } from "./ticket-images";

/**
 * Why a name cannot be served.
 *
 * `not-registered` covers everything indistinguishable from a fabricated
 * reference — an unusable name, no row, or a row whose type is not an image.
 * They are deliberately one reason: to a caller holding a path, the difference
 * is not actionable and reporting it would describe the database's contents.
 *
 * `missing-on-disk` is the one genuinely different case: the upload is on
 * record, but its bytes are gone (a wiped `data/` directory, say).
 */
export type UnservableUploadReason = "not-registered" | "missing-on-disk";

export type ServableUploadLookup =
  | {
      servable: true;
      /** `data/uploads/<projectId>/<file>`, as stored in `epics.images`. */
      relativePath: string;
      absolutePath: string;
      mimeType: string;
      /** Row id — the handle the staging UI holds for a pending upload. */
      attachmentId: string;
      /**
       * The ticket or chat message that already owns this upload, or `null`
       * when it is still staged.
       *
       * The serving route ignores this — a claimed upload is the normal case,
       * it is exactly what a bug's thumbnail points at. It matters to the two
       * sides that *take* ownership: filing a bug with an upload another
       * ticket already owns would make one ticket's delete take the other's
       * screenshot away, and discarding a claimed upload would do the same
       * from the staging UI.
       */
      claimedByEpicId: string | null;
      claimedByChatMessageId: string | null;
    }
  | { servable: false; reason: UnservableUploadReason };

/**
 * Resolves one of a project's upload file names to the bytes behind it.
 *
 * `fileName` is `unknown` on purpose: callers get it from a URL segment or
 * from a stored path, never from something already trusted. An unusable name
 * is refused before any query runs, so a crafted segment cannot even probe the
 * database.
 */
export function lookupServableUpload(
  projectId: string,
  fileName: unknown
): ServableUploadLookup {
  if (!isServableUploadFileName(fileName)) {
    return { servable: false, reason: "not-registered" };
  }

  const relativePath = `${uploadsDirectoryFor(projectId)}/${fileName}`;

  const attachment = db
    .select()
    .from(chatAttachments)
    .where(eq(chatAttachments.filePath, relativePath))
    .get();

  if (!attachment || !isAllowedImageMimeType(attachment.mimeType)) {
    return { servable: false, reason: "not-registered" };
  }

  const absolutePath = path.join(process.cwd(), relativePath);

  if (!fs.existsSync(absolutePath)) {
    return { servable: false, reason: "missing-on-disk" };
  }

  return {
    servable: true,
    relativePath,
    absolutePath,
    mimeType: attachment.mimeType,
    attachmentId: attachment.id,
    claimedByEpicId: attachment.epicId ?? null,
    claimedByChatMessageId: attachment.chatMessageId ?? null,
  };
}
