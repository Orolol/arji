import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getProjectOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import {
  dispatchMemoryDistillSession,
  evaluateDistillSourceEligibility,
  hasPendingMemoryDistill,
  isMemoryDistillSourceError,
  loadDistillSourceCandidate,
} from "@/lib/workflow/memory-distill";
import { isMemoryWriterBusyError } from "@/lib/workflow/memory-writer-lock";

type Params = { params: Promise<{ projectId: string }> };

const distillSchema = z.object({
  /** Session whose learnings should be distilled (context source). */
  sourceSessionId: z.string().min(1).optional(),
  /** Optional explicit named agent, like other dispatch routes accept. */
  namedAgentId: z.string().min(1).optional(),
});

/**
 * POST /api/projects/[projectId]/memory/distill
 *
 * Manual trigger for the 'memory_distill' agent (the "Distill learnings"
 * button on a completed session's detail page). Dispatches through the
 * per-project scheduler with the normal session lifecycle — see
 * lib/workflow/memory-distill.ts.
 *
 * 409 when ANY memory writer — another distill, or a dream — is already
 * queued/running for the project: two concurrent rewrites of the same document
 * would race, last-write-wins.
 *
 * 400 when the named source is not distillable: a memory writer (its output IS
 * the memory) or a run that has not completed. The UI only offers the button
 * where this holds, but the endpoint must not depend on the UI for it.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const validated = await validateBody(distillSchema, request);
  if (isValidationError(validated)) return validated;
  const { sourceSessionId, namedAgentId } = validated.data;

  // Source eligibility, not merely existence: a direct POST could otherwise
  // name a dream (whose output IS the memory) or a run that never finished.
  // The rule lives in the workflow so the route and the dispatch boundary ask
  // exactly the same question; the route's job is only to pick the status.
  if (sourceSessionId) {
    const candidate = loadDistillSourceCandidate(projectId, sourceSessionId);
    if (!candidate) {
      return NextResponse.json(
        { error: "Source session not found" },
        { status: 404 }
      );
    }
    const eligibility = evaluateDistillSourceEligibility(candidate);
    if (!eligibility.eligible) {
      return NextResponse.json(
        { error: eligibility.reason, code: "MEMORY_DISTILL_SOURCE_INVALID" },
        { status: 400 }
      );
    }
  }

  // The guard covers BOTH memory writers, so the message must too: saying
  // "a distillation is in progress" when a dream holds the document sends the
  // user looking for a session that does not exist.
  if (hasPendingMemoryDistill(projectId)) {
    return NextResponse.json(
      {
        error: "A memory rewrite is already in progress for this project.",
        code: "MEMORY_DISTILL_PENDING",
      },
      { status: 409 }
    );
  }

  try {
    const { sessionId } = await dispatchMemoryDistillSession({
      projectId,
      sourceSessionId: sourceSessionId ?? null,
      namedAgentId: namedAgentId ?? null,
    });
    return NextResponse.json({ data: { sessionId } });
  } catch (error) {
    // Lost the race for the document between the check above and the insert —
    // a conflict, not a fault.
    if (isMemoryWriterBusyError(error)) {
      return NextResponse.json(
        { error: (error as Error).message, code: "MEMORY_DISTILL_PENDING" },
        { status: 409 }
      );
    }
    // The dispatch boundary refused the source (it re-checks independently of
    // the pre-check above) — a bad request, not a server fault.
    if (isMemoryDistillSourceError(error)) {
      return NextResponse.json(
        {
          error: (error as Error).message,
          code: "MEMORY_DISTILL_SOURCE_INVALID",
        },
        { status: 400 }
      );
    }
    return errorResponse(error, "Failed to dispatch memory distillation");
  }
}
