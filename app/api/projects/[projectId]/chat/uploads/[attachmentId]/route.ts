import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatAttachments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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
