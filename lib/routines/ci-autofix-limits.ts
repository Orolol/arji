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
  failures: readonly CiAutofixEvidenceLike[],
): number {
  return failures.reduce(
    (total, failure) =>
      total +
      Buffer.byteLength(failure.name, "utf8") +
      (failure.logTail === null
        ? 0
        : Buffer.byteLength(failure.logTail, "utf8")),
    0,
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
 *
 * `logPriority` (lower wins) decides which failures spend the shared budget
 * first; entries without it keep their input order. Output always preserves
 * the caller's display order, so a fail-fast matrix cannot starve the one
 * job that actually failed just because its name sorts late.
 */
export function boundCiAutofixEvidence<T extends CiAutofixEvidenceLike>(
  failures: readonly T[],
  logPriority?: (failure: T) => number,
): T[] {
  const bounded = failures.slice(0, CI_AUTOFIX_MAX_FAILURES).map((failure) => ({
    ...failure,
    name: utf8Head(failure.name.trim(), CI_AUTOFIX_MAX_FAILURE_NAME_BYTES),
  }));
  const nonEmpty = bounded.filter((failure) => failure.name.length > 0);
  const nameBytes = nonEmpty.reduce(
    (total, failure) => total + Buffer.byteLength(failure.name, "utf8"),
    0,
  );
  let remainingBytes = Math.max(0, CI_AUTOFIX_MAX_EVIDENCE_BYTES - nameBytes);

  const bindOrder = nonEmpty
    .map((failure, index) => ({ failure, index }))
    .sort((left, right) => {
      const leftRank = logPriority ? logPriority(left.failure) : left.index;
      const rightRank = logPriority ? logPriority(right.failure) : right.index;
      return leftRank - rightRank || left.index - right.index;
    });

  const boundTails = new Map<T, string | null>();
  for (const { failure } of bindOrder) {
    if (!failure.logTail || remainingBytes === 0) {
      boundTails.set(failure, null);
      continue;
    }
    const perCheckTail = failure.logTail.slice(-CI_AUTOFIX_MAX_LOG_TAIL_CHARS);
    const tail = utf8Tail(perCheckTail, remainingBytes) || null;
    boundTails.set(failure, tail);
    remainingBytes -= tail === null ? 0 : Buffer.byteLength(tail, "utf8");
  }

  return nonEmpty.map((failure) => ({
    ...failure,
    logTail: boundTails.get(failure) ?? null,
  }));
}
