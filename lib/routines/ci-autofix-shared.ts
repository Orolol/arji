import type { PullRequestCiFailureEvidence } from "@/lib/github/pull-requests";

export const CI_AUTOFIX_ATTEMPT_PREFIX = "ci-autofix";

export interface CiAutofixPayload {
  prNumber: number;
  headSha: string;
  failures: PullRequestCiFailureEvidence[];
}

/** Durable attribution stored on agent_sessions.batch_run_id. */
export function ciAutofixAttemptId(input: {
  epicId: string;
  prNumber: number;
  headSha: string;
}): string {
  return `${CI_AUTOFIX_ATTEMPT_PREFIX}:${input.epicId}:pr-${input.prNumber}:${input.headSha}`;
}

function parseFailure(value: unknown): PullRequestCiFailureEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { name?: unknown; logTail?: unknown };
  if (
    typeof candidate.name !== "string" ||
    candidate.name.trim().length === 0 ||
    candidate.name.length > 256 ||
    (candidate.logTail !== null && typeof candidate.logTail !== "string") ||
    (typeof candidate.logTail === "string" && candidate.logTail.length > 20_000)
  ) {
    return null;
  }
  return {
    name: candidate.name.trim(),
    logTail: candidate.logTail,
  };
}

/** Strict server-side validation for the internal build-route hand-off. */
export function parseCiAutofixPayload(value: unknown): CiAutofixPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as {
    prNumber?: unknown;
    headSha?: unknown;
    failures?: unknown;
  };
  if (
    !Number.isInteger(candidate.prNumber) ||
    (candidate.prNumber as number) < 1 ||
    typeof candidate.headSha !== "string" ||
    candidate.headSha.trim().length === 0 ||
    candidate.headSha.length > 128 ||
    !Array.isArray(candidate.failures) ||
    candidate.failures.length === 0 ||
    candidate.failures.length > 100
  ) {
    return null;
  }

  const failures = candidate.failures.map(parseFailure);
  if (failures.some((failure) => failure === null)) return null;
  return {
    prNumber: candidate.prNumber as number,
    headSha: candidate.headSha.trim(),
    failures: failures as PullRequestCiFailureEvidence[],
  };
}
