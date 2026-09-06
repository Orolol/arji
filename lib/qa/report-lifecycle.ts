/**
 * The request-time half of the `qa_reports` write invariant.
 *
 * `lib/qa/boot-cleanup.ts` states the shape of the problem: `qa_reports.status`
 * has exactly ONE writer — the tail of the scheduler closure in
 * `app/api/projects/[projectId]/qa/check/route.ts` — so the column only leaves
 * `running` for a run that reaches its own end, and three ordinary paths skip
 * that tail. That module settles the rows a DEAD PROCESS left behind. This one
 * settles the two paths a LIVE process walks:
 *
 * - a launch closure that rejects (`processManager.start` throwing, the CLI
 *   missing, the worktree gone): the scheduler's safety net finalizes the
 *   session, and the report update after the `await` never runs;
 * - cancelling a check that is still queued: `agentScheduler.remove()` splices
 *   the closure out, so nothing throws and nothing updates the report.
 *
 * The boot sweep alone is not enough for either. It runs at boot, and this ships
 * on a long-lived local dev server — a report stranded by a bad spawn on Monday
 * stays `running` until the next restart, which may be days. The reader-side
 * derivation (`isCheckLive`) hides that from `/qa`, but the STORED column is
 * what exports, digests and every future consumer read.
 *
 * EVERY WRITE HERE IS A COMPARE-AND-SET on `status = 'running'`. These paths
 * race the closure tail by construction — cancelling a check whose process is
 * live has both writers firing inside one poll interval — and the tail is the
 * authoritative one: it carries the agent's actual output. Losing that race is
 * therefore the CORRECT outcome for this module, not a lost update.
 *
 * `report_content` is never written, for the same reason the boot sweep leaves
 * it NULL: it is filled by the one statement that finalizes the row, so a report
 * reaching this module never had one, and inventing one would claim a report
 * that was never produced.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { qaReports } from "@/lib/db/schema";

/**
 * Ceiling on the `summary` column, shared with the closure tail's
 * `extractSummary`. One definition rather than two 500s that drift: an error
 * message is unbounded (a stack, a CLI's whole stderr) while `summary` is a
 * single line, clipped again to `QA_CHECK_SUMMARY_LIMIT` on the way out.
 */
export const QA_REPORT_SUMMARY_MAX_CHARS = 500;

/** The summary a check cancelled before it produced a report carries. */
export const QA_CHECK_CANCELLED_SUMMARY =
  "Cancelled before the check produced a report.";

/** The summary prefix a check whose launch never got off the ground carries. */
export const QA_CHECK_LAUNCH_FAILED_SUMMARY = "The check failed to launch.";

/**
 * Marks one report `failed` because its launch closure rejected.
 *
 * Called from the closure's own catch, BEFORE it rethrows to the scheduler.
 * That keeps the knowledge of which report a QA session owns inside the QA
 * route instead of teaching the generic scheduler about `qa_reports`, and it
 * makes the write synchronous with the throw — a closure the scheduler started
 * immediately settles its report inside the POST that submitted it.
 *
 * @returns true when this call is what moved the row.
 */
export function failQaReportLaunch(reportId: string, error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string" && error.trim().length > 0
        ? error.trim()
        : "Unknown error";

  return writeTerminalQaReportStatus(
    reportId,
    "failed",
    clip(`${QA_CHECK_LAUNCH_FAILED_SUMMARY} ${message}`),
  );
}

/**
 * Marks every still-`running` report owned by `sessionId` as `cancelled`.
 *
 * Keyed on the session rather than on a report id because the cancelling paths
 * only ever know the session — the report id lives in the closure that was just
 * spliced out of the queue. A session owns at most one report today; iterating
 * a set means a second one could never be silently left behind.
 *
 * NOT restricted to sessions that were still `queued`. A cancelled RUNNING check
 * does reach the closure tail, and the tail's richer row wins the compare-and-set
 * whichever order the two land in — so covering both states costs nothing and
 * additionally closes the case of a running check whose closure dies before its
 * tail.
 *
 * @returns the number of rows moved.
 */
export function cancelQaReportsForSession(
  sessionId: string,
  at: string = new Date().toISOString(),
): number {
  const stranded = db
    .select({ id: qaReports.id })
    .from(qaReports)
    .where(
      and(
        eq(qaReports.agentSessionId, sessionId),
        eq(qaReports.status, "running"),
      ),
    )
    .all();

  let cancelled = 0;
  for (const row of stranded) {
    if (
      writeTerminalQaReportStatus(
        row.id,
        "cancelled",
        QA_CHECK_CANCELLED_SUMMARY,
        at,
      )
    ) {
      cancelled++;
    }
  }
  return cancelled;
}

function clip(text: string): string {
  return text.length > QA_REPORT_SUMMARY_MAX_CHARS
    ? text.slice(0, QA_REPORT_SUMMARY_MAX_CHARS)
    : text;
}

/**
 * The one statement both paths share.
 *
 * `summary` is written only when the row has none: a run that got far enough to
 * record a partial summary keeps it — the canned sentence is a fallback for the
 * ordinary case (no summary at all), never an overwrite of evidence. Same rule
 * as `reconcileStrandedQaReports()`.
 */
function writeTerminalQaReportStatus(
  reportId: string,
  status: "failed" | "cancelled",
  summary: string,
  at: string = new Date().toISOString(),
): boolean {
  const stillRunning = and(
    eq(qaReports.id, reportId),
    eq(qaReports.status, "running"),
  );

  const existing = db
    .select({ summary: qaReports.summary })
    .from(qaReports)
    .where(stillRunning)
    .get();

  if (!existing) return false;

  const result = db
    .update(qaReports)
    .set({
      status,
      summary: existing.summary ?? summary,
      completedAt: at,
    })
    .where(stillRunning)
    .run();

  return result.changes > 0;
}
