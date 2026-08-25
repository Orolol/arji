/**
 * Client-safe constants for Full Auto Mode — the standing supervisor that
 * builds, reviews and merges a project's board without a human dispatch.
 *
 * Kept free of any database / server import so client components (the auto
 * mode dialog, the board toolbar toggle) can import the setting keys, the
 * clamps and the parsers without pulling server modules into the bundle —
 * same pattern as lib/agents/scheduler-constants.ts and lib/pipeline/constants.ts.
 *
 * The whole configuration lives in the existing key/value `settings` table:
 * no migration, no new table. Every key follows the established
 * `<key>` (global) / `<key>:<projectId>` (per-project override) convention,
 * and every parser returns `null` for "not configured" so callers fall
 * through the project → global → built-in default chain.
 */

/* ------------------------------------------------------------------ */
/* Run identity                                                        */
/* ------------------------------------------------------------------ */

/**
 * Prefix of the `agent_sessions.batch_run_id` tag stamped on every session
 * Full Auto Mode dispatches. Deliberately distinct from
 * NIGHT_RUN_ID_PREFIX (`night_`) so `isNightRunId` never claims an auto-mode
 * session and the morning summary stays night-only.
 */
export const AUTO_RUN_ID_PREFIX = "auto_";

/**
 * The mode is standing, not a run: one stable id per project (`auto_<id>`),
 * so every session it ever dispatches is greppable as one batch.
 */
export function autoRunId(projectId: string): string {
  return `${AUTO_RUN_ID_PREFIX}${projectId}`;
}

/** True when the given batch run id belongs to Full Auto Mode. */
export function isAutoRunId(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(AUTO_RUN_ID_PREFIX);
}

/* ------------------------------------------------------------------ */
/* Sweep cadence                                                       */
/* ------------------------------------------------------------------ */

/**
 * Timer cadence of the standing sweep. The session terminal hook kicks a
 * sweep as soon as an agent finishes, so this interval is the backstop that
 * covers everything the hook cannot see (a user dragging a ticket into To
 * Do, a comment answering an agent question, a settings change).
 */
export const AUTO_MODE_SWEEP_INTERVAL_MS = 15_000;

/* ------------------------------------------------------------------ */
/* Settings keys                                                       */
/* ------------------------------------------------------------------ */

/** Global settings key: is Full Auto Mode on? Off when absent. */
export const AUTO_MODE_ENABLED_SETTING_KEY = "auto_mode_enabled";

/** Global settings key: named agent used for auto-dispatched build stages. */
export const AUTO_MODE_BUILD_AGENT_SETTING_KEY = "auto_mode_build_agent";

/** Global settings key: how many auto builds may be in flight at once. */
export const AUTO_MODE_BUILD_CONCURRENCY_SETTING_KEY =
  "auto_mode_build_concurrency";

/** Global settings key: named agent used for auto-dispatched review stages. */
export const AUTO_MODE_REVIEW_AGENT_SETTING_KEY = "auto_mode_review_agent";

/** Global settings key: how many auto reviews may be in flight at once. */
export const AUTO_MODE_REVIEW_CONCURRENCY_SETTING_KEY =
  "auto_mode_review_concurrency";

/**
 * Global settings key: may the mode pick the build/review agent from its
 * measured 30-day success rate when no agent is explicitly configured for the
 * role? Tri-state like every other flag here (absent = fall through), and OFF
 * by default — an unattended mode must not start choosing differently than it
 * did yesterday because of a setting nobody turned on.
 */
export const AUTO_MODE_SMART_DISPATCH_SETTING_KEY = "auto_mode_smart_dispatch";

/** Per-project override (`auto_mode_enabled:<projectId>`). */
export function autoModeEnabledSettingKey(projectId: string): string {
  return `${AUTO_MODE_ENABLED_SETTING_KEY}:${projectId}`;
}

/** Per-project override (`auto_mode_build_agent:<projectId>`). */
export function autoModeBuildAgentSettingKey(projectId: string): string {
  return `${AUTO_MODE_BUILD_AGENT_SETTING_KEY}:${projectId}`;
}

/** Per-project override (`auto_mode_build_concurrency:<projectId>`). */
export function autoModeBuildConcurrencySettingKey(projectId: string): string {
  return `${AUTO_MODE_BUILD_CONCURRENCY_SETTING_KEY}:${projectId}`;
}

/** Per-project override (`auto_mode_review_agent:<projectId>`). */
export function autoModeReviewAgentSettingKey(projectId: string): string {
  return `${AUTO_MODE_REVIEW_AGENT_SETTING_KEY}:${projectId}`;
}

/** Per-project override (`auto_mode_review_concurrency:<projectId>`). */
export function autoModeReviewConcurrencySettingKey(projectId: string): string {
  return `${AUTO_MODE_REVIEW_CONCURRENCY_SETTING_KEY}:${projectId}`;
}

/** Per-project override (`auto_mode_smart_dispatch:<projectId>`). */
export function autoModeSmartDispatchSettingKey(projectId: string): string {
  return `${AUTO_MODE_SMART_DISPATCH_SETTING_KEY}:${projectId}`;
}

/* ------------------------------------------------------------------ */
/* Defaults, clamps, parsing                                           */
/* ------------------------------------------------------------------ */

export const DEFAULT_AUTO_BUILD_CONCURRENCY = 2;
export const DEFAULT_AUTO_REVIEW_CONCURRENCY = 1;

/**
 * Inclusive clamp for both concurrency budgets. 0 is legal and means "do not
 * dispatch this kind" — turning builds off while reviews keep draining the
 * Review column is a supported configuration, so unlike the scheduler budget
 * (which would deadlock at 0) the minimum here is 0, not 1.
 */
export const AUTO_MODE_CONCURRENCY_RANGE = { min: 0, max: 10 } as const;

/**
 * PATCH /api/settings always JSON.stringify's the value it stores
 * (app/api/settings/route.ts), so a number arrives back as the string "2"
 * and a boolean as "true". Every parser therefore has to tolerate the raw
 * value, a numeric string, and a JSON-encoded string alike — same
 * coerceNumber body as lib/night/constants.ts.
 */
function coerceNumber(value: unknown): number | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — fall through to numeric coercion
    }
  }
  const num =
    typeof parsed === "number"
      ? parsed
      : typeof parsed === "string" && parsed.trim() !== ""
        ? Number(parsed)
        : NaN;
  return Number.isFinite(num) ? (num as number) : null;
}

/**
 * Parses the on/off flag into a tri-state: null means "not configured", so
 * callers fall through to the next level of the project → global → OFF
 * chain. Mirrors parsePipelineEnabledSetting.
 */
export function parseAutoModeEnabled(value: unknown): boolean | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — compared literally below
    }
  }
  if (parsed === true || parsed === "true") return true;
  if (parsed === false || parsed === "false") return false;
  return null;
}

/**
 * Parses + clamps a concurrency budget to 0..10. Returns null when the value
 * is not an integer at all (absent key, empty string, garbage), so callers
 * fall through to the next key of the chain.
 */
export function parseAutoModeConcurrency(value: unknown): number | null {
  const num = coerceNumber(value);
  if (num === null || !Number.isInteger(num)) return null;
  return Math.min(
    AUTO_MODE_CONCURRENCY_RANGE.max,
    Math.max(AUTO_MODE_CONCURRENCY_RANGE.min, num)
  );
}

/**
 * Parses a named-agent id. Returns null for anything that is not a
 * non-empty string, which means "no explicit agent — use the normal
 * resolution chain".
 */
export function parseAutoModeAgent(value: unknown): string | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — use as-is
    }
  }
  if (typeof parsed !== "string") return null;
  const trimmed = parsed.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* ------------------------------------------------------------------ */
/* Effective configuration                                             */
/* ------------------------------------------------------------------ */

export interface AutoModeConfig {
  enabled: boolean;
  buildAgent: string | null;
  buildConcurrency: number;
  reviewAgent: string | null;
  reviewConcurrency: number;
  /**
   * Pick the agent from its measured record when the role has no explicit
   * agent. Never overrides `buildAgent`/`reviewAgent` — see
   * lib/agent-config/smart-dispatch.ts.
   */
  smartDispatch: boolean;
}

/**
 * Client-side resolver over a settings map (as returned by GET
 * /api/settings, already JSON-parsed): per-project key wins, then the global
 * key, then the built-in default. The server-side twin — reading the same
 * chain straight from the database — lives in lib/auto-mode/config.ts.
 */
export function resolveAutoModeConfig(
  settings: Record<string, unknown> | null | undefined,
  projectId: string
): AutoModeConfig {
  const map = settings ?? {};

  const pick = <T>(
    perProjectKey: string,
    globalKey: string,
    parse: (value: unknown) => T | null,
    fallback: T
  ): T => {
    const perProject = parse(map[perProjectKey]);
    if (perProject !== null) return perProject;
    const global = parse(map[globalKey]);
    if (global !== null) return global;
    return fallback;
  };

  return {
    enabled: pick(
      autoModeEnabledSettingKey(projectId),
      AUTO_MODE_ENABLED_SETTING_KEY,
      parseAutoModeEnabled,
      false
    ),
    buildAgent: pick(
      autoModeBuildAgentSettingKey(projectId),
      AUTO_MODE_BUILD_AGENT_SETTING_KEY,
      parseAutoModeAgent,
      null
    ),
    buildConcurrency: pick(
      autoModeBuildConcurrencySettingKey(projectId),
      AUTO_MODE_BUILD_CONCURRENCY_SETTING_KEY,
      parseAutoModeConcurrency,
      DEFAULT_AUTO_BUILD_CONCURRENCY
    ),
    reviewAgent: pick(
      autoModeReviewAgentSettingKey(projectId),
      AUTO_MODE_REVIEW_AGENT_SETTING_KEY,
      parseAutoModeAgent,
      null
    ),
    reviewConcurrency: pick(
      autoModeReviewConcurrencySettingKey(projectId),
      AUTO_MODE_REVIEW_CONCURRENCY_SETTING_KEY,
      parseAutoModeConcurrency,
      DEFAULT_AUTO_REVIEW_CONCURRENCY
    ),
    smartDispatch: pick(
      autoModeSmartDispatchSettingKey(projectId),
      AUTO_MODE_SMART_DISPATCH_SETTING_KEY,
      parseAutoModeEnabled,
      false
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Activity-log reason strings (the UI contract for the feed)          */
/* ------------------------------------------------------------------ */

/**
 * Every Full Auto Mode activity entry is logged with actor `system` and
 * `fromStatus === toStatus` (it is an observation, not a move), and its
 * reason starts with this prefix — mirroring PIPELINE_REASON_PREFIX so the
 * ticket feed can key a dedicated rendering off the prefix rather than off
 * exact strings.
 */
export const AUTO_MODE_REASON_PREFIX = "Auto mode ";

/**
 * Reasons read as a sentence ("Auto mode dispatched a review") or as a label
 * ("Auto mode: review clean, merged"), so the family is `Auto mode` followed
 * by a space OR a colon. `isAutoModeActivityReason` matches both — keying the
 * feed off the bare prefix alone would silently drop the colon-form entries,
 * of which the successful auto-merge is the most important one to show.
 */
const AUTO_MODE_REASON_PATTERN = /^Auto mode[ :]/;

export const AUTO_MODE_REASONS = {
  enabled: "Auto mode enabled",
  disabled: "Auto mode disabled",
  buildDispatched: (scope: "epic" | "story") =>
    `Auto mode dispatched a build (${scope} scope)`,
  reviewDispatched: "Auto mode dispatched a review",
  /**
   * Why THIS agent ran. Written on every smart-dispatched session so the
   * choice is reconstructable from the ticket feed alone — an unattended mode
   * that silently picks a different agent than the settings show is the one
   * thing a user cannot debug afterwards.
   */
  smartDispatch: (
    stage: "build" | "review",
    agentName: string,
    successRate: number,
    sampleSize: number
  ) =>
    `Auto mode picked ${agentName} for the ${stage}: best ${Math.round(
      successRate * 100
    )}% success over ${sampleSize} runs in the last 30 days`,
  mergeAttempted: "Auto mode attempting merge after a clean review",
  merged: "Auto mode: review clean, merged",
  mergeRefused: (error: string) => `Auto mode skipped merge: ${error}`,
  mergeConflict: "Auto mode merge conflict — merge-fix agent dispatched",
  mergeConflictDeferred:
    "Auto mode merge conflict — no build slot for a resolution agent, deferred",
  mergeFixRetried: "Auto mode retried the merge after the merge-fix agent",
  /** The post-merge guard refused, so main was put back where it was. */
  mergeRolledBack: (error: string) =>
    `Auto mode rolled the merge back off main: ${error}`,
  /**
   * The branch landed on main but the ticket had moved on in the meantime, so
   * the `→ done` guards refused. Loud on purpose: main changed and the board
   * did not follow.
   */
  mergedButNotAdvanced: (error: string) =>
    `Auto mode merged the branch but left the ticket where it is: ${error}`,
  dispatchFailed: (stage: string, error: string) =>
    `Auto mode ${stage} dispatch failed: ${error}`,
  parked: (failures: number) =>
    `Auto mode parked this ticket after ${failures} consecutive failures`,
  skippedBusy: "Auto mode skipped: another agent is already on this ticket",
  skippedTargetMoved: (stage: string, detail: string) =>
    `Auto mode skipped ${stage}: ${detail}`,
} as const;

/** True when an activity-log reason belongs to the Full Auto Mode trace. */
export function isAutoModeActivityReason(
  reason: string | null | undefined
): boolean {
  return typeof reason === "string" && AUTO_MODE_REASON_PATTERN.test(reason);
}

/* ------------------------------------------------------------------ */
/* Parking                                                             */
/* ------------------------------------------------------------------ */

/**
 * Consecutive dispatch/merge failures a ticket may accumulate before the
 * supervisor parks it. A parked ticket is skipped until the mode is toggled
 * or the ticket is touched (a new comment, a status change) — the standing
 * loop must never burn budget re-running the same broken dispatch.
 */
export const AUTO_MODE_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How long an epic's merge is held back after a conflict that could not be
 * repaired because no build slot was free. Without it the sweep would re-run
 * a doomed `git merge` — tearing the worktree down each time — every 15
 * seconds until capacity happened to free up.
 */
export const AUTO_MERGE_CONFLICT_BACKOFF_MS = 5 * 60_000;
