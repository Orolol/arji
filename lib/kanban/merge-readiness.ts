/**
 * "Ready to merge" — the single derived signal behind Full Auto's merge step
 * AND the To Merge column's ordering.
 *
 * The `to_merge` STATUS says a review passed: the review agent's verdict is
 * the approval step of the workflow, and only the transition service writes
 * that status (review → to_merge, source "review"). What this module adds are
 * the GIT-side facts a status cannot carry: is there a branch to land, and is
 * a recorded merge failure still current? Ready means "a merge click will
 * plausibly land on main right now".
 *
 * This module is the one definition. `selectMergeCandidates`
 * (lib/auto-mode/select.ts) evaluates it over its sweep snapshot; the board
 * API evaluates it over its list query. Both call the same function, so
 * neither side can drift into its own idea of "ready".
 *
 * Open findings do NOT block a merge any more: the merge IS the approval, and
 * whatever stayed open is resolved by the merge itself
 * (lib/workflow/merge-approval.ts). The count is still echoed so cards can
 * show it as information.
 *
 * Client-safe by convention (lib/kanban/*): pure functions, no database, no
 * server imports.
 *
 * What is NOT here, on purpose: the supervisor's RUNTIME exclusions — a busy
 * ticket, a live pipeline/night-run owner, a parked ticket, a merge backoff.
 * Those live in in-memory registries, describe whether the supervisor may act
 * *right now*, and say nothing about whether the work is ready. Nor is
 * `hasStoryStillToBuild`, which gates the unattended merge but not the human
 * one. Auto-mode applies both alongside this predicate (see
 * `selectMergeCandidates`).
 */

/**
 * Why an epic in To Merge cannot be merged, most actionable first. The order
 * of this union is the order `evaluateMergeReadiness` checks in, which is
 * also the order the card reports in.
 */
export type MergeBlocker =
  | "not_to_merge"
  | "merge_conflict"
  | "conflict_markers"
  | "changes_requested"
  | "no_branch";
export interface MergeReadinessFacts {
  /** Board status of the epic. Only `to_merge` can ever be merge-ready. */
  status?: string | null;
  /** The epic's integration branch; without one there is nothing to land. */
  branchName?: string | null;
  /**
   * Open `review_comments` on the epic that still stand — echoed as
   * information, not a gate.
   *
   * A merge IS the approval and resolves whatever is left
   * (lib/workflow/merge-approval.ts), so this count never refuses a merge.
   * It is still narrowed rather than raw (see
   * lib/workflow/blocking-findings.ts, which both callers evaluate): a
   * `[minor]` the approving reviewer filed itself, or a `[major]` a later
   * clean verdict has since read, is not a finding to put on the card.
   */
  openFindings?: number | null;
  /**
   * Newest epic-scoped review session that completed with a verdict that was
   * not `changes_requested`. Feeds `hasFreshCleanReview`, which the Full Auto
   * selector's `needsReview` uses as its anti-loop; readiness itself no
   * longer reads it — the `to_merge` status is the review's verdict.
   */
  lastCleanReviewAt?: string | null;
  /**
   * Newest terminal code-writing session on the epic, story-scoped ones
   * included: a story build commits to the epic's branch, so a review that
   * predates it is stale.
   *
   */
  lastTerminalCodeAt?: string | null;
  /**
   * When the newest review that recorded `changes_requested` started, and the
   * supersession cutoff (lib/workflow/review-freshness.ts) — the newest code
   * change a recorded clean verdict has since read.
   *
   * Together they answer "is a rejection still unanswered", which nothing
   * else here can: `lastCleanReviewAt` is a MAX over clean rounds, so a later
   * rejection leaves it untouched at the older approving round and is simply
   * invisible to it. The workflow engine gained that guard first; without
   * these the board would keep offering Full Auto a candidate the engine
   * refuses — and `tryAutoMerge` merges with git before it validates, so the
   * disagreement costs a merge and a rollback on every sweep.
   */
  lastNegativeVerdictReviewAt?: string | null;
  supersessionAt?: string | null;
  /** Newest activity entry recording a git merge conflict. */
  lastMergeConflictAt?: string | null;
  /** Newest activity entry recording committed conflict markers. */
  lastConflictMarkersAt?: string | null;
}

export interface MergeReadiness {
  ready: boolean;
  /** `null` exactly when `ready` is true. */
  blocker: MergeBlocker | null;
  /**
   * Blocking open findings, echoed so the UI can say "2 open findings"
   * without a second lookup. See `MergeReadinessFacts.openFindings` for why
   * this is narrower than the epic's raw open-row count.
   */
  openFindings: number;
}

/**
 * Timestamps mix ISO-8601 (`2026-08-16T09:00:00.000Z`, written by routes)
 * and SQLite CURRENT_TIMESTAMP (`2026-08-16 09:00:00`, also UTC). Normalizing
 * the separator makes lexicographic comparison chronologically correct — the
 * same normalization lib/kanban/awaiting-reply.ts does.
 */
function normalizeAt(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.includes("T") ? value : value.replace(" ", "T");
}

/**
 * A review that COMPLETED WITH A VERDICT after the last code change.
 *
 * Not part of merge readiness any more — the `to_merge` status already
 * carries the verdict — but still the Full Auto selector's `needsReview`
 * anti-loop: a Review-column epic with a fresh clean review earns a promotion
 * or a park, never another identical review.
 */
export function hasFreshCleanReview(
  facts: Pick<
    MergeReadinessFacts,
    "lastCleanReviewAt" | "lastTerminalCodeAt"
  > | undefined
): boolean {
  const reviewed = normalizeAt(facts?.lastCleanReviewAt);
  if (!reviewed) return false;
  const coded = normalizeAt(facts?.lastTerminalCodeAt);
  if (!coded) return true;
  return reviewed > coded;
}

/**
 * Is a recorded merge failure still the current state of the branch?
 *
 * Only if nothing has touched the branch since. A merge-fix session counts as
 * a code session (`merge` is in the code agent types), so once one runs the
 * conflict flag clears on its own.
 */
export function hasCurrentMergeConflict(
  facts: Pick<
    MergeReadinessFacts,
    "lastMergeConflictAt" | "lastTerminalCodeAt"
  > | undefined
): boolean {
  const failed = normalizeAt(facts?.lastMergeConflictAt);
  if (!failed) return false;
  const coded = normalizeAt(facts?.lastTerminalCodeAt);
  if (!coded) return true;
  return failed > coded;
}

export function hasCurrentConflictMarkers(
  facts: Pick<
    MergeReadinessFacts,
    "lastConflictMarkersAt" | "lastTerminalCodeAt"
  > | undefined
): boolean {
  const markers = normalizeAt(facts?.lastConflictMarkersAt);
  if (!markers) return false;
  const coded = normalizeAt(facts?.lastTerminalCodeAt);
  if (!coded) return true;
  return markers > coded;
}

/**
 * Is a `changes_requested` verdict still unanswered?
 *
 * A rejection is answered by a FIX that a reviewer has since read — exactly
 * what the supersession cutoff means, and exactly what answers a finding. So
 * the rejection stands unless a code change LANDED AFTER IT and a clean
 * verdict has since read that code.
 *
 * The second half is the one that is easy to lose. Without it another opinion
 * of the same commit overturns the first: `review_code` rejects,
 * `review_security` approves an untouched branch, and the rejection quietly
 * evaporates although nothing it objected to changed. A verdict speaks for
 * the code it read, and neither reviewer read anything the other did not.
 * (A NULL-verdict review clears nothing either — it never reaches the cutoff.)
 *
 * Shared by the board, `selectMergeCandidates` and `buildTransitionContext`
 * so all three read one definition; the engine's merge guard is this fact.
 */
export function hasStandingNegativeVerdict(
  facts: Pick<
    MergeReadinessFacts,
    "lastNegativeVerdictReviewAt" | "supersessionAt"
  > | null | undefined
): boolean {
  const rejected = normalizeAt(facts?.lastNegativeVerdictReviewAt);
  if (!rejected) return false;
  const answered = normalizeAt(facts?.supersessionAt);
  return !(answered && rejected < answered);
}

/**
 * The predicate. Order of the checks IS the display order: the first thing
 * standing between this epic and `main` is what the card reports, so a
 * conflict (git cannot land it at all) outranks a standing rejection (the
 * code needs work), which outranks a missing branch.
 */
export function evaluateMergeReadiness(
  facts: MergeReadinessFacts | null | undefined
): MergeReadiness {
  const openFindings = Math.max(0, Math.trunc(Number(facts?.openFindings ?? 0)) || 0);
  const blocked = (blocker: MergeBlocker): MergeReadiness => ({
    ready: false,
    blocker,
    openFindings,
  });

  if (facts?.status !== "to_merge") return blocked("not_to_merge");

  const hasConflict = hasCurrentMergeConflict(facts);
  const hasMarkers = hasCurrentConflictMarkers(facts);
  if (hasConflict && hasMarkers) {
    const conflictAt = normalizeAt(facts?.lastMergeConflictAt);
    const markersAt = normalizeAt(facts?.lastConflictMarkersAt);
    return markersAt && conflictAt && markersAt > conflictAt
      ? blocked("conflict_markers")
      : blocked("merge_conflict");
  }
  if (hasConflict) return blocked("merge_conflict");
  if (hasMarkers) return blocked("conflict_markers");
  // Open findings are NOT a blocker: the merge resolves them
  // (lib/workflow/merge-approval.ts), and gating on them is what produced
  // epics that could never leave the column. Neither is review freshness —
  // the `to_merge` status IS the passing verdict. What survives is the one
  // review fact the status cannot express: a `changes_requested` verdict
  // recorded since, with no fix a reviewer has read. The workflow engine
  // refuses that merge (lib/workflow/engine.ts), so the board must not offer
  // it — `tryAutoMerge` merges with git before it validates, and the
  // disagreement would cost a merge and a rollback on every sweep.
  if (hasStandingNegativeVerdict(facts)) return blocked("changes_requested");
  if (!facts.branchName) return blocked("no_branch");

  return { ready: true, blocker: null, openFindings };
}

/** Convenience wrapper for call sites that only need the boolean. */
export function isMergeReady(
  facts: MergeReadinessFacts | null | undefined
): boolean {
  return evaluateMergeReadiness(facts).ready;
}

/**
 * One short, actionable line for a To Merge card that is not ready.
 *
 * Returns `null` for a ready epic and for `not_to_merge` — a card outside
 * the To Merge column has no business explaining why it cannot be merged.
 */
export function describeMergeBlocker(
  readiness: MergeReadiness | null | undefined
): string | null {
  switch (readiness?.blocker) {
    case "merge_conflict":
      return "Merge conflict — resolve before merging";
    case "conflict_markers":
      return "Branch contains unresolved conflict markers";
    case "changes_requested":
      return "Changes requested — awaiting a fix";
    case "no_branch":
      return "No branch to merge";
    default:
      return null;
  }
}

/** A board row carrying the signal the API derived for it. */
export interface MergeReadinessCarrier {
  mergeReadiness?: MergeReadiness | null;
}

/** True when the API said this epic is ready to merge. */
export function isMergeReadyEpic(epic: MergeReadinessCarrier): boolean {
  return epic.mergeReadiness?.ready === true;
}

/**
 * To Merge column order: ready-to-merge first (conflicted branches sink),
 * then board position within each group.
 *
 * Sorting HERE rather than in the column component is what keeps membership
 * derived and non-draggable. The board hands one array down in this exact
 * order, so drag indices, the optimistic reorder and the persisted positions
 * all agree with what the user sees; a card dropped into the "wrong" section
 * keeps its new position but snaps back to the section its signal dictates.
 */
export function sortMergeColumn<
  T extends MergeReadinessCarrier & { position: number },
>(epics: readonly T[]): T[] {
  return [...epics].sort((a, b) => {
    const readiness = Number(isMergeReadyEpic(b)) - Number(isMergeReadyEpic(a));
    if (readiness !== 0) return readiness;
    return a.position - b.position;
  });
}
