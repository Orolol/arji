/**
 * Loading a ticket's comment history for an agent prompt.
 *
 * The prompt needs one thing a `ticket_comments` row does not carry: which
 * kind of agent wrote the comment. A review pass and a build report are both
 * `author: "agent"`, but only the review documents are elided down to the
 * most recent one (see commentHistorySection in prompt-builder.ts). The agent
 * type lives on the session that posted the comment, hence the join.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, ticketComments } from "@/lib/db/schema";
import type { PromptComment } from "./prompt-builder";

export type PromptCommentScope = { epicId: string } | { userStoryId: string };

/** A ticket's comments, oldest first, tagged with their author's agent type. */
export function loadPromptComments(scope: PromptCommentScope): PromptComment[] {
  const rows = db
    .select({
      author: ticketComments.author,
      content: ticketComments.content,
      createdAt: ticketComments.createdAt,
      agentType: agentSessions.agentType,
    })
    .from(ticketComments)
    .leftJoin(agentSessions, eq(ticketComments.agentSessionId, agentSessions.id))
    .where(
      "epicId" in scope
        ? eq(ticketComments.epicId, scope.epicId)
        : eq(ticketComments.userStoryId, scope.userStoryId),
    )
    .orderBy(ticketComments.createdAt)
    .all();

  return rows.map((row) => ({
    author: row.author as "user" | "agent",
    content: row.content,
    createdAt: row.createdAt ?? "",
    agentType: row.agentType ?? null,
  }));
}
