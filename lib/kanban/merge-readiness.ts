/**
 * "Ready to merge" — the single derived signal behind Full Auto's merge step
 * AND the Review column's upper section.
 *
 * There is deliberately no `to_merge` status: readiness is a FUNCTION of
 * facts the board already stores (the epic's status and branch, its open
 * review findings, when it was last cleanly reviewed, when its branch last
 * changed, when a merge last failed). A status would have to be written by
 * someone, and every writer is a chance for the board to disagree with the
 * supervisor about what "ready" means.
 *
 * This module is the one definition. `selectMergeCandidates`
 * (lib/auto-mode/select.ts) evaluates it over its sweep snapshot; the board
 * API evaluates it over its list query. Both call the same function, so
 * neither side can drift into its own idea of "ready" — which is exactly
 * what a second implementation would introduce.
 *
 * The two callers are not identical sets, and both differences are
 * deliberate: the board also passes `lastMergeFailureAt` (auto-mode carries
 * that fact in its own registry backoff instead), and auto-mode additionally
 * applies the runtime exclusions below. What they share is the definition of
 * ready.
 *
 * Client-safe by convention (lib/kanban/*): pure functions, no database, no
 * server imports.
 *
 * What is NOT here, on purpose: the supervisor's RUNTIME exclusions — a busy
 * ticket, a live pipeline/night-run owner, a parked ticket, a merge backoff.
 * Those live in in-memory registries, describe whether the supervisor may act
 * *right now*, and say nothing about whether the work is ready. Auto-mode
 * applies them alongside this predicate (see `selectMergeCandidates`).
 */

/**
 * Why an epic in Review cannot be merged, most actionable first. The order of
 * this union is the order `evaluateMergeReadiness` checks in, which is also
 * the order the card reports in.
 */
export type MergeBlocker =
  | "not_in_review"
  | "merge_conflict"
  | "conflict_markers"
  | "open_findings"
  | "no_review"
  | "stale_review"
  | "no_branch";
export interface MergeReadinessFacts {
  /** Board status of the epic. Only `review` can ever be merge-ready. */
  status?: string | null;
  /** The epic's integration branch; without one there is nothing to land. */
  branchName?: string | null;
  /** Open `review_comments` on the epic — the blocking findings. */
  openFindings?: number | null;
  /**
   * Newest epic-scoped review session that completed with a verdict that was
   * not `changes_requested`. See SessionFacts in lib/auto-mode/select.ts for
   * what each exclusion buys.
   */
  lastCleanReviewAt?: string | null;
  /**
   * Newest terminal code-writing session on the epic, story-scoped ones
   * included: a story build commits to the epic's branch, so a review that
   * predates it is stale.
   */
  lastTerminalCodeAt?: string | null;
  /**
   * Newest activity-log entry recording a merge that could not land
   * (see lib/workflow/merge-failure.ts). Absent for callers that do not
   * track it — auto-mode carries the same fact in its own registry backoff.
   */
  lastMergeFailureAt?: string | null;
  /** Newest activity entry recording a git merge conflict. */
  lastMergeConflictAt?: string | null;
  /** Newest activity entry recording committed conflict markers. */
  lastConflictMarkersAt?: string | null;
}

export interface MergeReadiness {
  ready: boolean;
  /** `null` exactly when `ready` is true. */
  blocker: MergeBlocker | null;
  /** Echoed so the UI can say "2 open findings" without a second lookup. */
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
 * The merge gate's freshness half: a review that COMPLETED WITH A VERDICT
 * after the last code change.
 *
 * Stricter than the workflow engine's `hasCompletedReview` on both axes —
 * the engine accepts any completed review session ever, including one that
 * merely asked a question or produced nothing. That laxity is exactly what
 * this compensates for; the engine's guard stays the floor, not the ceiling.
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
 * conflict flag clears on its own — and the review it invalidated becomes
 * stale, which is the honest next blocker.
 */
export function hasCurrentMergeFailure(
  facts: Pick<
    MergeReadinessFacts,
    "lastMergeFailureAt" | "lastMergeConflictAt" | "lastConflictMarkersAt" | "lastTerminalCodeAt"
  > | undefined
): boolean {
  return hasCurrentMergeConflict(facts) || hasCurrentConflictMarkers(facts);
}

export function hasCurrentMergeConflict(
  facts: Pick<
    MergeReadinessFacts,
    "lastMergeFailureAt" | "lastMergeConflictAt" | "lastTerminalCodeAt"
  > | undefined
): boolean {
  const failed = normalizeAt(facts?.lastMergeConflictAt ?? facts?.lastMergeFailureAt);
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
 * The predicate. Order of the checks IS the display order: the first thing
 * standing between this epic and `main` is what the card reports, so a
 * conflict (git cannot land it at all) outranks findings (the code needs
 * work), which outrank a stale review (a reviewer needs to run).
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

  if (facts?.status !== "review") return blocked("not_in_review");

  const hasConflict = hasCurrentMergeConflict(facts);
  const hasMarkers = hasCurrentConflictMarkers(facts);
  if (hasConflict && hasMarkers) {
    const conflictAt = normalizeAt(facts?.lastMergeConflictAt ?? facts?.lastMergeFailureAt);
    const markersAt = normalizeAt(facts?.lastConflictMarkersAt);
    return markersAt && conflictAt && markersAt > conflictAt
      ? blocked("conflict_markers")
      : blocked("merge_conflict");
  }
  if (hasConflict) return blocked("merge_conflict");
  if (hasMarkers) return blocked("conflict_markers");
  if (openFindings > 0) return blocked("open_findings");
  if (!facts.lastCleanReviewAt) return blocked("no_review");
  if (!hasFreshCleanReview(facts)) return blocked("stale_review");
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
 * One short, actionable line for a Review card that is not ready.
 *
 * Returns `null` for a ready epic and for `not_in_review` — a card outside
 * the Review column has no business explaining why it cannot be merged.
 */
export function describeMergeBlocker(
  readiness: MergeReadiness | null | undefined
): string | null {
  switch (readiness?.blocker) {
    case "merge_conflict":
      return "Merge conflict — resolve before merging";
    case "conflict_markers":
      return "Branch contains unresolved conflict markers";
    case "open_findings":
      return readiness.openFindings === 1
        ? "1 open finding"
        : `${readiness.openFindings} open findings`;
    case "no_review":
      return "Awaiting review";
    case "stale_review":
      return "Review outdated — new commit since";
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
 * Review-column order: ready-to-merge first, then board position within each
 * group.
 *
 * Sorting HERE rather than in the column component is what keeps membership
 * derived and non-draggable. The board hands one array down in this exact
 * order, so drag indices, the optimistic reorder and the persisted positions
 * all agree with what the user sees; a card dropped into the "wrong" section
 * keeps its new position but snaps back to the section its signal dictates.
 */
export function sortReviewColumn<
  T extends MergeReadinessCarrier & { position: number },
>(epics: readonly T[]): T[] {
  return [...epics].sort((a, b) => {
    const readiness = Number(isMergeReadyEpic(b)) - Number(isMergeReadyEpic(a));
    if (readiness !== 0) return readiness;
    return a.position - b.position;
  });
}
