/**
 * The merge IS the approval. When a branch lands on main, every review
 * comment still open on the epic is resolved in the same action: the review
 * verdict already decided the ticket was mergeable (review → to_merge), and
 * the human's merge is the acceptance of whatever remained open — minor
 * findings, informational notes, stale rows from earlier cycles.
 *
 * Every merge path shares this helper: the manual merge route, its merge-fix
 * agent retry, Resolve Merge (clean and post-agent), and Full Auto's merge.
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
