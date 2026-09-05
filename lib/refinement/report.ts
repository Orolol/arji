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
 *
 * Discarded tickets are the one thing here that has no ticket left to be
 * filed on, so their tombstones ride BOTH surfaces: the recap comment, and
 * the notification's `message`.
 *
 * The comment is the one that matters, and it always gets a host: the pass's
 * own surviving tickets first, then — for a pass that deleted everything it
 * touched — any ticket the project still has (`fallbackCommentHost`), with
 * the comment saying why it is filed there. The notification is a duplicate,
 * not a fallback: nothing in the app renders `notifications` today
 * (hooks/useNotifications.ts has no consumer; the chrome reads /api/inbox,
 * built from ticket_comments and agent_sessions), so a tombstone that lived
 * only there would be a permanently deleted ticket with no readable record.
 *
 * What is not covered: a project with no tickets left at all has no host, and
 * a server restart mid-pass drops the in-process registry, so a discard whose
 * run never settles loses its tombstone — the same exposure every other
 * refinement change already has, and the reason lib/refinement/retire.ts
 * refuses tickets carrying agent history.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics, ticketComments } from "@/lib/db/schema";
import { REFINEMENT_STATUSES } from "@/lib/mcp/refinement";
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
  /** Tickets folded into another one, filed against the surviving target. */
  merged: RefinementChange[];
  /** Tickets deleted as no longer worth doing — `ticketId` no longer exists. */
  discarded: RefinementChange[];
  /** Tickets the pass added because the board was missing them. */
  created: RefinementChange[];
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
    merged: pick("merged"),
    discarded: pick("discarded"),
    created: pick("created"),
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
  if (report.merged.length > 0) {
    parts.push(`${plural(report.merged.length, "merge", "merges")}`);
  }
  if (report.discarded.length > 0) {
    parts.push(`${plural(report.discarded.length, "ticket", "tickets")} discarded`);
  }
  if (report.created.length > 0) {
    parts.push(`${plural(report.created.length, "ticket", "tickets")} created`);
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

/**
 * A link to the ticket — or its bare label when the pass deleted it. A
 * discarded ticket's URL resolves to nothing, and a dead link in a recap
 * reads as a navigation bug rather than as "this ticket is gone".
 */
function ticketLink(projectId: string, change: RefinementChange): string {
  if (change.ticketGone) return `~~${change.label}~~`;
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
    // The deleted ticket's own text, indented under its line. Only a discard
    // carries one — a merge's absorbed text is already posted on the survivor
    // as the absorption comment, and re-rendering it here would publish it
    // twice in the same feed (see the merge route's record).
    //
    // Indentation rather than a `<details>` fold-out: ticket comments are
    // rendered as plain text under `whitespace-pre-wrap`
    // (components/ticket/CommentBubble.tsx), never as markdown or HTML, so a
    // fold-out would show the user its own tags.
    if (change.snapshot && change.kind === "discarded") {
      lines.push(
        "",
        `  What ${change.label} contained:`,
        "",
        change.snapshot.replace(/^/gm, "  "),
        ""
      );
    }
  }
  lines.push("");
  return lines;
}

/**
 * The opening line of the recap comment, per kind of change that can host
 * one. Only the kinds that leave a ticket BEHIND appear: a discarded ticket
 * has no feed to be read in.
 */
const FOCUS_HEADLINES: Partial<Record<RefinementChange["kind"], string>> = {
  promoted: "Promoted **Backlog → To do**",
  demoted: "Sent back **To do → Backlog**",
  merged: "Absorbed other tickets",
  created: "Created",
};

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
  options: {
    includeFullList?: boolean;
    fullListTicketId?: string;
    /**
     * The host ticket was not itself touched by the pass — it is standing in
     * because everything the pass changed was deleted. Say so, or the entry
     * reads as something that happened to this ticket.
     */
    unrelatedHost?: boolean;
  } = {}
): string {
  const lines: string[] = [];
  const focus = focusTicketId
    ? [...report.promoted, ...report.demoted, ...report.merged, ...report.created].find(
        (change) => change.ticketId === focusTicketId
      )
    : undefined;

  if (focus) {
    lines.push(
      `${FOCUS_HEADLINES[focus.kind] ?? "Changed"} by the refinement re-pass.`,
      "",
      `> ${focus.reason}`,
      ""
    );
    if (focus.kind !== "promoted" && focus.detail) {
      lines.push(`${focus.detail}`, "");
    }
    lines.push("---", "");
  }

  lines.push(
    `### ${REFINEMENT_LABEL} — ${formatRefinementSummary(report)}`,
    ""
  );

  if (options.unrelatedHost) {
    lines.push(
      "Filed here because every ticket this pass changed was deleted by it — " +
        "this ticket was not touched. The record below is board-wide.",
      ""
    );
  }

  if (options.includeFullList) {
    lines.push(
      ...changeList(projectId, "Promoted to To do", report.promoted),
      ...changeList(projectId, "Sent back to Backlog", report.demoted),
      ...changeList(projectId, "Merged together", report.merged),
      ...changeList(projectId, "Discarded", report.discarded),
      ...changeList(projectId, "Created", report.created),
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

/**
 * Ceiling on the tombstone text carried by one notification.
 *
 * `notifications.message` is read whole by the notification list, so an
 * unbounded dump of every discarded ticket's acceptance criteria would be
 * paid for on every poll. Truncation is marked, never silent.
 */
export const REFINEMENT_NOTIFICATION_MESSAGE_MAX_CHARS = 4000;

/**
 * The discarded tickets' full text for the notification, or null when the
 * pass discarded nothing (the ordinary case — `message` stays NULL, as it is
 * for every other completed session).
 */
export function formatDiscardedTombstones(
  report: RefinementReport
): string | null {
  if (report.discarded.length === 0) return null;

  const blocks = report.discarded.map((change) =>
    [
      `Discarded ${change.label}: ${change.reason}`,
      change.snapshot ?? "",
    ]
      .filter(Boolean)
      .join("\n\n")
  );

  const body = blocks.join("\n\n---\n\n");
  if (body.length <= REFINEMENT_NOTIFICATION_MESSAGE_MAX_CHARS) return body;
  return `${body.slice(0, REFINEMENT_NOTIFICATION_MESSAGE_MAX_CHARS)}\n\n[truncated — the full text is in the recap comment]`;
}

/** Which of these ids are still rows in the project. */
function survivingTicketIds(
  projectId: string,
  ticketIds: readonly string[]
): Set<string> {
  const distinct = Array.from(new Set(ticketIds));
  if (distinct.length === 0) return new Set();

  return new Set(
    db
      .select({ id: epics.id })
      .from(epics)
      .where(and(eq(epics.projectId, projectId), inArray(epics.id, distinct)))
      .all()
      .map((row) => row.id)
  );
}

/**
 * A ticket to file the board-wide record on when the pass left none of its
 * own — the top of the planning columns, else any ticket the project has.
 *
 * Deterministic (board order, then id) so two runs of the same pass do not
 * scatter their records across different tickets.
 */
export function fallbackCommentHost(projectId: string): string | null {
  const planning = db
    .select({ id: epics.id, position: epics.position })
    .from(epics)
    .where(
      and(
        eq(epics.projectId, projectId),
        inArray(epics.status, [...REFINEMENT_STATUSES])
      )
    )
    .orderBy(asc(epics.position), asc(epics.id))
    .get();
  if (planning) return planning.id;

  const any = db
    .select({ id: epics.id })
    .from(epics)
    .where(eq(epics.projectId, projectId))
    .orderBy(asc(epics.id))
    .get();
  return any?.id ?? null;
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

  // Which of the ids the pass named are still rows, asked of the DATABASE
  // rather than derived from the records.
  //
  // `ticketGone` is set on the record of the deleting call and on no other,
  // so a ticket that got an earlier record in the same pass — a priority
  // change, a promotion — and was retired afterwards still looks alive
  // there. Trusting the flag put such an id forward as a comment host, the
  // insert violated the FK, the catch below swallowed it, and the pass
  // published its whole breakdown nowhere.
  const alive = survivingTicketIds(
    input.projectId,
    changes.map((change) => change.ticketId)
  );
  const surviving = (candidates: RefinementChange[]): string[] =>
    Array.from(
      new Set(
        candidates
          .map((change) => change.ticketId)
          .filter((ticketId) => alive.has(ticketId))
      )
    );

  // One comment per ticket the pass reshaped structurally — a column move, a
  // merge it absorbed others into, or a ticket it added. See the module
  // header for why those and not every touched ticket.
  const movedTicketIds = surviving([
    ...report.promoted,
    ...report.demoted,
    ...report.merged,
    ...report.created,
  ]);

  // ...but the itemised, ticket-linked breakdown has to be published
  // SOMEWHERE, and it only ever lives inside a comment. A conservative pass
  // is the likely case, not a corner: the prompt re-ranks To do on every run
  // while promotion is gated on readiness, so a run that reorders and fixes
  // dependency edges without promoting anything is normal — and used to
  // produce no comment at all, losing the ticket links the acceptance
  // criteria ask for. When nothing changed column, fall back to the first
  // ticket the pass touched at all.
  const touchedTicketIds = surviving(changes);

  // And when the pass DELETED everything it touched, to any ticket the
  // project still has. That reads as a board-wide record filed on an
  // unrelated ticket, which is odd — but it is the only readable surface
  // there is: `notifications` has no consumer in the app (hooks/
  // useNotifications.ts is unmounted; the chrome reads /api/inbox, which is
  // built from ticket_comments and agent_sessions), so without this a pass
  // that discarded two Backlog tickets and nothing else leaves the user with
  // two tickets gone and no explanation anywhere they will look. The comment
  // says why it is filed there.
  const fullListTicketId =
    movedTicketIds[0] ??
    touchedTicketIds[0] ??
    (report.discarded.length > 0
      ? (fallbackCommentHost(input.projectId) ?? undefined)
      : undefined);

  // Comment on every moved ticket, plus the fallback host when there are no
  // moved tickets but the pass did change something.
  const commentTargets =
    movedTicketIds.length > 0
      ? movedTicketIds
      : fullListTicketId
        ? [fullListTicketId]
        : [];

  const unrelatedHost =
    movedTicketIds.length === 0 &&
    touchedTicketIds.length === 0 &&
    Boolean(fullListTicketId);

  const commentedTicketIds: string[] = [];
  for (const ticketId of commentTargets) {
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
            unrelatedHost,
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
    // A duplicate of what the recap comment carries, kept for the day the
    // notification surface is mounted — and the only copy when the project
    // has no ticket left to host a comment at all.
    message: formatDiscardedTombstones(report),
  });

  return { report, summary, commentedTicketIds, notificationId };
}
