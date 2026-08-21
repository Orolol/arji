import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics } from "@/lib/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { tryExportArjiJson } from "@/lib/sync/export";
import { uploadFileNameFromPath } from "@/lib/uploads/ticket-images";
import { lookupServableUpload } from "@/lib/uploads/servable-uploads";
import {
  UploadClaimConflictError,
  claimUploadsForTicket,
} from "@/lib/uploads/attachment-ownership";
import {
  getEpicOr404,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { createBugSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";

/**
 * `images` is stored verbatim as JSON and read back by the ticket panel, which
 * displays a path only if the uploads route will serve it. Accepting anything
 * else would leave the column holding a reference that renders as a broken
 * thumbnail and points an agent at a file that is not there — so the write side
 * is held to exactly what the read side can serve, by asking the read side.
 *
 * A well-formed path is not enough: `data/uploads/<projectId>/never-uploaded.png`
 * has the right shape and no bytes behind it. Only a registered upload passes.
 *
 * An upload another ticket or chat message already owns is refused too. Since
 * 0030 an upload has exactly one owner, and deleting that owner deletes the
 * file — so letting two tickets share one row would make deleting either of
 * them silently blank the other's screenshot.
 *
 * The schema has already established this is an array of strings; what is left
 * needs the database and the disk.
 */
function invalidImagesReason(
  images: readonly string[],
  projectId: string
): string | null {
  for (const image of images) {
    const fileName = uploadFileNameFromPath(image, projectId);
    if (fileName === null) {
      return `Not an upload of this project: ${JSON.stringify(image)}`;
    }

    const upload = lookupServableUpload(projectId, fileName);
    if (!upload.servable) {
      return upload.reason === "missing-on-disk"
        ? `Upload is no longer on disk: ${JSON.stringify(image)}`
        : `No such upload: ${JSON.stringify(image)}`;
    }

    if (upload.claimedByEpicId || upload.claimedByChatMessageId) {
      return `Screenshot is already attached elsewhere: ${JSON.stringify(image)}`;
    }
  }

  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(createBugSchema, request);
  if (isValidationError(validated)) return validated;
  const body = validated.data;

  // Before the insert, not after the foreign key throws: an unknown project is
  // a 404 with the standard envelope, not a 500 carrying a SQLite message.
  const foundProject = getProjectOr404(projectId);
  if (isErrorResponse(foundProject)) return foundProject;

  // Scoped lookup, so a bug cannot be linked to an epic of another project —
  // the id alone is not evidence the caller may reference it.
  if (body.linkedEpicId) {
    const foundEpic = getEpicOr404(projectId, body.linkedEpicId);
    if (isErrorResponse(foundEpic)) return foundEpic;
  }

  const images = body.images ?? null;
  if (images) {
    const imagesError = invalidImagesReason(images, projectId);
    if (imagesError) {
      return NextResponse.json({ error: imagesError }, { status: 400 });
    }
  }

  const now = new Date().toISOString();

  const maxPos = db
    .select({ max: sql<number>`COALESCE(MAX(position), -1)` })
    .from(epics)
    .where(and(eq(epics.projectId, projectId), eq(epics.status, "backlog")))
    .get();

  const id = createId();

  try {
    // One transaction so the ticket and its claim on the screenshots stand or
    // fall together: a bug whose images column names uploads it does not own
    // is a ticket whose thumbnails another delete can take away.
    db.transaction((tx) => {
      tx.insert(epics)
        .values({
          id,
          projectId,
          title: body.title,
          // Already trimmed by the schema, so `""` here means "not provided".
          description: body.description || null,
          priority: body.priority ?? 2,
          status: "backlog",
          position: (maxPos?.max ?? -1) + 1,
          type: "bug",
          linkedEpicId: body.linkedEpicId || null,
          images: images ? JSON.stringify(images) : null,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      if (images) {
        claimUploadsForTicket(tx, projectId, id, images);
      }
    });
  } catch (error) {
    if (error instanceof UploadClaimConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Fixed message, like the epic route: whatever SQLite says about a
    // constraint is for the log, not for the reporter's modal.
    console.error("[bugs/POST] Failed to create bug:", error);
    return NextResponse.json({ error: "Failed to create bug" }, { status: 500 });
  }

  const bug = db.select().from(epics).where(eq(epics.id, id)).get();
  tryExportArjiJson(projectId);
  return NextResponse.json({ data: bug }, { status: 201 });
}
