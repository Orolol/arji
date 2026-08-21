import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatAttachments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { discardStagedUpload } from "@/lib/uploads/attachment-ownership";
import path from "path";
import fs from "fs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; attachmentId: string }> }
) {
  const { attachmentId } = await params;

  const attachment = db
    .select()
    .from(chatAttachments)
    .where(eq(chatAttachments.id, attachmentId))
    .get();

  if (!attachment) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const absolutePath = path.join(process.cwd(), attachment.filePath);

  if (!fs.existsSync(absolutePath)) {
    return NextResponse.json({ error: "File not found on disk" }, { status: 404 });
  }

  const fileBuffer = fs.readFileSync(absolutePath);

  return new NextResponse(fileBuffer, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(fileBuffer.length),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/**
 * Throws away a staged upload — the thumbnail removed before submitting, or
 * every thumbnail left when the form is abandoned.
 *
 * Only uploads nobody has claimed yet can go: once a chat message has been
 * sent with it or a bug filed with it, the file is that ticket's, and the
 * staging UI still holding its id is not a reason to delete it.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; attachmentId: string }> }
) {
  const { projectId, attachmentId } = await params;

  const outcome = discardStagedUpload(projectId, attachmentId);

  if (outcome === "not-found") {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  if (outcome === "claimed") {
    return NextResponse.json(
      { error: "Attachment is already attached to a ticket or message" },
      { status: 409 }
    );
  }

  return NextResponse.json({ data: { discarded: true } });
}
