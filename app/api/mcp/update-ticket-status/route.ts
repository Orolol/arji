/**
 * POST /api/mcp/update-ticket-status — the mcp__arij__update_ticket_status
 * tool.
 *
 * Binds straight to the unified transition service, so agent moves obey
 * exactly the same workflow engine as UI drags. Neither "to_merge" nor
 * "done" is in the input enum: To Merge is reached through a passing review
 * verdict (the review drivers, source "review"), Done through a successful
 * merge, and "released" is system-only. Invalid transitions surface as 409
 * tool errors the agent can read and react to.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken, resolveTicketForToken } from "@/lib/mcp/http-auth";
import {
  applyStoryTransition,
  applyTransition,
  type StoryStatus,
} from "@/lib/workflow/transition-service";
import { tryExportArjiJson } from "@/lib/sync/export";
import { db } from "@/lib/db";
import { userStories } from "@/lib/db/schema";
import type { KanbanStatus } from "@/lib/types/kanban";
import { REFINEMENT_AGENT_TYPE } from "@/lib/refinement/constants";

const bodySchema = z
  .object({
    status: z.enum(["backlog", "todo", "in_progress", "review"]),
    ticket_id: z.string().min(1).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request, "update_ticket_status");
  if (isErrorResponse(auth)) return auth;

  // A board refinement pass is confined to Backlog/To do by the
  // `source: "refinement"` engine guard. This route writes with
  // `source: "api"` and resolves any ticket in the project from an explicit
  // ticket_id, so it would walk straight past that guard — a refinement
  // session could move work out of Review or Done. Its channel for column
  // moves is promote_ticket, which is pinned to the two planning columns and
  // demands the missing question on a demotion.
  //
  // The injected allowlist also withholds this tool from refinement spawns
  // (AGENT_TYPE_WITHHELD_TOOL_NAMES); that shapes what the model reaches
  // for, this is what makes it impossible.
  if (auth.agentType === REFINEMENT_AGENT_TYPE) {
    return NextResponse.json(
      {
        error:
          "update_ticket_status is not available to a board refinement pass. Use promote_ticket to move a ticket between Backlog and To do.",
        code: "REFINEMENT_TOOL_FORBIDDEN",
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
  const toStatus = body.status;

  // A story-scoped session's own ticket is its story, not the parent epic.
  // Without an explicit ticket_id the default move is story-scoped: the
  // owning-session exemption then applies at story level, and the epic keeps
  // its sibling-story rule — promotion belongs to the terminal handler
  // (transitionBuildCompleted). An explicit ticket_id still targets the
  // epic as before, where the engine's ownership gate keeps story sessions
  // locked out of it.
  if (auth.userStoryId && body.ticket_id === undefined) {
    const story = db
      .select()
      .from(userStories)
      .where(
        and(eq(userStories.id, auth.userStoryId), eq(userStories.epicId, epic.id))
      )
      .get();
    if (!story) {
      return NextResponse.json(
        {
          error: "This session's story no longer exists",
          code: "TICKET_NOT_FOUND",
        },
        { status: 404 }
      );
    }
    if (toStatus === "backlog") {
      // Stories have no backlog column; writing one would corrupt the row.
      return NextResponse.json(
        {
          error: "Stories have no Backlog column; use Todo instead.",
          code: "INVALID_TRANSITION",
        },
        { status: 409 }
      );
    }
    const storyFrom = (story.status ?? "todo") as StoryStatus;
    const storyResult = applyStoryTransition({
      projectId: auth.projectId,
      epicId: epic.id,
      userStoryId: story.id,
      fromStatus: storyFrom,
      toStatus: toStatus as StoryStatus,
      actor: "agent",
      source: "api",
      reason: body.reason ?? "Agent MCP: update_ticket_status",
      sessionId: auth.sessionId,
    });
    if (!storyResult.valid) {
      return NextResponse.json(
        {
          error: storyResult.error ?? "Invalid transition",
          code: "INVALID_TRANSITION",
        },
        { status: 409 }
      );
    }
    tryExportArjiJson(auth.projectId);
    return NextResponse.json({
      data: { ticketId: story.id, fromStatus: storyFrom, toStatus },
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
