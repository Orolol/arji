import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getProjectOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { dispatchDreamingSession } from "@/lib/workflow/dreaming";
import { hasPendingMemoryWriter } from "@/lib/workflow/memory-writer-lock";

type Params = { params: Promise<{ projectId: string }> };

const dreamSchema = z.object({
  /** Optional explicit named agent, like other dispatch routes accept. */
  namedAgentId: z.string().min(1).optional(),
});

/**
 * POST /api/projects/[projectId]/memory/dream
 *
 * Manual trigger for the 'dreaming' agent — the cross-session pass that
 * rewrites the project memory from the last N terminal sessions of MANY
 * tickets (see lib/workflow/dreaming.ts). The other trigger is the end of a
 * night run, behind the `dreaming_after_night_run` setting.
 *
 * 409 when ANY memory writer — a dream, or a distill — is already
 * queued/running for the project: both replace the whole document, so two at
 * once would race, last-write-wins.
 *
 * 200 with `sessionId: null` when the window turned up nothing new — the
 * journalled no-op. Deliberately NOT an error: "nothing changed since the last
 * dream" is a correct, successful answer, and the `reason` says so.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const validated = await validateBody(dreamSchema, request);
  if (isValidationError(validated)) return validated;
  const { namedAgentId } = validated.data;

  if (hasPendingMemoryWriter(projectId)) {
    return NextResponse.json(
      {
        error: "A memory rewrite is already in progress for this project.",
        code: "DREAMING_PENDING",
      },
      { status: 409 }
    );
  }

  try {
    const result = await dispatchDreamingSession({
      projectId,
      namedAgentId: namedAgentId ?? null,
      trigger: "manual",
    });
    return NextResponse.json({
      data: {
        sessionId: result.sessionId,
        dispatched: result.dispatched,
        reason: result.reason,
        sessionsAnalyzed: result.sessionsAnalyzed,
      },
    });
  } catch (error) {
    return errorResponse(error, "Failed to dispatch the dreaming session");
  }
}
