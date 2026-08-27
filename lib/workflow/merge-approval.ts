/**
 * The merge IS the approval. When a branch lands on main, every review
 * comment still open on the epic is resolved in the same action: the review
 * verdict already decided the ticket was mergeable (review → to_merge), and
 * the human's merge is the acceptance of whatever remained open — minor
 * findings, informational notes, stale rows from earlier cycles.
 *
 * Every merge path shares this helper: the manual merge route, its merge-fix
 * agent retry, Resolve Merge (clean and post-agent), and Full Auto's merge.
 *
 * ORDER MATTERS: call this AFTER the guarded transition succeeds, never
 * before. A merge the post-merge guard refuses is rolled back, and the rows
 * this would have closed are exactly what the next sweep needs to read.
 *
 * Leaving them behind once the epic IS Done is not cosmetic either. Two
 * prompt builders load EVERY open row for an epic, unfiltered by severity or
 * window, and present them under "address each one" —
 * `buildReviewFeedbackSection` (lib/pipeline/stages.ts) and the epic build
 * route's review-comment context. A later build on a merged epic would
 * re-litigate findings a reviewer already accepted, and the older they are
 * the more confidently wrong they are about the current code.
 */

import { db } from "@/lib/db";
import { reviewComments } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Bulk-resolve the epic's open review comments. Returns the number of rows
 * resolved. Never throws on an empty set — resolving nothing is a no-op.
 */
export function resolveOpenReviewComments(
  epicId: string,
  now: string = new Date().toISOString()
): number {
  const result = db
    .update(reviewComments)
    .set({ status: "resolved", updatedAt: now })
    .where(
      and(eq(reviewComments.epicId, epicId), eq(reviewComments.status, "open"))
    )
    .run();
  return result.changes ?? 0;
}
