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
 * The verdict is persisted on the CALLING SESSION's row
 * (agent_sessions.review_verdict) and is the authoritative transition signal
 * for that review: lib/pipeline/findings.ts reads it first and only falls
 * back to the prose scan when it is NULL — which is what a provider without
 * MCP support leaves behind. The tool description still asks for the
 * "**Overall Verdict: …**" line so a session whose verdict never reaches the
 * database (crash between the tool call and the write, MCP-less reviewer)
 * remains decidable.
 *
 * A reviewer calling the tool twice overwrites the verdict: the last call is
 * the reviewer's final word, while the findings of both calls accumulate as
 * separate rows (each one still has to be resolved).
 *
 * A REJECTED call matters just as much as an accepted one. A 401 here means
 * a review that will finish looking clean while having filed nothing, so the
 * auth failure is traced onto the ticket before the rejection is returned
 * (lib/mcp/review-channel-failure.ts). The verdict side of that guarantee —
 * an MCP-capable reviewer with no persisted verdict does not count as clean
 * — lives in lib/pipeline/findings.ts.
 *
 * No ticket_id: findings always attach to the ticket the session was
 * launched for.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { agentSessions, reviewComments, ticketComments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken, resolveTicketForToken } from "@/lib/mcp/http-auth";
import { recordSubmitFindingsAuthFailure } from "@/lib/mcp/review-channel-failure";

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
  if (isErrorResponse(auth)) {
    // A rejected review is invisible everywhere else: the session still ends
    // "answered" and simply files nothing, which every downstream gate used
    // to read as "reviewed, nothing found". Leave a trace on the ticket
    // before returning the 401 — the response itself is unchanged.
    recordSubmitFindingsAuthFailure(request);
    return auth;
  }

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

  // The verdict belongs to the session, not to a finding — a summary-only
  // review files zero findings and still delivered a verdict. Scoped to the
  // token's own session id, so a review can only ever speak for itself.
  db.update(agentSessions)
    .set({ reviewVerdict: body.verdict })
    .where(eq(agentSessions.id, auth.sessionId))
    .run();

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
