/**
 * Client-safe constants for the autonomous pipeline (build → review →
 * auto-fix). Kept free of any database / server import so client components
 * (settings page, dispatch dialog, activity feed) can import the setting
 * keys and reason strings without pulling server modules into the bundle —
 * same pattern as lib/agents/scheduler-constants.ts.
 */

/* ------------------------------------------------------------------ */
/* Settings keys                                                       */
/* ------------------------------------------------------------------ */

/**
 * Global settings key: default "run the full pipeline" behaviour for
 * single-ticket build dispatches. Off by default — an absent key means the
 * pipeline never starts unless the request explicitly asks for it.
 */
export const PIPELINE_ENABLED_SETTING_KEY = "pipeline_enabled";

/**
 * Per-project override (`pipeline_enabled:<projectId>`), following the
 * `agent_max_concurrent:<projectId>` convention. Takes precedence over the
 * global key; an explicit request flag still beats both.
 */
export function pipelineEnabledSettingKey(projectId: string): string {
  return `${PIPELINE_ENABLED_SETTING_KEY}:${projectId}`;
}

/** Global settings key: per-stage attempt cap before the run gives up. */
export const PIPELINE_MAX_ATTEMPTS_SETTING_KEY = "pipeline_max_attempts";

/** Global settings key: how many review → fix → review cycles a run may spend. */
export const PIPELINE_MAX_FIX_CYCLES_SETTING_KEY = "pipeline_max_fix_cycles";

/** Per-project override for {@link PIPELINE_MAX_ATTEMPTS_SETTING_KEY}. */
export function pipelineMaxAttemptsSettingKey(projectId: string): string {
  return `${PIPELINE_MAX_ATTEMPTS_SETTING_KEY}:${projectId}`;
}

/** Per-project override for {@link PIPELINE_MAX_FIX_CYCLES_SETTING_KEY}. */
export function pipelineMaxFixCyclesSettingKey(projectId: string): string {
  return `${PIPELINE_MAX_FIX_CYCLES_SETTING_KEY}:${projectId}`;
}

/* ------------------------------------------------------------------ */
/* Defaults and hard caps                                              */
/* ------------------------------------------------------------------ */

export const DEFAULT_PIPELINE_MAX_ATTEMPTS = 2;
export const DEFAULT_PIPELINE_MAX_FIX_CYCLES = 2;

/** Inclusive clamp applied to the configured per-stage attempt cap. */
export const PIPELINE_MAX_ATTEMPTS_RANGE = { min: 1, max: 5 } as const;

/**
 * Inclusive clamp applied to the configured fix-cycle cap. 0 is legal and
 * means "report only": blocking findings fail the run immediately.
 */
export const PIPELINE_MAX_FIX_CYCLES_RANGE = { min: 0, max: 5 } as const;

/**
 * Hard ceiling on agent sessions a single run may spawn, independent of the
 * configurable caps. Not a setting — it is the runaway guard.
 */
export const PIPELINE_MAX_SESSIONS_PER_RUN = 12;

/** The single review type v1 runs per review stage. */
export const PIPELINE_REVIEW_TYPE = "code_review";

/* ------------------------------------------------------------------ */
/* Setting parsing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parses a raw settings value (boolean, JSON-encoded string, or the literal
 * strings "true"/"false") into a tri-state: null means "not configured", so
 * callers fall through to the next level of the global → project → default
 * chain. Mirrors how memory_auto_distill is read.
 */
export function parsePipelineEnabledSetting(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * Resolves the effective "pipeline on by default" answer for a project from
 * a settings map (as returned by GET /api/settings, already JSON-parsed):
 * per-project key wins, then the global key, then OFF. Shared by the
 * dispatch dialog (default checkbox state) and the settings UI.
 */
export function resolvePipelineEnabledDefault(
  settings: Record<string, unknown> | null | undefined,
  projectId: string
): boolean {
  if (!settings) return false;
  const perProject = parsePipelineEnabledSetting(
    settings[pipelineEnabledSettingKey(projectId)]
  );
  if (perProject !== null) return perProject;
  return parsePipelineEnabledSetting(settings[PIPELINE_ENABLED_SETTING_KEY]) ?? false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseIntegerSetting(value: unknown): number | null {
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
  return Number.isInteger(num) ? (num as number) : null;
}

/**
 * Parses + clamps the per-stage attempt cap. Returns null when the value is
 * not an integer at all, so callers can fall through to the next key.
 */
export function parsePipelineMaxAttempts(value: unknown): number | null {
  const num = parseIntegerSetting(value);
  if (num === null) return null;
  return clamp(
    num,
    PIPELINE_MAX_ATTEMPTS_RANGE.min,
    PIPELINE_MAX_ATTEMPTS_RANGE.max
  );
}

/** Parses + clamps the review → fix → review cycle cap (0 allowed). */
export function parsePipelineMaxFixCycles(value: unknown): number | null {
  const num = parseIntegerSetting(value);
  if (num === null) return null;
  return clamp(
    num,
    PIPELINE_MAX_FIX_CYCLES_RANGE.min,
    PIPELINE_MAX_FIX_CYCLES_RANGE.max
  );
}

/* ------------------------------------------------------------------ */
/* Activity-log reason strings (the UI contract for the feed)          */
/* ------------------------------------------------------------------ */

/**
 * Every pipeline activity entry is logged with actor `system` and
 * `fromStatus === toStatus`, and its reason starts with this prefix. The
 * feed keys its dedicated rendering off the prefix rather than off an exact
 * string, so new trace lines render correctly without a UI change.
 */
export const PIPELINE_REASON_PREFIX = "Pipeline ";

export const PIPELINE_REASONS = {
  started: "Pipeline started (build → review → auto-fix)",
  reviewStarted: "Pipeline stage: review started",
  fixStarted: (cycle: number, max: number) =>
    `Pipeline stage: fix started (cycle ${cycle}/${max})`,
  retry: (stage: string, attempt: number, max: number) =>
    `Pipeline retry: ${stage} attempt ${attempt}/${max}`,
  escalation: (stage: string, provider: string) =>
    `Pipeline escalation: ${stage} retried on ${provider}`,
  pausedQuestion: (stage: string) =>
    `Pipeline paused: agent asked a question (${stage})`,
  cancelled: "Pipeline stopped: session cancelled by user",
  finished: "Pipeline finished: review passed, awaiting approval",
  failedFindings: (cycles: number) =>
    `Pipeline failed: blocking findings remain after ${cycles} fix cycles`,
  failedStage: (stage: string, attempts: number) =>
    `Pipeline failed: ${stage} failed after ${attempts} attempts`,
  forensic: "Pipeline forensic diagnostic posted",
  failedSessionCap: "Pipeline failed: session cap reached",
  failedTargetBusy: "Pipeline failed: target busy",
  /**
   * Guard (c): the review stage requires the ticket to still sit in
   * review/done — a human moved it back between stages, so the run stops
   * rather than dispatch a review its route counterpart would reject.
   */
  failedTicketNotInReview:
    "Pipeline failed: ticket left review before the review stage",
  /** One trace entry for every configured deterministic verification run. */
  deterministicVerificationPassed: (commandCount: number) =>
    `Pipeline verify: deterministic checks passed (${commandCount} command${commandCount === 1 ? "" : "s"})`,
  deterministicVerificationFailed: (commandName: string) =>
    `Pipeline verify: deterministic check failed (${commandName})`,
  /** Configured checks could not run (worktree pruned, no repo, …). */
  deterministicVerificationSkipped: (reason: string) =>
    `Pipeline verify: deterministic checks skipped — ${reason}`,
  failedDeterministicVerification: (cycles: number) =>
    `Pipeline failed: deterministic verification still failing after ${cycles} fix cycles`,
  failedDeterministicVerificationCrashed:
    "Pipeline failed: deterministic verification crashed",
  /**
   * Mechanical regression gate (bug tickets) rejected the branch; the run
   * enters a fix cycle with the exact reason injected into the prompt.
   */
  regressionFailed: (cycle: number, max: number) =>
    `Pipeline verify: regression gate failed — fix cycle ${cycle}/${max}`,
  /** Regression gate still red after the fix-cycle budget ran out. */
  failedRegression: (cycles: number) =>
    `Pipeline failed: mandatory regression test still failing after ${cycles} fix cycles`,
  /** The mechanical verify gate itself threw — an infrastructure failure. */
  failedRegressionGateCrashed: "Pipeline failed: regression gate crashed",
  /** The regression command failed to run (infrastructure / environment error). */
  failedRegressionCommandError: "Pipeline failed: regression command error",
} as const;

/** True when an activity-log reason belongs to the pipeline trace. */
export function isPipelineActivityReason(
  reason: string | null | undefined
): boolean {
  return typeof reason === "string" && reason.startsWith(PIPELINE_REASON_PREFIX);
}

/**
 * Coarse tone for a pipeline trace line, used to colour the feed row.
 * Deliberately derived from the reason text (the trace is a string contract)
 * so the feed never needs the run object to render history.
 */
export type PipelineReasonTone = "failure" | "paused" | "success" | "progress";

export function pipelineReasonTone(reason: string): PipelineReasonTone {
  if (reason.startsWith("Pipeline failed:")) return "failure";
  if (reason.startsWith("Pipeline stopped:")) return "paused";
  if (reason.startsWith("Pipeline paused:")) return "paused";
  if (reason.startsWith("Pipeline finished:")) return "success";
  return "progress";
}

/* ------------------------------------------------------------------ */
/* Run snapshot shape (mirrors the registry's read API)                */
/* ------------------------------------------------------------------ */

export type PipelineState =
  | "running_build"
  | "running_review"
  | "running_fix"
  | "running_forensic"
  | "succeeded"
  | "failed"
  | "paused_question"
  | "cancelled";

export type PipelineStage = "build" | "review" | "fix" | "forensic";

export interface PipelineRunSnapshot {
  runId: string;
  projectId: string;
  epicId: string;
  userStoryId: string | null;
  state: PipelineState;
  stage: PipelineStage | null;
  stageAttempt: number;
  fixCycles: number;
  sessionIds: string[];
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
}

/** Terminal states — a run in one of these no longer holds a scheduler slot. */
export const PIPELINE_TERMINAL_STATES: readonly PipelineState[] = [
  "succeeded",
  "failed",
  "paused_question",
  "cancelled",
] as const;

export function isPipelineRunActive(state: PipelineState): boolean {
  return !PIPELINE_TERMINAL_STATES.includes(state);
}

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  build: "Build",
  review: "Review",
  fix: "Fix",
  forensic: "Forensic",
};
