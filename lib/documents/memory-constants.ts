/**
 * Client-safe constants for the learned project memory document.
 *
 * The memory doc lives in the `documents` table as a normal row whose
 * `kind` is 'memory' — the least invasive discriminator: prompt assembly
 * already filters reference documents on `kind = 'text'`
 * (see lib/documents/query.ts), so the memory doc never double-injects as a
 * reference document, and image handling (`kind = 'image'`) is untouched.
 *
 * Kept separate from lib/documents/memory.ts (which imports the database)
 * so client components can import the kind/cap without pulling server
 * modules into the bundle — same pattern as
 * lib/agents/scheduler-constants.ts.
 */

/** `documents.kind` value reserved for the per-project memory document. */
export const MEMORY_DOC_KIND = "memory";

/**
 * Display name stored in `documents.original_filename`. Deliberately not a
 * real filename: uploads keep their extensions, so collisions with the
 * per-project case-insensitive filename uniqueness are practically
 * impossible.
 */
export const MEMORY_DOC_FILENAME = "Project memory";

/**
 * Hard cap on the memory doc body, enforced on every write path (manual
 * editor rejects, distillation and dreaming truncate). Keeps the prompt
 * injection token-cheap by construction.
 *
 * Raised 4000 → 8000 for Dreaming (lib/workflow/dreaming.ts): a memory
 * distilled from ONE session is a handful of conventions, but one dreamed
 * across dozens of sessions carries four sections (codebase traps, recurring
 * agent mistakes, strategies that work, build instructions) and was being cut
 * mid-sentence at 4000. The cost is bounded and known: `memorySection()`
 * injects this document into every agent prompt for the project (~10 builders
 * in lib/claude/prompt-builder.ts plus the forensic prompt), so the ceiling
 * moves from ~1k to ~2k tokens of prompt per session — still an order of
 * magnitude under the spec and board context that ride alongside it.
 *
 * Raised 8000 → 12000 with the Spec & Memory panel
 * (app/projects/[projectId]/spec): the memory panel now lives next to the
 * spec with its own editor, and the four dreaming sections plus build
 * instructions regularly hit the 8000 cap — a full dream rewrite landed with
 * its last section cut off.
 */
export const PROJECT_MEMORY_MAX_CHARS = 12000;

/**
 * `documents.kind` of the pre-dream memory snapshot.
 *
 * A dream REPLACES the whole memory document, so the text it overwrites is
 * kept as exactly one archive row per project — the previous version, not a
 * history. One row was the deliberate call: a growing archive would need its
 * own pruning policy and a UI to be worth anything, while "undo the last
 * dream" is the only recovery anyone actually needs. Its own kind (rather than
 * 'text') keeps it out of `listProjectTextDocuments`, so an archived memory is
 * never injected into a prompt as a reference document.
 */
export const MEMORY_ARCHIVE_DOC_KIND = "memory_archive";

/** Display name stored in `documents.original_filename` for the snapshot. */
export const MEMORY_ARCHIVE_DOC_FILENAME = "Project memory (pre-dream snapshot)";

/**
 * Document kinds the memory workflow owns.
 *
 * They live in the `documents` table but are NOT uploads: the live memory has
 * its own editor card and the archive is a recovery copy. Neither may appear
 * in the Docs upload list — where a stray click would delete them — so the
 * list route filters on this set and the delete route refuses it. Kept here,
 * client-safe, so the API boundary and the page agree on one definition.
 */
export const MEMORY_INTERNAL_DOC_KINDS: readonly string[] = [
  MEMORY_DOC_KIND,
  MEMORY_ARCHIVE_DOC_KIND,
];

export function isInternalMemoryDocKind(kind: string | null | undefined): boolean {
  return kind != null && MEMORY_INTERNAL_DOC_KINDS.includes(kind);
}

/**
 * Settings key for the optional auto-distillation mode: when the stored
 * value parses to `true` (JSON boolean or the string "true"), a successful
 * build-type session enqueues a memory-distill session on completion.
 * DEFAULT OFF — absent key means disabled.
 */
export const MEMORY_AUTO_DISTILL_SETTING_KEY = "memory_auto_distill";

/** Tolerant parse of the settings row value ('true'/'false', default off). */
export function parseMemoryAutoDistillSetting(value: unknown): boolean {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — compare as-is below
    }
  }
  if (parsed === true) return true;
  if (typeof parsed === "string") return parsed.trim().toLowerCase() === "true";
  return false;
}

/**
 * Settings key prefix for the per-project memory-write provenance record
 * (`memory_provenance:<projectId>`). The value is a JSON
 * `{ source: "manual" | "dreaming" | "distill", sessionId: string | null, at: ISO }`
 * describing the LAST write of the project memory document — stored in
 * `settings` (free-form keys, no migration needed) and served by the memory
 * route's GET envelope so the panel can show who wrote the memory it renders.
 */
export const MEMORY_PROVENANCE_SETTING_KEY_PREFIX = "memory_provenance:";
