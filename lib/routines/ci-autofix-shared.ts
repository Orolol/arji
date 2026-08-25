import type { PullRequestCiFailureEvidence } from "@/lib/github/pull-requests";
import {
  CI_AUTOFIX_MAX_EVIDENCE_BYTES,
  CI_AUTOFIX_MAX_FAILURES,
  CI_AUTOFIX_MAX_FAILURE_NAME_BYTES,
  CI_AUTOFIX_MAX_LOG_TAIL_CHARS,
  ciAutofixEvidenceBytes,
} from "@/lib/routines/ci-autofix-limits";

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
    Buffer.byteLength(candidate.name, "utf8") >
      CI_AUTOFIX_MAX_FAILURE_NAME_BYTES ||
    (candidate.logTail !== null && typeof candidate.logTail !== "string") ||
    (typeof candidate.logTail === "string" &&
      candidate.logTail.length > CI_AUTOFIX_MAX_LOG_TAIL_CHARS)
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
    candidate.failures.length > CI_AUTOFIX_MAX_FAILURES
  ) {
    return null;
  }

  const failures = candidate.failures.map(parseFailure);
  if (failures.some((failure) => failure === null)) return null;
  const parsedFailures = failures as PullRequestCiFailureEvidence[];
  if (ciAutofixEvidenceBytes(parsedFailures) > CI_AUTOFIX_MAX_EVIDENCE_BYTES) {
    return null;
  }
  return {
    prNumber: candidate.prNumber as number,
    headSha: candidate.headSha.trim(),
    failures: parsedFailures,
  };
}
