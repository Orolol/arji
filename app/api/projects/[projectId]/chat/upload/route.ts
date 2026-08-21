import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatAttachments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { errorResponse } from "@/lib/api/route-helpers";
import { imageUploadRejectionReason } from "@/lib/uploads/image-attachments";
import path from "path";
import fs from "fs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Same rules the attach UI enforces client-side — one source of truth, so
  // the two cannot drift apart.
  const rejectionReason = imageUploadRejectionReason(file);
  if (rejectionReason) {
    return NextResponse.json({ error: rejectionReason }, { status: 400 });
  }

  try {
    const uploadsDir = path.join(process.cwd(), "data", "uploads", projectId);
    fs.mkdirSync(uploadsDir, { recursive: true });

    const id = createId();
    const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const diskName = `${id}-${safeFileName}`;
    const filePath = path.join(uploadsDir, diskName);

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    const relativePath = `data/uploads/${projectId}/${diskName}`;

    db.insert(chatAttachments)
      .values({
        id,
        // Staged: no owner yet. Sending the chat message sets `chatMessageId`,
        // filing a bug with it sets `epicId`, and until one of those happens
        // the row is what lets the upload be discarded again. `projectId` is
        // known now and is what makes deleting the project reach these files.
        chatMessageId: null,
        projectId,
        epicId: null,
        fileName: file.name,
        filePath: relativePath,
        mimeType: file.type,
        sizeBytes: file.size,
        createdAt: new Date().toISOString(),
      })
      .run();

    return NextResponse.json(
      {
        data: {
          id,
          fileName: file.name,
          filePath: relativePath,
          mimeType: file.type,
          sizeBytes: file.size,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error, "Failed to save attachment.");
  }
}
