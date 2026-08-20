/**
 * POST /api/mcp/update-ticket-status — the mcp__arij__update_ticket_status
 * tool.
 *
 * Binds straight to the unified transition service, so agent moves obey
 * exactly the same workflow engine as UI drags: review→done still requires
 * the human approve/merge flow, and "released" is not even in the input enum
 * (system-only status). Invalid transitions surface as 409 tool errors the
 * agent can read and react to.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken, resolveTicketForToken } from "@/lib/mcp/http-auth";
import { applyTransition } from "@/lib/workflow/transition-service";
import { applyStoryTransition } from "@/lib/workflow/story-transition";
import { logTransition } from "@/lib/workflow/log";
import { emitTicketMoved } from "@/lib/events/emit";
import { tryExportArjiJson } from "@/lib/sync/export";
import type { KanbanStatus } from "@/lib/types/kanban";

const bodySchema = z
  .object({
    status: z.enum(["backlog", "todo", "in_progress", "review", "done"]),
    ticket_id: z.string().min(1).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const found = resolveTicketForToken(auth, body.ticket_id);
  if (isErrorResponse(found)) return found;
  const { epic } = found;

  const toStatus = body.status;

  // A story-scoped session means its OWN story unless it named another
  // ticket. Without this the tool moved the parent epic instead, dragging
  // every unfinished sibling into review — see lib/workflow/story-transition.ts.
  if (auth.userStoryId && !body.ticket_id) {
    const moved = applyStoryTransition({
      storyId: auth.userStoryId,
      epicId: epic.id,
      toStatus,
    });

    if (!moved.valid) {
      return NextResponse.json(
        { error: moved.error ?? "Invalid transition", code: "INVALID_TRANSITION" },
        { status: 409 }
      );
    }

    logTransition({
      projectId: auth.projectId,
      epicId: epic.id,
      fromStatus: moved.fromStatus ?? "backlog",
      toStatus,
      actor: "agent",
      reason: body.reason ?? "Agent MCP: update_ticket_status (story)",
      sessionId: auth.sessionId,
    });

    if (moved.promotedEpic) {
      emitTicketMoved(
        auth.projectId,
        epic.id,
        moved.epicFromStatus ?? "in_progress",
        "review"
      );
      logTransition({
        projectId: auth.projectId,
        epicId: epic.id,
        fromStatus: moved.epicFromStatus ?? "in_progress",
        toStatus: "review",
        actor: "agent",
        reason: "Every story is in review or done",
        sessionId: auth.sessionId,
      });
    }

    tryExportArjiJson(auth.projectId);

    return NextResponse.json({
      data: {
        ticketId: auth.userStoryId,
        scope: "story",
        fromStatus: moved.fromStatus,
        toStatus,
        promotedEpic: moved.promotedEpic ?? false,
      },
    });
  }

  const fromStatus = (epic.status ?? "backlog") as KanbanStatus;

  const result = applyTransition({
    projectId: auth.projectId,
    epicId: epic.id,
    fromStatus,
    toStatus,
    actor: "agent",
    source: "api",
    reason: body.reason ?? "Agent MCP: update_ticket_status",
    sessionId: auth.sessionId,
  });

  if (!result.valid) {
    return NextResponse.json(
      {
        error: result.error ?? "Invalid transition",
        code: "INVALID_TRANSITION",
      },
      { status: 409 }
    );
  }

  // Every other mutating route mirrors the board into arji.json; a status
  // moved through the agent tool channel must not leave the export stale.
  tryExportArjiJson(auth.projectId);

  return NextResponse.json({
    data: { ticketId: epic.id, fromStatus, toStatus },
  });
}
