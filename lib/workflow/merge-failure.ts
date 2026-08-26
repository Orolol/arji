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

/**
 * The fixed head of a reason built by `build`, up to its first argument.
 *
 * Throws on an empty head rather than returning `""`. A builder that
 * interpolates its argument first would otherwise yield a prefix that
 * `startsWith` matches on every string and a LIKE pattern of `%` — turning
 * the safety net this module exists to be into a wildcard that reports a
 * merge conflict on every card. Failing at import is the intended outcome.
 */
function reasonPrefix(build: (argument: string) => string): string {
  const built = build(REASON_ARGUMENT_SENTINEL);
  const index = built.indexOf(REASON_ARGUMENT_SENTINEL);
  const prefix = index === -1 ? built : built.slice(0, index);
  if (prefix.length === 0) {
    throw new Error(
      "merge-failure: a reason builder produced an empty prefix, which would " +
        "match every activity row. Give the reason a fixed head before its " +
        "first interpolated argument."
    );
  }
  return prefix;
}

/** Head of the reason `POST .../approve` logs when a merge hits conflicts. */
export const APPROVAL_MERGE_BLOCKED_PREFIX = "Approval blocked: merge of ";

/** The approve route's merge-conflict reason. */
export function buildApprovalMergeBlockedReason(input: {
  branchName: string;
  error: string;
}): string {
  return `${APPROVAL_MERGE_BLOCKED_PREFIX}${input.branchName} failed — ${input.error}`;
}

/** Head of the reason `POST .../approve` logs when a branch has committed conflict markers. */
export const APPROVAL_CONFLICT_MARKERS_BLOCKED_PREFIX =
  "Approval blocked: conflict markers on ";

/** The approve route's conflict-markers reason. */
export function buildApprovalConflictMarkersBlockedReason(input: {
  branchName: string;
  error: string;
}): string {
  return `${APPROVAL_CONFLICT_MARKERS_BLOCKED_PREFIX}${input.branchName} — ${input.error}`;
}


/**
 * `MergeWorktreeResult.reason` values that mean the branch has a conflict that
 * a conflict-resolution agent or Resolve merge flow can genuinely repair.
 *
 * `conflict-markers` is NOT here because dispatching an agent to merge main
 * would find a clean merge and leave committed conflict markers untouched.
 * `branch-missing` and `error` are also excluded.
 */
export const GIT_REFUSAL_MERGE_REASONS = ["conflict"] as const;

export type GitRefusalMergeReason =
  (typeof GIT_REFUSAL_MERGE_REASONS)[number];

/**
 * True when a merge verdict represents a genuine conflict that a
 * merge-resolution agent can repair.
 */
export function isGitRefusalMergeReason(
  reason: string | null | undefined
): boolean {
  if (typeof reason !== "string") return false;
  return (GIT_REFUSAL_MERGE_REASONS as readonly string[]).includes(reason);
}

/**
 * Every reason head that means "the branch is still on the wrong side of
 * `main`, and GIT is the reason".
 *
 * Three auto-mode reasons are deliberately absent, all for the same rule —
 * the blocker must name what is actually in the way, and since
 * `merge_conflict` is evaluated first it outranks whatever it displaces:
 *
 *   - `mergeRefused` records a WORKFLOW guard refusing (no completed review,
 *     an open finding), which the readiness predicate already reports
 *     precisely. Counting it here would replace "2 open findings" with a
 *     vague "merge conflict" on every card the supervisor skipped.
 *   - `mergeRolledBack` is the same category one step later: the merge
 *     LANDED and the post-merge `→ done` guard refused, so main was put back
 *     (lib/auto-mode/merge.ts). Nothing conflicted.
 *   - `dispatchFailed("merge", …)` is the supervisor's GENERIC failure trace.
 *     It covers every non-conflict git verdict at once, so it cannot tell a
 *     conflict from a deleted branch. `mergeFailed(reason, …)` carries the
 *     verdict instead, and only the conflict-shaped ones are matched below.
 *
 * The bar is git refusing over a conflict, not the merge failing to stick.
 */
/**
 * Prefixes that mean "the branch has a genuine git merge conflict against main".
 */
export const MERGE_CONFLICT_REASON_PREFIXES: readonly string[] = [
  APPROVAL_MERGE_BLOCKED_PREFIX,
  AUTO_MODE_REASONS.mergeConflict,
  AUTO_MODE_REASONS.mergeConflictDeferred,
  reasonPrefix((error) => AUTO_MODE_REASONS.mergeFailed("conflict", error)),
];

/**
 * Prefixes that mean "the branch contains committed conflict markers".
 */
export const CONFLICT_MARKERS_REASON_PREFIXES: readonly string[] = [
  APPROVAL_CONFLICT_MARKERS_BLOCKED_PREFIX,
  reasonPrefix((error) =>
    AUTO_MODE_REASONS.mergeFailed("conflict-markers", error)
  ),
];

export const MERGE_FAILURE_REASON_PREFIXES: readonly string[] = [
  ...MERGE_CONFLICT_REASON_PREFIXES,
  ...CONFLICT_MARKERS_REASON_PREFIXES,
];

/** True when an activity-log reason records a merge conflict. */
export function isMergeConflictReason(
  reason: string | null | undefined
): boolean {
  if (typeof reason !== "string") return false;
  return MERGE_CONFLICT_REASON_PREFIXES.some((prefix) =>
    reason.startsWith(prefix)
  );
}

/** True when an activity-log reason records committed conflict markers. */
export function isConflictMarkersReason(
  reason: string | null | undefined
): boolean {
  if (typeof reason !== "string") return false;
  return CONFLICT_MARKERS_REASON_PREFIXES.some((prefix) =>
    reason.startsWith(prefix)
  );
}

/** True when an activity-log reason records any merge failure. */
export function isMergeFailureReason(
  reason: string | null | undefined
): boolean {
  if (typeof reason !== "string") return false;
  return MERGE_FAILURE_REASON_PREFIXES.some((prefix) =>
    reason.startsWith(prefix)
  );
}

export const MERGE_CONFLICT_REASON_LIKE_PATTERNS: readonly string[] =
  MERGE_CONFLICT_REASON_PREFIXES.map(
    (prefix) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`
  );

export const CONFLICT_MARKERS_REASON_LIKE_PATTERNS: readonly string[] =
  CONFLICT_MARKERS_REASON_PREFIXES.map(
    (prefix) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`
  );

export const MERGE_FAILURE_REASON_LIKE_PATTERNS: readonly string[] =
  MERGE_FAILURE_REASON_PREFIXES.map(
    (prefix) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`
  );
export const __testables = { reasonPrefix };
