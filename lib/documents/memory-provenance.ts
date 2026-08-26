/**
 * Per-project provenance of the LAST write to the project memory document.
 *
 * Every write path records its source here: manual saves and restores write
 * `{ source: "manual", sessionId: null }`; Dreaming writes
 * `{ source: "dreaming", sessionId }`; distillation writes
 * `{ source: "distill", sessionId }`. The memory route's GET envelope serves
 * it so the Spec & Memory panel can display who wrote the memory it renders
 * (Story 3 of the "gérer la section mémoire" epic).
 *
 * Stored under a per-project key in the `settings` table
 * (`memory_provenance:<projectId>` — free-form keys, no migration) as JSON.
 */
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { MEMORY_PROVENANCE_SETTING_KEY_PREFIX } from "./memory-constants";

export type MemoryWriteSource = "manual" | "dreaming" | "distill";

const SOURCES: readonly string[] = ["manual", "dreaming", "distill"];

export interface MemoryWriteProvenance {
  source: MemoryWriteSource;
  /** The session that authored the write; null for manual writes. */
  sessionId: string | null;
  /** ISO timestamp of the write. */
  at: string;
}


/**
 * Reads the last-write provenance record for a project. Returns null when the
 * record is missing, unreadable, or carries an unknown source — callers treat
 * null as "provenance unknown", which is the state of legacy projects too.
 */
export function getMemoryWriteProvenance(
  projectId: string
): MemoryWriteProvenance | null {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, `${MEMORY_PROVENANCE_SETTING_KEY_PREFIX}${projectId}`))
    .get();
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<MemoryWriteProvenance>;
    if (typeof parsed.source !== "string" || !SOURCES.includes(parsed.source)) {
      return null;
    }
    return {
      source: parsed.source as MemoryWriteSource,
      sessionId:
        typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      at: typeof parsed.at === "string" ? parsed.at : "",
    };
  } catch {
    return null;
  }
}

/**
 * Records a write to the project memory document as its new provenance.
 * Upsert on the settings key; a later write always wins — the record
 * describes the LAST write, not the history (that lives in notifications
 * and the archive doc).
 */
export function recordMemoryWriteProvenance(
  projectId: string,
  input: { source: MemoryWriteSource; sessionId: string | null }
): void {
  const at = new Date().toISOString();
  const value = JSON.stringify({
    source: input.source,
    sessionId: input.sessionId,
    at,
  });
  db.insert(settings)
    .values({ key: `${MEMORY_PROVENANCE_SETTING_KEY_PREFIX}${projectId}`, value, updatedAt: at })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: at },
    })
    .run();
}
