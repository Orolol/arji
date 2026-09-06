/** POST /api/mcp/create-bug — create a standalone bug in the agent's project. */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { createBugFromMcp } from "@/lib/mcp/create-bug";
import { MCP_BUG_SEVERITIES } from "@/lib/mcp/create-bug-contract";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import { validateBody } from "@/lib/validation/validate";

const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(10000),
    severity: z.enum(MCP_BUG_SEVERITIES).optional(),
    source_ticket_id: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request, "create_bug");
  if (isErrorResponse(auth)) return auth;

  // CLI/direct chat already has the broader create_ticket board tool. Keep
  // create_bug reserved for durable agent sessions whose source session can
  // be shown on the new bug's activity feed.
  if (auth.agentType === "chat") {
    return NextResponse.json(
      {
        error: "create_bug is only available to agent sessions.",
        code: "FORBIDDEN",
      },
      { status: 403 },
    );
  }

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const result = await createBugFromMcp({
    auth,
    origin: new URL(request.url).origin,
    signal: request.signal,
    input: {
      title: body.title,
      description: body.description,
      severity: body.severity,
      sourceTicketId: body.source_ticket_id,
    },
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        code: result.code,
        ...(result.existingBug
          ? {
              existing_bug: {
                id: result.existingBug.id,
                readable_id: result.existingBug.readableId,
                title: result.existingBug.title,
                status: result.existingBug.status,
              },
            }
          : {}),
      },
      { status: result.status },
    );
  }

  return NextResponse.json({
    data: {
      bug: {
        id: result.bug.id,
        readable_id: result.bug.readableId,
        title: result.bug.title,
        status: result.bug.status,
        type: result.bug.type,
        priority: result.bug.priority,
      },
      source: {
        session_id: result.source.sessionId,
        ticket_id: result.source.ticketId,
        story_id: result.source.storyId,
      },
    },
  });
}
