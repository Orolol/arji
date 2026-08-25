/**
 * POST /api/mcp/submit-findings — the mcp__arij__submit_findings tool
 * (review sessions).
 *
 * Storage decision: per-finding rows go into review_comments because that is
 * the table the workflow actually enforces on — open rows block review→done
 * (lib/workflow/context.ts feeding the engine guards) and the approve route
 * bulk-resolves them. One summary ticket comment mirrors the verdict into the
 * activity feed (same mirror pattern as the review-comments route).
 *
 * The verdict does NOT drive ticket status server-side in v1: the review
 * revert driver remains the prose parse of the session output, so the tool
 * description orders agents to still end with the "**Overall Verdict: …**"
 * line.
 *
 * No ticket_id: findings always attach to the ticket the session was
 * launched for.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { reviewComments, ticketComments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken, resolveTicketForToken } from "@/lib/mcp/http-auth";

const findingSchema = z
  .object({
    file_path: z.string().min(1),
    line: z.number().int().min(1),
    body: z.string().min(1).max(2000),
    severity: z.enum(["critical", "major", "minor", "info"]),
  })
  .strict();

const bodySchema = z
  .object({
    verdict: z.enum([
      "approved",
      "approved_with_minor_issues",
      "changes_requested",
    ]),
    summary: z.string().min(1).max(4000),
    findings: z.array(findingSchema).max(50),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  // Review-session tool: chat tokens (fast-mode board tools and CLI chat
  // turns) have no launch ticket and no review to file against.
  if (auth.agentType === "chat") {
    return NextResponse.json(
      {
        error: "submit_findings is only available to review sessions.",
        code: "FORBIDDEN",
      },
      { status: 403 }
    );
  }

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const found = resolveTicketForToken(auth);
  if (isErrorResponse(found)) return found;
  const { epic } = found;

  const now = new Date().toISOString();

  const findingIds: string[] = [];
  for (const finding of body.findings) {
    const id = createId();
    db.insert(reviewComments)
      .values({
        id,
        epicId: epic.id,
        filePath: finding.file_path,
        lineNumber: finding.line,
        body: `[${finding.severity}] ${finding.body}`,
        author: "agent",
        status: "open",
        // The token is already scoped to the submitting session — recording it
        // is what lets the Dreaming digest attribute a finding to the run that
        // filed it instead of guessing from timestamps.
        agentSessionId: auth.sessionId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    findingIds.push(id);
  }

  const commentId = createId();
  db.insert(ticketComments)
    .values({
      id: commentId,
      epicId: epic.id,
      author: "agent",
      content: `**Review findings (${body.verdict.replace(/_/g, " ")})**\n\n${body.summary}`,
      agentSessionId: auth.sessionId,
      createdAt: now,
    })
    .run();

  return NextResponse.json({ data: { findingIds, commentId } });
}
