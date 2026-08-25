import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { isInternalMemoryDocKind } from "@/lib/documents/memory-constants";
import fs from "fs";
import path from "path";

type Params = {
  params: Promise<{ projectId: string; documentId: string }>;
};

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { projectId, documentId } = await params;

  const doc = db
    .select()
    .from(documents)
    .where(
      and(eq(documents.id, documentId), eq(documents.projectId, projectId))
    )
    .get();

  if (!doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  // The learned memory and its pre-dream snapshot are not uploads: the memory
  // card owns the live one and the archive exists precisely to survive a bad
  // rewrite. Neither is listed by GET, so reaching here means a hand-made
  // request — refuse it rather than let it through the generic delete path.
  if (isInternalMemoryDocKind(doc.kind)) {
    return NextResponse.json(
      {
        error:
          "The project memory is managed from the memory card, not the documents list.",
      },
      { status: 400 }
    );
  }

  if (doc.kind === "image" && doc.imagePath) {
    const absolutePath = path.join(process.cwd(), doc.imagePath);
    if (fs.existsSync(absolutePath)) {
      try {
        fs.unlinkSync(absolutePath);
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? `Failed to remove image file: ${error.message}`
                : "Failed to remove image file",
          },
          { status: 500 }
        );
      }
    }
  }

  db.delete(documents).where(eq(documents.id, documentId)).run();

  return NextResponse.json({ data: { deleted: true, id: documentId } });
}
