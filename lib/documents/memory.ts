/**
 * Learned project memory — storage helpers.
 *
 * One memory document per project, stored in the existing `documents` table
 * with `kind = 'memory'` (see lib/documents/memory-constants.ts for why that
 * discriminator). Content is markdown, hard-capped at
 * PROJECT_MEMORY_MAX_TOKENS estimated tokens on every write.
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
  PROJECT_MEMORY_MAX_TOKENS,
} from "./memory-constants";
import { estimateTokens } from "@/lib/tokens/estimator";

export type MemoryDocRecord = typeof documents.$inferSelect;

/**
 * Truncates content to the hard cap (no-op when already within it).
 *
 * The cap is PROJECT_MEMORY_MAX_TOKENS estimated tokens; under the
 * estimator's 1-token ≈ 4-chars contract that is exactly
 * PROJECT_MEMORY_MAX_CHARS characters, which is the slice target.
 */
export function enforceMemoryCap(content: string): string {
  if (estimateTokens(content) <= PROJECT_MEMORY_MAX_TOKENS) return content;
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
  /** True when the content was cut at the token cap. */
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
  const truncated = estimateTokens(content) > PROJECT_MEMORY_MAX_TOKENS;
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

export interface ReplaceProjectMemoryResult extends SaveProjectMemoryResult {
  /** The snapshot row written, or null when there was nothing to snapshot. */
  archive: MemoryDocRecord | null;
}

/**
 * Thrown when the memory changed under a long-running rewrite (see
 * `expectedPrevious`). A conflict, not a fault: the caller drops its output
 * and leaves everything as the newer writer left it.
 */
export class ProjectMemoryChangedError extends Error {
  constructor() {
    super("The project memory changed while the rewrite was running.");
    this.name = "ProjectMemoryChangedError";
  }
}

export function isProjectMemoryChangedError(error: unknown): boolean {
  return error instanceof ProjectMemoryChangedError;
}

export interface ReplaceProjectMemoryOptions {
  /**
   * The memory content the caller REASONED FROM, for optimistic concurrency.
   *
   * A dream reads the memory when it builds its prompt and writes minutes
   * later; the manual editor can save in between. Without this check the dream
   * would silently overwrite that edit with text produced from the version
   * before it. When the stored content no longer matches, the replacement is
   * refused with ProjectMemoryChangedError — the human edit wins, because it
   * is the newer intent and the dream can simply be run again.
   *
   * Compared against the trimmed content (what `getProjectMemoryContent`
   * returns), so a no-op save that rewrites identical text is not a conflict.
   * Omit to replace unconditionally.
   */
  expectedPrevious?: string | null;
  database?: ArijDatabase;
}

/**
 * Shared write primitive for the two agent-driven memory rewrites.
 *
 * Both read the memory to build a prompt, run a session for minutes, then
 * write back — so both need the `expectedPrevious` comparison and the write to
 * be one atomic step, or a concurrent manual save slips through the gap.
 * They differ only in whether the overwritten text is snapshotted (see
 * MEMORY_ARCHIVE_DOC_KIND: the single archive row means "undo the last
 * dream", so a distill must not spend it).
 */
function writeProjectMemoryGuarded(
  projectId: string,
  content: string,
  options: ReplaceProjectMemoryOptions,
  archive: boolean
): ReplaceProjectMemoryResult {
  const database = options.database ?? defaultDb;
  const guarded = "expectedPrevious" in options;
  return database.transaction((tx) => {
    const previous = getProjectMemoryContent(projectId, tx);
    if (guarded && previous !== (options.expectedPrevious ?? null)) {
      throw new ProjectMemoryChangedError();
    }
    const archived = archive ? archiveProjectMemory(projectId, previous, tx) : null;
    const saved = saveProjectMemory(projectId, content, tx);
    return { ...saved, archive: archived };
  });
}

/**
 * Replaces the memory document and snapshots what it replaced, ATOMICALLY.
 *
 * The two writes have to commit together or not at all. Archiving first and
 * saving second looks safe but is not: a save that throws (a disk error, the
 * unique-filename constraint) would leave the archive already overwritten with
 * the text that is STILL the live memory — burning the one snapshot the user
 * has, in exchange for a rewrite that never happened. One transaction makes
 * the failure mode honest: nothing moves, and the previous snapshot survives.
 *
 * The optional `expectedPrevious` check runs INSIDE that transaction, so a
 * concurrent save cannot slip between the comparison and the write.
 *
 * Callers get the same throw-on-failure contract as `saveProjectMemory`.
 */
export function replaceProjectMemoryWithSnapshot(
  projectId: string,
  content: string,
  options: ReplaceProjectMemoryOptions = {}
): ReplaceProjectMemoryResult {
  return writeProjectMemoryGuarded(projectId, content, options, true);
}

/**
 * Saves the memory under the same optimistic guard, WITHOUT snapshotting.
 *
 * For per-session distillation, which has the identical stale-write window as
 * a dream — it captures the memory at prompt time and writes back after a long
 * plan session, so a manual save in between would otherwise be silently
 * overwritten by text reasoned from the older version. Same resolution: the
 * human edit is the newer intent and wins, and the distill can be re-run.
 *
 * It does NOT archive, on purpose. The archive is one row per project meaning
 * "the memory before the last dream"; letting a distill (which rewrites the
 * whole doc from a single session) overwrite it would destroy the only undo a
 * dream leaves behind.
 *
 * Throws ProjectMemoryChangedError when the stored memory no longer matches
 * `expectedPrevious`; omit that option to save unconditionally.
 */
export function saveProjectMemoryGuarded(
  projectId: string,
  content: string,
  options: ReplaceProjectMemoryOptions = {}
): SaveProjectMemoryResult {
  const { archive: _unused, ...saved } = writeProjectMemoryGuarded(
    projectId,
    content,
    options,
    false
  );
  return saved;
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
