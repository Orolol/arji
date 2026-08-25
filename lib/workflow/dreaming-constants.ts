/**
 * Client-safe constants for "Dreaming" — the cross-session distillation pass.
 *
 * Where `memory_distill` (lib/workflow/memory-distill.ts) looks at ONE session
 * and merges what it taught into the project memory, a dream looks at the last
 * N terminal sessions of MANY tickets — successes and failures alike — and
 * rewrites the memory around what only the batch shows: recurring agent
 * mistakes, codebase traps, strategies that actually work.
 *
 * Kept free of any database / server import so client components (settings
 * page, Docs tab) can import the setting keys, the agent type and the caps
 * without pulling server modules into the bundle — same pattern as
 * lib/workflow/spec-rewrite-constants.ts and lib/pipeline/constants.ts.
 */

/* ------------------------------------------------------------------ */
/* Agent identity                                                      */
/* ------------------------------------------------------------------ */

/**
 * Dedicated agent type for the dream session. Its own type (rather than
 * reusing 'memory_distill') is what makes the concurrency guard, the session
 * filters and the Agent Config overrides able to tell the two writers of the
 * memory document apart.
 */
export const DREAMING_AGENT_TYPE = "dreaming";

/**
 * Agent types that WRITE the project memory document. Neither may ever be a
 * source for a memory pass — no distilling a distill, no dreaming about a
 * dream — and neither belongs in a dream digest (their output is the memory,
 * not evidence about the codebase).
 */
export const MEMORY_WRITER_AGENT_TYPES: readonly string[] = [
  "memory_distill",
  DREAMING_AGENT_TYPE,
];

/* ------------------------------------------------------------------ */
/* Settings keys                                                       */
/* ------------------------------------------------------------------ */

/**
 * Global settings key: run a dream when a night run finishes. DEFAULT OFF —
 * an absent key means the night run ends exactly as it does today.
 */
export const DREAMING_AFTER_NIGHT_RUN_SETTING_KEY = "dreaming_after_night_run";

/**
 * Per-project override (`dreaming_after_night_run:<projectId>`), following the
 * `pipeline_enabled:<projectId>` convention. Takes precedence over the global
 * key.
 */
export function dreamingAfterNightRunSettingKey(projectId: string): string {
  return `${DREAMING_AFTER_NIGHT_RUN_SETTING_KEY}:${projectId}`;
}

/**
 * Parses a raw settings value (boolean, or the literal strings
 * "true"/"false" as the settings PATCH route stores them) into a tri-state:
 * null means "not configured", so callers fall through to the next level of
 * the project → global → OFF chain. Mirrors parsePipelineEnabledSetting.
 */
export function parseDreamingAfterNightRunSetting(
  value: unknown
): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * Resolves the effective "dream after a night run" answer for a project from
 * a settings map (as returned by GET /api/settings, already JSON-parsed):
 * per-project key wins, then the global key, then OFF.
 */
export function resolveDreamingAfterNightRunDefault(
  settings: Record<string, unknown> | null | undefined,
  projectId: string
): boolean {
  if (!settings) return false;
  const perProject = parseDreamingAfterNightRunSetting(
    settings[dreamingAfterNightRunSettingKey(projectId)]
  );
  if (perProject !== null) return perProject;
  return (
    parseDreamingAfterNightRunSetting(
      settings[DREAMING_AFTER_NIGHT_RUN_SETTING_KEY]
    ) ?? false
  );
}

/* ------------------------------------------------------------------ */
/* Collection window                                                   */
/* ------------------------------------------------------------------ */

/**
 * Terminal sessions a single dream may look at. The window starts at the last
 * dream (so consecutive dreams never re-read the same evidence) but is capped
 * on BOTH axes — count and age — because a first dream on a busy project would
 * otherwise try to swallow the entire session history.
 */
export const DREAM_MAX_SESSIONS = 30;

/** Hard floor on the window: nothing older than this feeds a dream. */
export const DREAM_WINDOW_DAYS = 14;

/**
 * Session types worth dreaming about: the code-writing flavors and the
 * reviewers. Pipeline "fix" stages are dispatched as build/ticket_build
 * sessions (lib/pipeline/stages.ts picks the agent type from the SCOPE, not
 * from the stage), so they are covered by the build entries and need no type
 * of their own. Merges, QA, release notes, chat and the two memory writers are
 * deliberately absent — they teach nothing about how the codebase resists.
 */
export const DREAM_SOURCE_AGENT_TYPES: readonly string[] = [
  "build",
  "ticket_build",
  "team_build",
  "review_code",
  "review_security",
  "review_compliance",
  "review_feature",
];

/* ------------------------------------------------------------------ */
/* Digest size budget                                                  */
/* ------------------------------------------------------------------ */

/**
 * HARD ceiling on the assembled digest (~60 KB of ASCII markdown). The point
 * of a dream is a compact cross-session view, not a log dump: raw chunk
 * streams are never embedded, and what is embedded is cut to fit by
 * `allocateFairBudgets` so no single verbose session can starve the others.
 */
export const DREAM_DIGEST_MAX_CHARS = 60_000;

/** Per-session cap on the tail of the final response, before fair truncation. */
export const DREAM_FINAL_TEXT_MAX_CHARS = 1200;

/** Per-session cap on an attached forensic diagnostic. */
export const DREAM_FORENSIC_MAX_CHARS = 900;

/** Per-session cap on one `[critical]`/`[major]` finding body. */
export const DREAM_FINDING_MAX_CHARS = 240;

/** Per-session cap on how many findings are listed. */
export const DREAM_MAX_FINDINGS_PER_SESSION = 6;

/** Per-session cap on the stored error / transition-refusal reason. */
export const DREAM_ERROR_MAX_CHARS = 400;

/**
 * Slack after a session ends during which a forensic diagnostic filed on its
 * ticket is attributed to it. The pipeline dispatches the forensic agent
 * immediately after the doomed stage settles, so a short window is enough and
 * keeps an unrelated later diagnostic out of the digest.
 */
export const DREAM_FORENSIC_ATTACH_SLACK_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Trace strings                                                       */
/* ------------------------------------------------------------------ */

/** Notification title prefix for a memory rewritten by a dream. */
export const MEMORY_DREAMED_TITLE = "Project memory updated by Dreaming";

/** Console prefix for the dream workflow's journal lines (incl. no-ops). */
export const DREAMING_LOG_PREFIX = "[dreaming]";
