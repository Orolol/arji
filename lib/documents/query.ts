import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { isInternalMemoryDocKind } from "./memory-constants";

export type ProjectDocumentRecord = typeof documents.$inferSelect;

/**
 * The project's reference documents.
 *
 * The memory documents (live + pre-dream archive) share this table but are not
 * reference material: they are injected into every prompt by `memorySection()`
 * already, and this helper backs `@mention` resolution — so leaving them in
 * would let `@Project memory` resolve to a document and inject it a second
 * time. Filtered here, at the one boundary every mention path goes through.
 */
export function listProjectDocuments(projectId: string): ProjectDocumentRecord[] {
  return db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(documents.createdAt)
    .all()
    .filter((doc) => !isInternalMemoryDocKind(doc.kind));
}

export function listProjectTextDocuments(projectId: string): Array<{
  name: string;
  contentMd: string;
}> {
  return db
    .select({
      name: documents.originalFilename,
      contentMd: documents.markdownContent,
    })
    .from(documents)
    .where(
      and(eq(documents.projectId, projectId), eq(documents.kind, "text"))
    )
    .orderBy(documents.createdAt)
    .all()
    .map((row) => ({
      name: row.name,
      contentMd: row.contentMd || "",
    }));
}
