/**
 * End-of-run synthesis report for a board refinement re-pass.
 *
 * Two surfaces, deliberately:
 *
 *   - a **notification**, project-scoped, carrying the aggregate the user
 *     wants at a glance ("4 promoted · 2 sent back · 3 edges added") and
 *     deep-linking to the board;
 *   - a **recap comment on every ticket whose column changed**, which is
 *     where "with links to the tickets" actually lands. Arij has no
 *     project-level comment surface — comments hang off an epic or a story —
 *     so a single board-wide comment would have nowhere to be read. The
 *     comment leads with what happened to *that* ticket and why, then lists
 *     the rest of the pass, so a user opening a moved ticket sees both the
 *     local reason and the context it was moved in.
 *
 * Tickets that only changed priority, order or dependencies get their
 * activity-log entry and no comment: those entries already carry the
 * justification, and a comment per reorder would bury the feed.
 */

import { db } from "@/lib/db";
import { ticketComments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import {
  buildEpicTargetUrl,
  createRefinementReportNotification,
} from "@/lib/notifications/create";
import { REFINEMENT_LABEL } from "./constants";
import { takeRefinementChanges, type RefinementChange } from "./registry";

export interface RefinementReport {
  promoted: RefinementChange[];
  demoted: RefinementChange[];
  priority: RefinementChange[];
  reordered: RefinementChange[];
  dependenciesAdded: RefinementChange[];
  dependenciesRemoved: RefinementChange[];
  /** Total records, i.e. whether the pass did anything at all. */
  total: number;
}

/** Group a session's recorded changes into the report shape. Pure. */
export function buildRefinementReport(
  changes: RefinementChange[]
): RefinementReport {
  const pick = (kind: RefinementChange["kind"]) =>
    changes.filter((change) => change.kind === kind);

  return {
    promoted: pick("promoted"),
    demoted: pick("demoted"),
    priority: pick("priority"),
    reordered: pick("reordered"),
    dependenciesAdded: pick("dependency_added"),
    dependenciesRemoved: pick("dependency_removed"),
    total: changes.length,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one-line aggregate — the notification title's payload and the recap
 * comment's opening. Only non-empty categories are listed, so a pass that
 * only re-ranked To do does not claim "0 promoted, 0 sent back".
 */
export function formatRefinementSummary(report: RefinementReport): string {
  if (report.total === 0) {
    return "no changes — the board was already in shape";
  }

  const parts: string[] = [];
  if (report.promoted.length > 0) {
    parts.push(`${plural(report.promoted.length, "ticket", "tickets")} promoted to To do`);
  }
  if (report.demoted.length > 0) {
    parts.push(`${plural(report.demoted.length, "ticket", "tickets")} sent back to Backlog`);
  }
  if (report.priority.length > 0) {
    parts.push(`${plural(report.priority.length, "priority change", "priority changes")}`);
  }
  if (report.dependenciesAdded.length > 0) {
    parts.push(`${plural(report.dependenciesAdded.length, "dependency edge", "dependency edges")} added`);
  }
  if (report.dependenciesRemoved.length > 0) {
    parts.push(`${plural(report.dependenciesRemoved.length, "dependency edge", "dependency edges")} removed`);
  }
  if (report.reordered.length > 0) {
    parts.push(`${plural(report.reordered.length, "ticket", "tickets")} reordered`);
  }
  return parts.join(" · ");
}

function ticketLink(projectId: string, change: RefinementChange): string {
  return `[${change.label}](${buildEpicTargetUrl(projectId, change.ticketId)})`;
}

function changeList(
  projectId: string,
  heading: string,
  changes: RefinementChange[]
): string[] {
  if (changes.length === 0) return [];
  const lines = [`**${heading}**`, ""];
  for (const change of changes) {
    lines.push(
      `- ${ticketLink(projectId, change)} — ${change.detail}. ${change.reason}`
    );
  }
  lines.push("");
  return lines;
}

/**
 * The recap comment body.
 *
 * `focusTicketId` is the ticket the comment is posted on: its own change is
 * called out first so the feed entry reads as being about this ticket, not
 * as a board-wide broadcast that happens to be filed here.
 *
 * `includeFullList` controls whether the itemised, ticket-linked breakdown is
 * appended. Exactly ONE comment per pass carries it — repeating every change
 * on every moved ticket makes comment volume quadratic in the size of the
 * pass (10 promotions x 40 changes), and bloats the very table the board's
 * status poll reads. The rest get the focus block, the aggregate line and a
 * pointer to where the full breakdown lives.
 */
export function formatRefinementComment(
  projectId: string,
  report: RefinementReport,
  focusTicketId?: string,
  options: { includeFullList?: boolean; fullListTicketId?: string } = {}
): string {
  const lines: string[] = [];
  const focus = focusTicketId
    ? [...report.promoted, ...report.demoted].find(
        (change) => change.ticketId === focusTicketId
      )
    : undefined;

  if (focus) {
    const move =
      focus.kind === "promoted"
        ? "Promoted **Backlog → To do**"
        : "Sent back **To do → Backlog**";
    lines.push(`${move} by the refinement re-pass.`, "", `> ${focus.reason}`, "");
    if (focus.kind === "demoted" && focus.detail) {
      lines.push(`${focus.detail}`, "");
    }
    lines.push("---", "");
  }

  lines.push(
    `### ${REFINEMENT_LABEL} — ${formatRefinementSummary(report)}`,
    ""
  );

  if (options.includeFullList) {
    lines.push(
      ...changeList(projectId, "Promoted to To do", report.promoted),
      ...changeList(projectId, "Sent back to Backlog", report.demoted),
      ...changeList(projectId, "Priority changes", report.priority),
      ...changeList(
        projectId,
        "Dependency edges added",
        report.dependenciesAdded
      ),
      ...changeList(
        projectId,
        "Dependency edges removed",
        report.dependenciesRemoved
      ),
      ...changeList(projectId, "Re-ranked", report.reordered)
    );
  } else if (options.fullListTicketId) {
    lines.push(
      `Full breakdown of this pass: ${buildEpicTargetUrl(projectId, options.fullListTicketId)}`,
      ""
    );
  }

  return lines.join("\n").trim();
}

export interface PublishRefinementReportInput {
  projectId: string;
  sessionId: string;
  /**
   * A failed or cancelled run still publishes whatever it managed to change
   * — those writes are already on the board, so hiding them would leave the
   * user with unexplained movement.
   */
  succeeded: boolean;
}

export interface PublishedRefinementReport {
  report: RefinementReport;
  summary: string;
  commentedTicketIds: string[];
  notificationId: string | null;
}

/**
 * Drain the session's changes, post the recap comments, and raise the
 * notification. Returns what it published so the dispatcher can log it.
 *
 * A pass that changed nothing still notifies: "the board was already in
 * shape" is a result the user asked for, and silence would read as a
 * failure.
 */
export function publishRefinementReport(
  input: PublishRefinementReportInput
): PublishedRefinementReport {
  const changes = takeRefinementChanges(input.sessionId);
  const report = buildRefinementReport(changes);
  const summary = formatRefinementSummary(report);
  const now = new Date().toISOString();

  // One comment per ticket that changed column — see the module header for
  // why those and not every touched ticket.
  const movedTicketIds = Array.from(
    new Set([...report.promoted, ...report.demoted].map((c) => c.ticketId))
  );

  // The itemised breakdown goes on the first moved ticket only; the others
  // point at it. See formatRefinementComment for why.
  const fullListTicketId = movedTicketIds[0];

  const commentedTicketIds: string[] = [];
  for (const ticketId of movedTicketIds) {
    const isFullList = ticketId === fullListTicketId;
    try {
      db.insert(ticketComments)
        .values({
          id: createId(),
          epicId: ticketId,
          author: "agent",
          content: formatRefinementComment(input.projectId, report, ticketId, {
            includeFullList: isFullList,
            fullListTicketId: isFullList ? undefined : fullListTicketId,
          }),
          agentSessionId: input.sessionId,
          createdAt: now,
        })
        .run();
      commentedTicketIds.push(ticketId);
    } catch (error) {
      // A ticket deleted mid-pass must not sink the whole report.
      console.error("[refinement] Failed to post recap comment", error);
    }
  }

  const notificationId = createRefinementReportNotification({
    projectId: input.projectId,
    sessionId: input.sessionId,
    summary,
    succeeded: input.succeeded,
  });

  return { report, summary, commentedTicketIds, notificationId };
}
