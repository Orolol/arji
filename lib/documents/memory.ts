/**
 * Learned project memory — storage helpers.
 *
 * One memory document per project, stored in the existing `documents` table
 * with `kind = 'memory'` (see lib/documents/memory-constants.ts for why that
 * discriminator). Content is markdown, hard-capped at
 * PROJECT_MEMORY_MAX_CHARS on every write.
 */

import { and, eq } from "drizzle-orm";
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import {
  MEMORY_ARCHIVE_DOC_FILENAME,
  MEMORY_ARCHIVE_DOC_KIND,
  MEMORY_DOC_FILENAME,
  MEMORY_DOC_KIND,
  PROJECT_MEMORY_MAX_CHARS,
} from "./memory-constants";

export type MemoryDocRecord = typeof documents.$inferSelect;

/** Truncates content to the hard cap (no-op when already under it). */
export function enforceMemoryCap(content: string): string {
  if (content.length <= PROJECT_MEMORY_MAX_CHARS) return content;
  return content.slice(0, PROJECT_MEMORY_MAX_CHARS);
}

/** The project's memory document row, or null when none exists yet. */
export function getProjectMemoryDoc(
  projectId: string,
  database: ArijDatabase = defaultDb
): MemoryDocRecord | null {
  return (
    database
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.projectId, projectId),
          eq(documents.kind, MEMORY_DOC_KIND)
        )
      )
      .get() ?? null
  );
}

/**
 * Trimmed, non-empty memory content for prompt injection, or null.
 *
 * Never throws: prompt assembly must survive a broken/missing memory read
 * (the section is simply omitted).
 */
export function getProjectMemoryContent(
  projectId: string,
  database: ArijDatabase = defaultDb
): string | null {
  try {
    const doc = getProjectMemoryDoc(projectId, database);
    const content = doc?.markdownContent?.trim();
    return content && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export interface SaveProjectMemoryResult {
  doc: MemoryDocRecord;
  /** True when the content was cut at PROJECT_MEMORY_MAX_CHARS. */
  truncated: boolean;
}

/**
 * Creates or replaces the project's memory document (cap-enforced by
 * truncation — callers that want to reject oversized input instead must
 * validate length before calling, as the manual PUT route does).
 */
export function saveProjectMemory(
  projectId: string,
  content: string,
  database: ArijDatabase = defaultDb
): SaveProjectMemoryResult {
  const truncated = content.length > PROJECT_MEMORY_MAX_CHARS;
  const capped = enforceMemoryCap(content);
  const now = new Date().toISOString();

  const existing = getProjectMemoryDoc(projectId, database);
  if (existing) {
    database
      .update(documents)
      .set({ markdownContent: capped, sizeBytes: capped.length, updatedAt: now })
      .where(eq(documents.id, existing.id))
      .run();
    const doc = database
      .select()
      .from(documents)
      .where(eq(documents.id, existing.id))
      .get();
    return { doc: doc ?? { ...existing, markdownContent: capped }, truncated };
  }

  const id = createId();
  database
    .insert(documents)
    .values({
      id,
      projectId,
      originalFilename: MEMORY_DOC_FILENAME,
      kind: MEMORY_DOC_KIND,
      markdownContent: capped,
      imagePath: null,
      mimeType: "text/markdown",
      sizeBytes: capped.length,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const doc = database
    .select()
    .from(documents)
    .where(eq(documents.id, id))
    .get();
  if (!doc) {
    throw new Error("Failed to persist project memory document");
  }
  return { doc, truncated };
}

/** The project's pre-dream memory snapshot row, or null when none exists. */
export function getProjectMemoryArchiveDoc(
  projectId: string,
  database: ArijDatabase = defaultDb
): MemoryDocRecord | null {
  return (
    database
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.projectId, projectId),
          eq(documents.kind, MEMORY_ARCHIVE_DOC_KIND)
        )
      )
      .get() ?? null
  );
}

/**
 * Snapshots the memory a dream is about to overwrite (see
 * MEMORY_ARCHIVE_DOC_KIND for why exactly one row is kept).
 *
 * Empty/absent content is a no-op: there is nothing to lose, and writing an
 * empty archive would only hide the previous, real snapshot. Returns the
 * archive row when one was written.
 */
export function archiveProjectMemory(
  projectId: string,
  content: string | null | undefined,
  database: ArijDatabase = defaultDb
): MemoryDocRecord | null {
  const body = content?.trim();
  if (!body) return null;

  const capped = enforceMemoryCap(body);
  const now = new Date().toISOString();
  const existing = getProjectMemoryArchiveDoc(projectId, database);

  if (existing) {
    database
      .update(documents)
      .set({ markdownContent: capped, sizeBytes: capped.length, updatedAt: now })
      .where(eq(documents.id, existing.id))
      .run();
    return (
      database
        .select()
        .from(documents)
        .where(eq(documents.id, existing.id))
        .get() ?? { ...existing, markdownContent: capped }
    );
  }

  const id = createId();
  database
    .insert(documents)
    .values({
      id,
      projectId,
      originalFilename: MEMORY_ARCHIVE_DOC_FILENAME,
      kind: MEMORY_ARCHIVE_DOC_KIND,
      markdownContent: capped,
      imagePath: null,
      mimeType: "text/markdown",
      sizeBytes: capped.length,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return (
    database.select().from(documents).where(eq(documents.id, id)).get() ?? null
  );
}
