/**
 * POST /api/mcp/ask-question — the mcp__arij__ask_question tool.
 *
 * Two effects, in contract order:
 *   (a) flips the token store's askedQuestion flag — the authoritative signal
 *       classifySessionOutcome reads (beats the prose heuristic), which is
 *       what actually holds the ticket when the session ends;
 *   (b) posts the question as an agent comment so the user can reply in the
 *       ticket feed, which flows back into the next session's prompt.
 *
 * Deliberately does NOT call handleAskedQuestionOutcome: notifications and
 * hold logging stay owned by the dispatch routes' outcome pipeline
 * (lib/workflow/agent-question.ts) — firing them here too would double-notify.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ticketComments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken, resolveTicketForToken } from "@/lib/mcp/http-auth";
import { markQuestionAsked } from "@/lib/mcp/token-store";

const bodySchema = z
  .object({
    question: z.string().min(1).max(4000),
    ticket_id: z.string().min(1).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request, "ask_question");
  if (isErrorResponse(auth)) return auth;

  // Chat tokens (fast-mode board tools and CLI chat turns) have no session
  // outcome to hold — the user is already in the conversation. Answer in
  // the chat instead of routing a question through the ticket feed.
  if (auth.agentType === "chat") {
    return NextResponse.json(
      {
        error:
          "ask_question is not available in chat conversations — ask the user directly in the chat.",
        code: "FORBIDDEN",
      },
      { status: 403 }
    );
  }

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const found = resolveTicketForToken(auth, body.ticket_id);
  if (isErrorResponse(found)) return found;
  const { epic } = found;

  markQuestionAsked(auth.sessionId);

  db.insert(ticketComments)
    .values({
      id: createId(),
      epicId: epic.id,
      author: "agent",
      content: `**Question**\n\n${body.question}`,
      agentSessionId: auth.sessionId,
      createdAt: new Date().toISOString(),
    })
    .run();

  return NextResponse.json({
    data: { acknowledged: true, holds_ticket: true },
  });
}
