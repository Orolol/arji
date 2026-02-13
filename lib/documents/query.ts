import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export type ProjectDocumentRecord = typeof documents.$inferSelect;

export function listProjectDocuments(projectId: string): ProjectDocumentRecord[] {
  return db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(documents.createdAt)
    .all();
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
