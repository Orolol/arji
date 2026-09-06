/**
 * POST /api/mcp/get-ticket — read model for the mcp__arij__get_ticket tool.
 *
 * Returns the ticket the calling session was launched for (or another ticket
 * in the same project via ticket_id): core fields, user stories with
 * acceptance criteria, the comment thread, and review findings.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { reviewComments, ticketComments, userStories } from "@/lib/db/schema";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken, resolveTicketForToken } from "@/lib/mcp/http-auth";

const bodySchema = z
  .object({
    ticket_id: z.string().min(1).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request, "get_ticket");
  if (isErrorResponse(auth)) return auth;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;

  const found = resolveTicketForToken(auth, validated.data.ticket_id);
  if (isErrorResponse(found)) return found;
  const { epic } = found;

  const stories = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epic.id))
    .orderBy(userStories.position)
    .all();

  const comments = db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.epicId, epic.id))
    .orderBy(ticketComments.createdAt)
    .all();

  const findings = db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.epicId, epic.id))
    .orderBy(reviewComments.createdAt)
    .all();

  return NextResponse.json({
    data: {
      ticket: {
        id: epic.id,
        title: epic.title,
        description: epic.description,
        status: epic.status,
        type: epic.type,
        branchName: epic.branchName,
      },
      userStories: stories.map((story) => ({
        id: story.id,
        title: story.title,
        description: story.description,
        status: story.status,
        acceptanceCriteria: story.acceptanceCriteria,
      })),
      comments: comments.map((comment) => ({
        author: comment.author,
        content: comment.content,
        createdAt: comment.createdAt,
      })),
      reviewFindings: findings.map((finding) => ({
        id: finding.id,
        filePath: finding.filePath,
        lineNumber: finding.lineNumber,
        body: finding.body,
        severityNote: null,
        status: finding.status,
        author: finding.author,
      })),
    },
  });
}
