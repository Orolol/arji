/**
 * Closing an epic's open review findings once it reaches Done.
 *
 * Approve has always done this (it bulk-resolves, then transitions). The
 * merge paths never had to: until the merge gate learned to ignore
 * non-blocking and superseded rows, an epic could not reach Done with any row
 * still open, so "Done implies no open findings" held by accident.
 *
 * It stopped holding, and leaving the rows behind is not cosmetic. Two prompt
 * builders load EVERY open row for an epic, unfiltered by severity or window,
 * and present them under "address each one":
 *   - `buildReviewFeedbackSection` (lib/pipeline/stages.ts)
 *   - the epic build route's review-comment context
 * A later build on a merged epic would re-litigate findings a reviewer
 * already accepted, and the older they are the more confidently wrong they
 * are about the current code.
 *
 * ORDER MATTERS, and it is the opposite of what it looks like. Approve
 * resolves BEFORE its transition, which is how it overrides the findings
 * guard on a human's authority. The merge paths must resolve AFTER their
 * transition succeeds: a merge that the post-merge guard refuses is rolled
 * back, and the rows it would have closed are exactly what the next sweep
 * needs to read. Call this only once the epic is actually Done.
 */

import { and, eq } from "drizzle-orm";
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import { reviewComments } from "@/lib/db/schema";

/**
 * Marks every open finding on the epic resolved. Returns nothing: no caller
 * has a decision to make from the count, and a merge must not fail because
 * bookkeeping did.
 */
export function closeOpenFindings(
  epicId: string,
  database: ArijDatabase = defaultDb
): void {
  database
    .update(reviewComments)
    .set({ status: "resolved", updatedAt: new Date().toISOString() })
    .where(
      and(eq(reviewComments.epicId, epicId), eq(reviewComments.status, "open"))
    )
    .run();
}
