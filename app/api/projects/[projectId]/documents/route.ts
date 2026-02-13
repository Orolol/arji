import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { convertToMarkdown } from "@/lib/converters";
import path from "path";
import fs from "fs";

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
]);

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

type DocumentKind = "text" | "image";

function resolveDocumentKind(file: File): DocumentKind {
  if (IMAGE_MIME_TYPES.has(file.type) || file.type.startsWith("image/")) {
    return "image";
  }
  return "text";
}

function safeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildImageStoragePath(projectId: string, id: string, fileName: string): {
  absolutePath: string;
  relativePath: string;
} {
  const dir = path.join(process.cwd(), "data", "documents", projectId);
  fs.mkdirSync(dir, { recursive: true });
  const diskName = `${id}-${safeFileName(fileName)}`;
  const relativePath = path.join("data", "documents", projectId, diskName);
  const absolutePath = path.join(process.cwd(), relativePath);
  return { absolutePath, relativePath };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const result = db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(documents.createdAt)
    .all();

  return NextResponse.json({ data: result });
}

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

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      {
        error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: 20MB`,
      },
      { status: 400 }
    );
  }

  const duplicate = db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.projectId, projectId),
        sql`LOWER(${documents.originalFilename}) = LOWER(${file.name})`
      )
    )
    .get();
  if (duplicate) {
    return NextResponse.json(
      { error: `A document named "${file.name}" already exists in this project.` },
      { status: 409 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  const kind = resolveDocumentKind(file);
  const id = createId();
  const now = new Date().toISOString();

  let markdownContent: string | null = null;
  let imagePath: string | null = null;

  if (kind === "text") {
    try {
      markdownContent = await convertToMarkdown(buffer, mimeType, file.name);
    } catch (e) {
      return NextResponse.json(
        { error: `Conversion failed: ${e instanceof Error ? e.message : "Unknown error"}` },
        { status: 400 }
      );
    }
  } else {
    try {
      const { absolutePath, relativePath } = buildImageStoragePath(projectId, id, file.name);
      fs.writeFileSync(absolutePath, buffer);
      imagePath = relativePath;
    } catch (e) {
      return NextResponse.json(
        { error: `Image storage failed: ${e instanceof Error ? e.message : "Unknown error"}` },
        { status: 500 }
      );
    }
  }

  db.insert(documents)
    .values({
      id,
      projectId,
      originalFilename: file.name,
      kind,
      markdownContent,
      imagePath,
      mimeType,
      sizeBytes: file.size,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const doc = db.select().from(documents).where(eq(documents.id, id)).get();
  return NextResponse.json({ data: doc }, { status: 201 });
}
