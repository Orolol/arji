export const CI_AUTOFIX_MAX_FAILURES = 100;
export const CI_AUTOFIX_MAX_LOGGED_FAILURES = 12;
export const CI_AUTOFIX_MAX_FAILURE_NAME_BYTES = 256;
export const CI_AUTOFIX_MAX_LOG_TAIL_CHARS = 8_000;
export const CI_AUTOFIX_MAX_EVIDENCE_BYTES = 60_000;

export interface CiAutofixEvidenceLike {
  name: string;
  logTail: string | null;
}

export function ciAutofixEvidenceBytes(
  failures: readonly CiAutofixEvidenceLike[]
): number {
  return failures.reduce(
    (total, failure) =>
      total +
      Buffer.byteLength(failure.name, "utf8") +
      (failure.logTail === null
        ? 0
        : Buffer.byteLength(failure.logTail, "utf8")),
    0
  );
}

function utf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const codePoints = Array.from(value);
  let usedBytes = 0;
  let start = codePoints.length;
  while (start > 0) {
    const nextBytes = Buffer.byteLength(codePoints[start - 1], "utf8");
    if (usedBytes + nextBytes > maxBytes) break;
    usedBytes += nextBytes;
    start -= 1;
  }
  return codePoints.slice(start).join("");
}

function utf8Head(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const result: string[] = [];
  let usedBytes = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, "utf8");
    if (usedBytes + nextBytes > maxBytes) break;
    result.push(codePoint);
    usedBytes += nextBytes;
  }
  return result.join("");
}

/**
 * Keep every bounded check name while limiting downloadable log evidence to
 * one argv-safe global byte budget. Log tails retain their newest bytes.
 */
export function boundCiAutofixEvidence<T extends CiAutofixEvidenceLike>(
  failures: readonly T[]
): T[] {
  const bounded = failures.slice(0, CI_AUTOFIX_MAX_FAILURES).map((failure) => ({
    ...failure,
    name: utf8Head(failure.name.trim(), CI_AUTOFIX_MAX_FAILURE_NAME_BYTES),
  }));
  const nonEmpty = bounded.filter((failure) => failure.name.length > 0);
  const nameBytes = nonEmpty.reduce(
    (total, failure) => total + Buffer.byteLength(failure.name, "utf8"),
    0
  );
  let remainingBytes = Math.max(0, CI_AUTOFIX_MAX_EVIDENCE_BYTES - nameBytes);

  return nonEmpty.map((failure) => {
    if (!failure.logTail || remainingBytes === 0) {
      return { ...failure, logTail: null };
    }
    const perCheckTail = failure.logTail.slice(-CI_AUTOFIX_MAX_LOG_TAIL_CHARS);
    const logTail = utf8Tail(perCheckTail, remainingBytes);
    remainingBytes -= Buffer.byteLength(logTail, "utf8");
    return { ...failure, logTail: logTail || null };
  });
}
