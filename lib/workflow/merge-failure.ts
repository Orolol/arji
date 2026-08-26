/**
 * The activity-log contract for "this branch could not land".
 *
 * A merge that fails writes no column anywhere: the epic keeps its status,
 * its branch and its findings, and the only durable trace is a same-state
 * `ticket_activity_log` row (approve/route.ts and lib/auto-mode/merge.ts both
 * log one). That trace is what tells a Review card "merge conflict — resolve
 * first" instead of offering a Merge button that is guaranteed to 409.
 *
 * Reading it means matching prose, which is fragile the moment a writer
 * rewords its reason. So the prefixes are not retyped here: the auto-mode
 * ones are DERIVED from `AUTO_MODE_REASONS` itself (constants used whole,
 * builders probed with a sentinel argument), and the approve route's reason
 * is BUILT by this module. Reword either side and the prefix follows.
 */

import { AUTO_MODE_REASONS } from "@/lib/auto-mode/constants";

/**
 * Placeholder no reason string can contain, used to locate a builder's prefix.
 * NUL cannot occur in any of the reason templates, so its first occurrence in
 * a built string is necessarily where the argument was interpolated.
 */
const REASON_ARGUMENT_SENTINEL = "\u0000";

/** The fixed head of a reason built by `build`, up to its first argument. */
function reasonPrefix(build: (argument: string) => string): string {
  const built = build(REASON_ARGUMENT_SENTINEL);
  const index = built.indexOf(REASON_ARGUMENT_SENTINEL);
  return index === -1 ? built : built.slice(0, index);
}

/** Head of the reason `POST .../approve` logs when its merge failed. */
export const APPROVAL_MERGE_BLOCKED_PREFIX = "Approval blocked: merge of ";

/** The approve route's merge-failure reason — the only place it is spelled. */
export function buildApprovalMergeBlockedReason(input: {
  branchName: string;
  error: string;
}): string {
  return `${APPROVAL_MERGE_BLOCKED_PREFIX}${input.branchName} failed — ${input.error}`;
}

/**
 * Every reason head that means "the branch is still on the wrong side of
 * `main`, and GIT is the reason".
 *
 * Two auto-mode reasons are deliberately absent, both for the same rule:
 *
 *   - `mergeRefused` records a WORKFLOW guard refusing (no completed review,
 *     an open finding), which the readiness predicate already reports
 *     precisely. Counting it here would replace "2 open findings" with a
 *     vague "merge conflict" on every card the supervisor skipped.
 *   - `mergeRolledBack` is the same category one step later: the merge
 *     LANDED and the post-merge `→ done` guard refused, so main was put back
 *     (lib/auto-mode/merge.ts). Nothing conflicted. Because `merge_conflict`
 *     is evaluated first, admitting it here would let it outrank the accurate
 *     blocker and offer Resolve merge for a workflow problem.
 *
 * The bar is git refusing, not the merge failing to stick.
 */
export const MERGE_FAILURE_REASON_PREFIXES: readonly string[] = [
  APPROVAL_MERGE_BLOCKED_PREFIX,
  // Constants: the whole string is its own prefix.
  AUTO_MODE_REASONS.mergeConflict,
  AUTO_MODE_REASONS.mergeConflictDeferred,
  // Builders: probe for the fixed head.
  reasonPrefix((error) => AUTO_MODE_REASONS.dispatchFailed("merge", error)),
];

/** True when an activity-log reason records a merge that could not land. */
export function isMergeFailureReason(
  reason: string | null | undefined
): boolean {
  if (typeof reason !== "string") return false;
  return MERGE_FAILURE_REASON_PREFIXES.some((prefix) =>
    reason.startsWith(prefix)
  );
}

/**
 * The same prefixes as SQL `LIKE` patterns, for the board query's
 * `reason LIKE ...` filter.
 *
 * `%` and `_` are escaped with a backslash, so callers must pair these with
 * `ESCAPE '\'`. None of today's prefixes contain either character — the
 * escaping exists so a future reason that does cannot silently widen the
 * match to every activity row.
 */
export const MERGE_FAILURE_REASON_LIKE_PATTERNS: readonly string[] =
  MERGE_FAILURE_REASON_PREFIXES.map(
    (prefix) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`
  );
