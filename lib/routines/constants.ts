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
] as const;

export type RoutineKind = (typeof ROUTINE_KINDS)[number];

export const AVAILABLE_ROUTINE_KINDS = [
  "night_run",
  "github_issue_sync",
  "ci_watch",
] as const satisfies readonly RoutineKind[];

export type AvailableRoutineKind = (typeof AVAILABLE_ROUTINE_KINDS)[number];

export const ROUTINE_KIND_LABELS: Record<RoutineKind, string> = {
  night_run: "Night run",
  dreaming: "Dreaming",
  github_issue_sync: "GitHub issue sync",
  ci_watch: "CI watch",
};

export const ROUTINE_KIND_DESCRIPTIONS: Record<AvailableRoutineKind, string> = {
  night_run:
    "Starts the canonical dependency-aware night run for eligible tickets.",
  github_issue_sync:
    "Runs daily and refreshes open GitHub issues when the configured freshness TTL has expired.",
  ci_watch:
    "Polls open pull requests and reports newly failing CI checks by head SHA.",
};

export function isAvailableRoutineKind(
  value: unknown
): value is AvailableRoutineKind {
  return (AVAILABLE_ROUTINE_KINDS as readonly unknown[]).includes(value);
}

export function isDailyRoutineKind(
  kind: RoutineKind
): kind is Extract<RoutineKind, "night_run" | "github_issue_sync"> {
  return kind === "night_run" || kind === "github_issue_sync";
}

export function defaultRoutineConfig(
  kind: AvailableRoutineKind
): Record<string, unknown> {
  switch (kind) {
    case "night_run":
      return { includeBacklog: false, failurePolicy: "halt" };
    case "github_issue_sync":
    case "ci_watch":
      return { intervalMinutes: 15 };
  }
}
