import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatAttachments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import path from "path";
import fs from "fs";

const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

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

  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type}. Allowed: png, jpg, jpeg, gif, webp` },
      { status: 400 }
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: 10MB` },
      { status: 400 }
    );
  }

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
      chatMessageId: null,
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
}
