/**
 * The boot sweep for `qa_reports`, the write-side twin of
 * `lib/agent-sessions/boot-cleanup.ts`.
 *
 * WHY IT EXISTS. `qa_reports.status` has exactly ONE writer — the tail of the
 * scheduler closure in `app/api/projects/[projectId]/qa/check/route.ts` — so
 * the column only ever leaves `running` for a run that reaches its own end.
 * Three ordinary paths skip that tail and strand the row on `running` forever:
 * a server restart mid-check, a launch closure that rejects, and cancelling a
 * check that is still queued. Every one of them leaves the SESSION terminal,
 * which is why `isCheckLive` can already read the truth off the join — but
 * reading it is not fixing it. The rows stay wrong in the database, and every
 * consumer that reads the column raw inherits the lie.
 *
 * WHAT IT WRITES. Not a guess: `checkStatusLabel` — the word `/qa` already
 * shows for that row today. So this sweep changes nothing about what the user
 * sees; it makes the stored column agree with the reading, which is what makes
 * the two halves of the invariant one invariant. Reading and writing through
 * the same two helpers is deliberate: a future change to the derivation moves
 * the writer with it rather than opening a second definition.
 *
 * NO ONCE-PER-PROCESS GUARD, unlike the session sweeps. Theirs exists because
 * a repeat run would cancel `queued` rows belonging to live requests — the
 * sweep's subject is "everything in this state", and after boot that state is
 * legitimate. This sweep's subject is narrower and carries its own proof: it
 * only touches a report whose owning session is already terminal or gone, and
 * such a report can never be finalized by anyone else. A repeat run is
 * therefore a no-op rather than a demolition, and idempotency is a property of
 * the sweep instead of a property of a flag.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, qaReports } from "@/lib/db/schema";
import { checkStatusLabel, isCheckLive } from "@/lib/qa/aggregate";

/**
 * The summary a reconciled row carries.
 *
 * `qa_reports` records an outcome in `summary` (clipped into the `/qa` CHECKS
 * band and printed under the report in the project QA history), so the reason
 * goes where the module already puts reasons rather than into a new column.
 *
 * `report_content` is deliberately left NULL: it is filled by the same
 * statement that moves the status, so a stranded row never had one, and
 * inventing one would claim a report that was never written.
 */
export const QA_CHECK_INTERRUPTED_SUMMARY =
  "Interrupted — the check ended without writing a report.";

/**
 * Moves every `qa_reports` row stranded on `running` to the status
 * `lib/qa/aggregate.ts` derives for it, and returns how many moved.
 *
 * MUST RUN AFTER the session sweeps in `lib/agent-sessions/boot-cleanup.ts`:
 * they are what turns the previous process's `queued`/`running` sessions
 * terminal, and until they have, a report owned by such a session still reads
 * as live here and is correctly skipped.
 *
 * A live check — owning session `queued` or `running` — is never touched.
 */
export function reconcileStrandedQaReports(): number {
  const candidates = db
    .select({
      id: qaReports.id,
      status: qaReports.status,
      summary: qaReports.summary,
      completedAt: qaReports.completedAt,
      // From the LEFT JOIN: NULL when the report carries no session id, or
      // when the session row is gone (the FK is ON DELETE SET NULL). Neither
      // is live — see isCheckLive.
      sessionStatus: agentSessions.status,
    })
    .from(qaReports)
    .leftJoin(agentSessions, eq(qaReports.agentSessionId, agentSessions.id))
    .where(eq(qaReports.status, "running"))
    .all();

  const now = new Date().toISOString();
  let reconciled = 0;

  for (const row of candidates) {
    if (isCheckLive(row)) continue;

    db.update(qaReports)
      .set({
        status: checkStatusLabel(row),
        // A run that wrote a partial summary before dying keeps it: the reason
        // is a fallback for the ordinary case (no summary at all), not an
        // overwrite of evidence.
        summary: row.summary ?? QA_CHECK_INTERRUPTED_SUMMARY,
        completedAt: row.completedAt ?? now,
      })
      // Compare-and-set on the status this row was read with, so a closure
      // finalizing the same report between the SELECT and here wins.
      .where(and(eq(qaReports.id, row.id), eq(qaReports.status, "running")))
      .run();
    reconciled++;
  }

  if (reconciled > 0) {
    console.log(
      `[qa-boot-cleanup] Reconciled ${reconciled} QA report(s) stranded on running`
    );
  }

  return reconciled;
}
