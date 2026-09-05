import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  ticketComments,
  ticketReadCursors,
} from "@/lib/db/schema";
import { isAwaitingReply } from "@/lib/kanban/awaiting-reply";
import { hasUnreadAiComment } from "@/lib/kanban/unread-ai";

/** Max length of the comment excerpt shipped to the inbox UI. */
const EXCERPT_LENGTH = 200;

export interface InboxItem {
  epicId: string;
  projectId: string;
  projectName: string;
  readableId: string | null;
  title: string;
  status: string | null;
  type: string | null;
  /** Latest agent session ended `asked_question` with no user reply since. */
  awaitingReply: boolean;
  /** Latest comment is agent-authored and newer than the read cursor. */
  unread: boolean;
  latestCommentAuthor: string | null;
  latestCommentExcerpt: string | null;
  latestCommentCreatedAt: string | null;
  lastReadAt: string | null;
}

function excerptOf(content: string | null): string | null {
  if (!content) return null;
  const flattened = content.replace(/\s+/g, " ").trim();
  if (flattened.length <= EXCERPT_LENGTH) return flattened;
  return `${flattened.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`;
}

/** Sort key: ISO and SQLite timestamps, normalized for lexicographic order. */
function sortableTimestamp(value: string | null): string {
  if (!value) return "";
  return value.includes("T") ? value : value.replace(" ", "T");
}

/**
 * GET /api/inbox — cross-project inbox of unread agent messages.
 *
 * An epic is in the inbox when:
 *  - its latest comment is agent-authored and newer than the epic's read
 *    cursor (`ticket_read_cursors`, no row = never read), OR
 *  - its latest agent session ended with the `asked_question` verdict and
 *    the user has not commented since (awaiting-reply — these stay in the
 *    inbox even after being read, until the user actually replies).
 *
 * Order: awaiting-reply first, then newest comment first.
 *
 * THE TWO CATEGORIES ARE COUNTED APART (B-arij-DWd1DEARyLMe). Most rows are
 * unread reports on tickets that are already finished; only the awaiting-reply
 * ones are a question actually held on the user. The response therefore
 * carries three numbers:
 *  - `unreadCount` — every row. UNCHANGED: this is the rule the global bar
 *    badge has always counted, and the ticket freezes it.
 *  - `unreadMessageCount` — rows whose latest agent message has not been read.
 *  - `awaitingReplyCount` — rows holding a real pending question.
 * A row can be in both categories (an unread question); it is still one row,
 * so the two never have to add up to `unreadCount`.
 */
export async function GET() {
  // Latest comment per epic (any author), carrying the content for excerpts.
  const rankedComments = db
    .select({
      epicId: ticketComments.epicId,
      latestCommentId: ticketComments.id,
      latestCommentAuthor: ticketComments.author,
      latestCommentContent: ticketComments.content,
      latestCommentCreatedAt: ticketComments.createdAt,
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${ticketComments.epicId}
        ORDER BY ${ticketComments.createdAt} DESC, ${ticketComments.id} DESC
      )`.as("row_num"),
    })
    .from(ticketComments)
    .where(sql`${ticketComments.epicId} IS NOT NULL`)
    .as("ranked_comments");

  const latestComments = db
    .select({
      epicId: rankedComments.epicId,
      latestCommentId: rankedComments.latestCommentId,
      latestCommentAuthor: rankedComments.latestCommentAuthor,
      latestCommentContent: rankedComments.latestCommentContent,
      latestCommentCreatedAt: rankedComments.latestCommentCreatedAt,
    })
    .from(rankedComments)
    .where(eq(rankedComments.rowNum, 1))
    .as("latest_comments");

  // Latest agent session per epic (any status) — delivery verdict for the
  // awaiting-reply signal. Same shape as the per-project epics GET.
  const rankedSessions = db
    .select({
      epicId: agentSessions.epicId,
      latestSessionOutcome: agentSessions.outcome,
      latestSessionEndedAt: sql<string | null>`COALESCE(
        ${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}
      )`.as("latest_session_ended_at"),
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${agentSessions.epicId}
        ORDER BY ${agentSessions.createdAt} DESC, ${agentSessions.id} DESC
      )`.as("session_row_num"),
    })
    .from(agentSessions)
    .where(sql`${agentSessions.epicId} IS NOT NULL`)
    .as("ranked_sessions");

  const latestSessions = db
    .select({
      epicId: rankedSessions.epicId,
      latestSessionOutcome: rankedSessions.latestSessionOutcome,
      latestSessionEndedAt: rankedSessions.latestSessionEndedAt,
    })
    .from(rankedSessions)
    .where(eq(rankedSessions.rowNum, 1))
    .as("latest_sessions");

  // Latest user-authored comment per epic — a user comment newer than the
  // asked_question session counts as the reply.
  const latestUserComments = db
    .select({
      epicId: ticketComments.epicId,
      latestUserCommentCreatedAt: sql<string | null>`MAX(${ticketComments.createdAt})`.as(
        "latest_user_comment_created_at"
      ),
    })
    .from(ticketComments)
    .where(
      and(
        sql`${ticketComments.epicId} IS NOT NULL`,
        eq(ticketComments.author, "user")
      )
    )
    .groupBy(ticketComments.epicId)
    .as("latest_user_comments");

  const rows = db
    .select({
      epicId: epics.id,
      projectId: epics.projectId,
      projectName: projects.name,
      readableId: epics.readableId,
      title: epics.title,
      status: epics.status,
      type: epics.type,
      latestCommentId: latestComments.latestCommentId,
      latestCommentAuthor: latestComments.latestCommentAuthor,
      latestCommentContent: latestComments.latestCommentContent,
      latestCommentCreatedAt: latestComments.latestCommentCreatedAt,
      latestSessionOutcome: latestSessions.latestSessionOutcome,
      latestSessionEndedAt: latestSessions.latestSessionEndedAt,
      latestUserCommentCreatedAt: latestUserComments.latestUserCommentCreatedAt,
      lastReadAt: ticketReadCursors.lastReadAt,
    })
    .from(epics)
    .innerJoin(projects, eq(epics.projectId, projects.id))
    .leftJoin(latestComments, eq(epics.id, latestComments.epicId))
    .leftJoin(latestSessions, eq(epics.id, latestSessions.epicId))
    .leftJoin(latestUserComments, eq(epics.id, latestUserComments.epicId))
    .leftJoin(ticketReadCursors, eq(epics.id, ticketReadCursors.epicId))
    .all();

  const items: InboxItem[] = rows
    .map((row) => ({
      row,
      unread: hasUnreadAiComment(row),
      awaitingReply: isAwaitingReply(row),
    }))
    .filter(({ unread, awaitingReply }) => unread || awaitingReply)
    .sort((a, b) => {
      if (a.awaitingReply !== b.awaitingReply) return a.awaitingReply ? -1 : 1;
      // Newest comment first within each group.
      return sortableTimestamp(b.row.latestCommentCreatedAt).localeCompare(
        sortableTimestamp(a.row.latestCommentCreatedAt)
      );
    })
    .map(({ row, unread, awaitingReply }) => ({
      epicId: row.epicId,
      projectId: row.projectId,
      projectName: row.projectName,
      readableId: row.readableId,
      title: row.title,
      status: row.status,
      type: row.type,
      awaitingReply,
      unread,
      latestCommentAuthor: row.latestCommentAuthor,
      latestCommentExcerpt: excerptOf(row.latestCommentContent),
      latestCommentCreatedAt: row.latestCommentCreatedAt,
      lastReadAt: row.lastReadAt,
    }));

  return NextResponse.json({
    data: {
      items,
      unreadCount: items.length,
      unreadMessageCount: items.filter((item) => item.unread).length,
      awaitingReplyCount: items.filter((item) => item.awaitingReply).length,
    },
  });
}
