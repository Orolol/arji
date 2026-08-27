/**
 * Detection of "the session you asked me to resume is gone".
 *
 * Lives in its own module so it can be unit-tested against the exact strings
 * the CLIs emit: Next.js route files may only export route handlers, so a
 * helper defined inside one cannot be covered directly.
 *
 * Phrasings measured on the installed CLIs (2026-08-27):
 * - `claude` 2.1.245 — `No conversation found with session ID: <uuid>`
 * - `omp` 18.0.6 — `Error: Session "<uuid>" not found.`
 *
 * Claude puts the noun *before* the negation, which the original
 * `(session|resume).*(not found|…)` shape could not match — so resume expiry
 * went undetected on the default provider and its conversations had no
 * recovery path once the CLI pruned the session file.
 */
const RESUME_EXPIRY_PATTERNS: RegExp[] = [
  // `Session "<id>" not found.` / `session … expired` — noun first, bounded
  // so an unrelated later sentence cannot pair with an early "session".
  /(session|conversation).{0,80}?(expired|not found|no longer exists|does not exist)/i,
  // `No conversation found with session ID: <id>` — negation first.
  /\bno (conversation|session)\b.{0,40}?\bfound\b/i,
  // `Invalid session id` / `unknown resume target`
  /\b(invalid|unknown|unrecognized)\s+(session|conversation|resume)/i,
];

export function isResumeSessionExpiredError(
  error: string | null | undefined,
): boolean {
  if (!error) return false;
  return RESUME_EXPIRY_PATTERNS.some((pattern) => pattern.test(error));
}
