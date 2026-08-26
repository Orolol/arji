/**
 * The shared "ready to merge" predicate (lib/kanban/merge-readiness.ts).
 *
 * Pure by design, so these tests are the specification: they pin the blocker
 * precedence the Review cards render, the timestamp normalisation that makes
 * ISO and SQLite stamps comparable, and the review-column ordering the board
 * relies on to keep its two sections contiguous.
 */
import { describe, it, expect } from "vitest";
import {
  describeMergeBlocker,
  evaluateMergeReadiness,
  hasCurrentMergeFailure,
  hasFreshCleanReview,
  isMergeReady,
  isMergeReadyEpic,
  sortReviewColumn,
  type MergeReadinessFacts,
} from "@/lib/kanban/merge-readiness";

const READY: MergeReadinessFacts = {
  status: "review",
  branchName: "feature/epic-1",
  openFindings: 0,
  lastCleanReviewAt: "2026-08-20T12:00:00.000Z",
  lastTerminalCodeAt: "2026-08-20T11:00:00.000Z",
};

describe("evaluateMergeReadiness", () => {
  it("clears an epic reviewed after its last code change with no open findings", () => {
    expect(evaluateMergeReadiness(READY)).toEqual({
      ready: true,
      blocker: null,
      openFindings: 0,
    });
    expect(isMergeReady(READY)).toBe(true);
  });

  it("refuses anything outside the review column", () => {
    for (const status of ["backlog", "todo", "in_progress", "done", "released"]) {
      expect(evaluateMergeReadiness({ ...READY, status })).toMatchObject({
        ready: false,
        blocker: "not_in_review",
      });
    }
  });

  it("reports open findings, and how many", () => {
    expect(evaluateMergeReadiness({ ...READY, openFindings: 2 })).toEqual({
      ready: false,
      blocker: "open_findings",
      openFindings: 2,
    });
  });

  it("reports a review that predates the last code change as stale", () => {
    expect(
      evaluateMergeReadiness({
        ...READY,
        lastCleanReviewAt: "2026-08-20T11:00:00.000Z",
        lastTerminalCodeAt: "2026-08-20T12:00:00.000Z",
      })
    ).toMatchObject({ ready: false, blocker: "stale_review" });
  });

  it("distinguishes 'never reviewed' from 'reviewed, then superseded'", () => {
    expect(
      evaluateMergeReadiness({ ...READY, lastCleanReviewAt: null })
    ).toMatchObject({ blocker: "no_review" });
  });

  it("refuses an epic with nothing to land", () => {
    expect(
      evaluateMergeReadiness({ ...READY, branchName: null })
    ).toMatchObject({ ready: false, blocker: "no_branch" });
  });

  it("ranks a merge failure above every other blocker — git is the wall", () => {
    expect(
      evaluateMergeReadiness({
        ...READY,
        openFindings: 3,
        lastMergeFailureAt: "2026-08-20T13:00:00.000Z",
      })
    ).toMatchObject({ blocker: "merge_conflict", openFindings: 3 });
  });

  it("treats a review with no recorded code session as fresh", () => {
    expect(
      evaluateMergeReadiness({ ...READY, lastTerminalCodeAt: null })
    ).toMatchObject({ ready: true });
  });

  it("compares SQLite timestamps against ISO ones correctly", () => {
    // Same instant, two spellings: the review is one hour AFTER the code.
    expect(
      hasFreshCleanReview({
        lastCleanReviewAt: "2026-08-20 12:00:00",
        lastTerminalCodeAt: "2026-08-20T11:00:00.000Z",
      })
    ).toBe(true);
    // Without normalisation "2026-08-20 11:00:00" > "2026-08-20T12:..." would
    // be false anyway — this is the direction that actually flips.
    expect(
      hasFreshCleanReview({
        lastCleanReviewAt: "2026-08-20T11:00:00.000Z",
        lastTerminalCodeAt: "2026-08-20 12:00:00",
      })
    ).toBe(false);
  });

  it("survives a garbage finding count rather than reporting NaN", () => {
    expect(
      evaluateMergeReadiness({
        ...READY,
        openFindings: Number.NaN as unknown as number,
      })
    ).toEqual({ ready: true, blocker: null, openFindings: 0 });
  });
});

describe("hasCurrentMergeFailure", () => {
  it("holds while nothing has touched the branch since the failure", () => {
    expect(
      hasCurrentMergeFailure({
        lastMergeFailureAt: "2026-08-20T13:00:00.000Z",
        lastTerminalCodeAt: "2026-08-20T11:00:00.000Z",
      })
    ).toBe(true);
  });

  it("clears once a code session (e.g. the merge-fix agent) ran after it", () => {
    expect(
      hasCurrentMergeFailure({
        lastMergeFailureAt: "2026-08-20T11:00:00.000Z",
        lastTerminalCodeAt: "2026-08-20T13:00:00.000Z",
      })
    ).toBe(false);
  });

  it("is false when no merge ever failed", () => {
    expect(hasCurrentMergeFailure({ lastTerminalCodeAt: null })).toBe(false);
  });

  it("a repaired conflict falls through to the stale review it invalidated", () => {
    expect(
      evaluateMergeReadiness({
        ...READY,
        lastMergeFailureAt: "2026-08-20T11:30:00.000Z",
        // The merge-fix agent rewrote the branch after both the review and
        // the failed merge.
        lastTerminalCodeAt: "2026-08-20T13:00:00.000Z",
      })
    ).toMatchObject({ blocker: "stale_review" });
  });
});

describe("describeMergeBlocker", () => {
  it("says nothing for a ready epic or one outside review", () => {
    expect(describeMergeBlocker({ ready: true, blocker: null, openFindings: 0 })).toBeNull();
    expect(
      describeMergeBlocker({ ready: false, blocker: "not_in_review", openFindings: 0 })
    ).toBeNull();
    expect(describeMergeBlocker(undefined)).toBeNull();
  });

  it("counts findings, singular and plural", () => {
    expect(
      describeMergeBlocker({ ready: false, blocker: "open_findings", openFindings: 1 })
    ).toBe("1 open finding");
    expect(
      describeMergeBlocker({ ready: false, blocker: "open_findings", openFindings: 4 })
    ).toBe("4 open findings");
  });

  it("names the cause for each remaining blocker", () => {
    expect(
      describeMergeBlocker({ ready: false, blocker: "merge_conflict", openFindings: 0 })
    ).toMatch(/conflict/i);
    expect(
      describeMergeBlocker({ ready: false, blocker: "stale_review", openFindings: 0 })
    ).toMatch(/outdated/i);
    expect(
      describeMergeBlocker({ ready: false, blocker: "no_review", openFindings: 0 })
    ).toMatch(/review/i);
    expect(
      describeMergeBlocker({ ready: false, blocker: "no_branch", openFindings: 0 })
    ).toMatch(/branch/i);
  });
});

describe("sortReviewColumn", () => {
  const epic = (id: string, position: number, ready: boolean) => ({
    id,
    position,
    mergeReadiness: {
      ready,
      blocker: ready ? null : ("open_findings" as const),
      openFindings: ready ? 0 : 1,
    },
  });

  it("floats ready tickets to the top, keeping board position within groups", () => {
    const sorted = sortReviewColumn([
      epic("a", 0, false),
      epic("b", 1, true),
      epic("c", 2, false),
      epic("d", 3, true),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("does not mutate its input", () => {
    const input = [epic("a", 0, false), epic("b", 1, true)];
    sortReviewColumn(input);
    expect(input.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("treats a missing signal as not ready rather than throwing", () => {
    const sorted = sortReviewColumn([
      { id: "a", position: 0 },
      epic("b", 1, true),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["b", "a"]);
    expect(isMergeReadyEpic({})).toBe(false);
  });
});
