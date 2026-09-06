import type { Routine } from "@/lib/db/schema";

/**
 * Client-safe routine catalog. Keep availability here rather than deriving it
 * from the database enum: a kind may be durable before its dispatcher is
 * actually shipped (Dreaming is currently in that state).
 */
export const ROUTINE_KINDS = [
  "night_run",
  "dreaming",
  "github_issue_sync",
  "ci_watch",
  "retention",
] as const;

export type RoutineKind = (typeof ROUTINE_KINDS)[number];

export const AVAILABLE_ROUTINE_KINDS = [
  "night_run",
  "github_issue_sync",
  "ci_watch",
  "retention",
] as const satisfies readonly RoutineKind[];

export type AvailableRoutineKind = (typeof AVAILABLE_ROUTINE_KINDS)[number];

export const ROUTINE_KIND_LABELS: Record<RoutineKind, string> = {
  night_run: "Night run",
  dreaming: "Dreaming",
  github_issue_sync: "GitHub issue sync",
  ci_watch: "CI watch",
  retention: "Data retention",
};

export const ROUTINE_KIND_DESCRIPTIONS: Record<AvailableRoutineKind, string> = {
  night_run:
    "Starts the canonical dependency-aware night run for eligible tickets.",
  github_issue_sync:
    "Runs daily and refreshes open GitHub issues when the configured freshness TTL has expired.",
  ci_watch:
    "Polls open pull requests and reports newly failing CI checks by head SHA.",
  retention:
    "Prunes stored output of terminal sessions past the retention window, keeping each session's final response and forensic tail, and caps stored prompts left over the size limit.",
};

export function isAvailableRoutineKind(
  value: unknown,
): value is AvailableRoutineKind {
  return (AVAILABLE_ROUTINE_KINDS as readonly unknown[]).includes(value);
}

export function isDailyRoutineKind(
  kind: RoutineKind,
): kind is Extract<
  RoutineKind,
  "night_run" | "github_issue_sync" | "retention"
> {
  return (
    kind === "night_run" ||
    kind === "github_issue_sync" ||
    kind === "retention"
  );
}

export function defaultRoutineConfig(
  kind: AvailableRoutineKind,
): Record<string, unknown> {
  switch (kind) {
    case "night_run":
      return { includeBacklog: false, failurePolicy: "halt" };
    case "github_issue_sync":
    case "ci_watch":
      return { intervalMinutes: 15 };
    // The window itself is a settings key, not per-routine config: it is read
    // by the pruner and belongs next to the other retention settings.
    case "retention":
      return { vacuum: true };
  }
}

/**
 * Durable one-shot claim written by the retention routine once it has
 * VACUUMed the database. Arij-managed, so `crud.ts` keeps it out of the
 * configuration a user edits — see INTERNAL_CONFIG_KEYS there.
 */
export const RETENTION_VACUUMED_AT_CONFIG_KEY = "retentionVacuumedAt";

/**
 * The same one-shot claim for the prompt sweep, and a SEPARATE key on purpose.
 *
 * `agent_sessions.prompt` and `agent_session_chunks` are two independent
 * historical backlogs, each cleared exactly once. Sharing one claim would mean
 * whichever sweep ran first spent the other's VACUUM: a database that pruned
 * chunks months ago would rewrite 22 MB of prompt into the free list and never
 * return a byte of it to the filesystem. Two keys, two rewrites over the life
 * of a database, and neither backlog silently loses its reclaim.
 */
export const RETENTION_PROMPTS_VACUUMED_AT_CONFIG_KEY =
  "retentionPromptsVacuumedAt";

/**
 * Durable "a reclaim is owed" mark for the chunk backlog.
 *
 * The VACUUM claim above is one rewrite for the WHOLE historical backlog, and
 * a run only deletes up to `maxDeletedChunks` rows of it. Spending the claim
 * on the first budgeted run reclaims that run's pages and strands every later
 * batch's for the life of the database — measured at 148,932 rows deleted by
 * a 7-day pass against a 50,000-row budget, so two thirds of the reduction
 * never reached the filesystem.
 *
 * So the claim is deferred to the run that drains the backlog, and this mark
 * is what carries the debt across runs: the ISO instant the reclaim was first
 * postponed. It is cleared by the run that finally takes the rewrite.
 *
 * The chunk backlog differs from the prompt one here, and the difference is
 * why the deferral is bounded rather than absolute: prompts are capped on the
 * write path, so that backlog drains once and never refills, while sessions
 * age past the retention window every day. On a project that fills the budget
 * daily, "wait until it drains" would postpone the rewrite forever — where
 * the old code at least ran it once. See RETENTION_RECLAIM_MAX_DEFERRAL_DAYS.
 */
export const RETENTION_CHUNKS_RECLAIM_PENDING_AT_CONFIG_KEY =
  "retentionChunksReclaimPendingAt";

export const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Calendar comparison deliberately uses the server's local timezone. */
export function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * Strict config reader for dispatchers: malformed stored JSON is a runtime
 * error naming the routine, not a silent fallback to `{}`.
 */
export function parseRoutineConfig(
  routine: Pick<Routine, "id" | "config">,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(routine.config) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Routine ${routine.id} has invalid config: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }
}
