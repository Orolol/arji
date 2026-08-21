import { NextRequest, NextResponse } from "next/server";
import { lookupServableUpload } from "@/lib/uploads/servable-uploads";
import fs from "fs";

/**
 * Serves one of a project's uploaded images by file name — how a bug ticket's
 * stored `data/uploads/<projectId>/<file>` paths become `<img>` sources.
 *
 * The chat reaches the same files through `/chat/uploads/<attachmentId>`, but
 * a bug stores paths rather than ids and the id is not recoverable from the
 * disk name (`<id>-<name>` where both halves may contain `-`), hence this
 * second entry point rather than a lookup the caller cannot perform.
 *
 * What is servable is decided by `lookupServableUpload()`, which the bug route
 * also writes against — so a path this returns 404 for cannot be stored on a
 * ticket in the first place.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; fileName: string }> }
) {
  const { projectId, fileName } = await params;

  const upload = lookupServableUpload(projectId, fileName);

  if (!upload.servable) {
    return NextResponse.json(
      {
        error:
          upload.reason === "missing-on-disk"
            ? "File not found on disk"
            : "Attachment not found",
      },
      { status: 404 }
    );
  }

  const fileBuffer = fs.readFileSync(upload.absolutePath);

  return new NextResponse(fileBuffer, {
    headers: {
      "Content-Type": upload.mimeType,
      "Content-Length": String(fileBuffer.length),
      // The name carries a nanoid, so the bytes behind a URL never change.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
