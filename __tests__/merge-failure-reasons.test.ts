/**
 * The activity-log contract for a merge that could not land
 * (lib/workflow/merge-failure.ts).
 *
 * These assertions are the coupling: the board recognises a failed merge by
 * matching reason prefixes, so if a writer rewords its reason without the
 * matcher following, THIS is what fails — not a card that quietly stops
 * warning about a conflict.
 */
import { describe, it, expect } from "vitest";
import { AUTO_MODE_REASONS } from "@/lib/auto-mode/constants";
import {
  APPROVAL_MERGE_BLOCKED_PREFIX,
  APPROVAL_CONFLICT_MARKERS_BLOCKED_PREFIX,
  buildMergeBlockedReason,
  buildMergeConflictMarkersBlockedReason,
  GIT_REFUSAL_MERGE_REASONS,
  isGitRefusalMergeReason,
  isMergeConflictReason,
  isConflictMarkersReason,
  isMergeFailureReason,
  MERGE_CONFLICT_REASON_PREFIXES,
  CONFLICT_MARKERS_REASON_PREFIXES,
  MERGE_FAILURE_REASON_LIKE_PATTERNS,
  MERGE_FAILURE_REASON_PREFIXES,
} from "@/lib/workflow/merge-failure";

describe("isMergeFailureReason", () => {
  it("recognises every reason auto-mode logs when git refuses the branch", () => {
    expect(isMergeFailureReason(AUTO_MODE_REASONS.mergeConflict)).toBe(true);
    expect(isMergeFailureReason(AUTO_MODE_REASONS.mergeConflictDeferred)).toBe(
      true
    );
    expect(
      isMergeFailureReason(AUTO_MODE_REASONS.mergeFailed("conflict", "boom"))
    ).toBe(true);
    expect(
      isMergeFailureReason(
        AUTO_MODE_REASONS.mergeFailed("conflict-markers", "boom")
      )
    ).toBe(true);
  });

  it("ignores git verdicts that are NOT conflicts", () => {
    // A deleted branch or a broken repo is not something Resolve merge can
    // repair — that button would cut a fresh branch and merge an empty diff.
    expect(
      isMergeFailureReason(
        AUTO_MODE_REASONS.mergeFailed("branch-missing", "no such branch")
      )
    ).toBe(false);
    expect(
      isMergeFailureReason(AUTO_MODE_REASONS.mergeFailed("error", "boom"))
    ).toBe(false);
  });

  it("ignores the supervisor's generic merge dispatch-failure trace", () => {
    // It covers every non-conflict verdict at once, so it cannot tell a
    // conflict from a missing branch. `mergeFailed` carries the verdict.
    expect(
      isMergeFailureReason(AUTO_MODE_REASONS.dispatchFailed("merge", "boom"))
    ).toBe(false);
  });

  it("still recognises the RETIRED approve route's blocked-merge rows", () => {
    // The route is gone (the merge is the approval now), but the rows it wrote
    // are permanent activity history — built inline from the surviving prefix.
    const reason =
      `${APPROVAL_MERGE_BLOCKED_PREFIX}feature/epic-1 failed — ` +
      "CONFLICT (content): Merge conflict in lib/db/schema.ts";
    expect(isMergeFailureReason(reason)).toBe(true);
    expect(isMergeConflictReason(reason)).toBe(true);
    expect(isConflictMarkersReason(reason)).toBe(false);
  });

  it("still recognises the RETIRED approve route's conflict-markers rows", () => {
    const reason =
      `${APPROVAL_CONFLICT_MARKERS_BLOCKED_PREFIX}feature/epic-1 — ` +
      "Unresolved conflict markers in lib/db/schema.ts";
    expect(isMergeFailureReason(reason)).toBe(true);
    expect(isConflictMarkersReason(reason)).toBe(true);
    expect(isMergeConflictReason(reason)).toBe(false);
  });
  it("recognises the direct merge route's blocked-merge reason", () => {
    const reason = buildMergeBlockedReason({
      branchName: "feature/epic-1",
      error: "CONFLICT (content): Merge conflict in lib/db/schema.ts",
    });
    expect(isMergeFailureReason(reason)).toBe(true);
    expect(isMergeConflictReason(reason)).toBe(true);
    expect(isConflictMarkersReason(reason)).toBe(false);
    expect(reason).toContain("feature/epic-1");
    expect(reason).toContain("Merge conflict in lib/db/schema.ts");
  });

  it("recognises the direct merge route's conflict-markers reason", () => {
    const reason = buildMergeConflictMarkersBlockedReason({
      branchName: "feature/epic-1",
      error: "Unresolved conflict markers in lib/db/schema.ts",
    });
    expect(isMergeFailureReason(reason)).toBe(true);
    expect(isConflictMarkersReason(reason)).toBe(true);
    expect(isMergeConflictReason(reason)).toBe(false);
  });

  it("ignores a WORKFLOW refusal — the readiness predicate explains those better", () => {
    expect(
      isMergeFailureReason(
        AUTO_MODE_REASONS.mergeRefused("Review comments are still open")
      )
    ).toBe(false);
  });

  it("ignores a rollback: the merge LANDED, a guard refused, git never did", () => {
    // `mergeRolledBack` is logged when the post-merge `→ done` guard refused
    // and main was put back. Calling that a conflict would paint the card red
    // and — since `merge_conflict` is checked first — hide the real blocker.
    expect(
      isMergeFailureReason(
        AUTO_MODE_REASONS.mergeRolledBack("Review comments are still open")
      )
    ).toBe(false);
  });

  it("ignores dispatch failures from the other stages", () => {
    expect(
      isMergeFailureReason(AUTO_MODE_REASONS.dispatchFailed("build", "boom"))
    ).toBe(false);
    expect(
      isMergeFailureReason(AUTO_MODE_REASONS.dispatchFailed("review", "boom"))
    ).toBe(false);
  });

  it("refuses a reason builder whose prefix would match everything", async () => {
    // An empty prefix turns startsWith into a tautology and the LIKE pattern
    // into `%`, so every Review card would report a merge conflict. The module
    // must fail loudly rather than silently become a wildcard.
    const { __testables } = await import("@/lib/workflow/merge-failure");
    expect(() => __testables.reasonPrefix((arg) => `${arg} trailing`)).toThrow(
      /empty prefix/i
    );
    expect(__testables.reasonPrefix((arg) => `head ${arg}`)).toBe("head ");
  });

  it("ignores the success and non-merge traces", () => {
    expect(isMergeFailureReason(AUTO_MODE_REASONS.merged)).toBe(false);
    expect(isMergeFailureReason(AUTO_MODE_REASONS.mergeAttempted)).toBe(false);
    expect(isMergeFailureReason(AUTO_MODE_REASONS.reviewDispatched)).toBe(false);
    expect(isMergeFailureReason(null)).toBe(false);
    expect(isMergeFailureReason(undefined)).toBe(false);
    expect(isMergeFailureReason("")).toBe(false);
  });
});

describe("GIT_REFUSAL_MERGE_REASONS and isGitRefusalMergeReason", () => {
  it("includes only genuine resolvable conflict verdicts", () => {
    expect(GIT_REFUSAL_MERGE_REASONS).toEqual(["conflict"]);
  });

  it("returns true for genuine conflict reason", () => {
    expect(isGitRefusalMergeReason("conflict")).toBe(true);
  });

  it("returns false for conflict-markers, non-conflict verdicts, errors, or missing reasons", () => {
    // conflict-markers cannot be resolved by the resolve-merge agent (clean merge leaves markers),
    // so it must not set mergeFailed: true or loop the Resolve merge button.
    expect(isGitRefusalMergeReason("conflict-markers")).toBe(false);
    expect(isGitRefusalMergeReason("branch-missing")).toBe(false);
    expect(isGitRefusalMergeReason("error")).toBe(false);
    expect(isGitRefusalMergeReason("something-else")).toBe(false);
    expect(isGitRefusalMergeReason(undefined)).toBe(false);
    expect(isGitRefusalMergeReason(null)).toBe(false);
  });
});

describe("isMergeConflictReason vs isConflictMarkersReason", () => {
  it("differentiates merge conflicts from conflict markers", () => {
    const conflict = AUTO_MODE_REASONS.mergeFailed("conflict", "boom");
    const markers = AUTO_MODE_REASONS.mergeFailed("conflict-markers", "boom");

    expect(isMergeConflictReason(conflict)).toBe(true);
    expect(isConflictMarkersReason(conflict)).toBe(false);

    expect(isConflictMarkersReason(markers)).toBe(true);
    expect(isMergeConflictReason(markers)).toBe(false);
  });
});

describe("MERGE_FAILURE_REASON_PREFIXES", () => {
  it("carries no leftover sentinel from probing the reason builders", () => {
    for (const prefix of MERGE_FAILURE_REASON_PREFIXES) {
      expect(prefix).not.toContain("\u0000");
      expect(prefix.length).toBeGreaterThan(0);
    }
  });

  it("partitions into conflict and conflict-marker prefixes", () => {
    expect(MERGE_CONFLICT_REASON_PREFIXES.length).toBeGreaterThan(0);
    expect(CONFLICT_MARKERS_REASON_PREFIXES.length).toBeGreaterThan(0);
    expect(MERGE_FAILURE_REASON_PREFIXES).toEqual([
      ...MERGE_CONFLICT_REASON_PREFIXES,
      ...CONFLICT_MARKERS_REASON_PREFIXES,
    ]);
  });

  it("exposes LIKE patterns that are the prefixes plus a wildcard", () => {
    expect(MERGE_FAILURE_REASON_LIKE_PATTERNS).toHaveLength(
      MERGE_FAILURE_REASON_PREFIXES.length
    );
    for (const [index, pattern] of MERGE_FAILURE_REASON_LIKE_PATTERNS.entries()) {
      expect(pattern.endsWith("%")).toBe(true);
      // Only the trailing wildcard is a wildcard: any % or _ inside a prefix
      // is escaped, so a reworded reason can never widen the match.
      expect(pattern.slice(0, -1).replace(/\\[\\%_]/g, "")).not.toMatch(/[%_]/);
      expect(pattern.slice(0, -1).replace(/\\([\\%_])/g, "$1")).toBe(
        MERGE_FAILURE_REASON_PREFIXES[index]
      );
    }
  });
});
