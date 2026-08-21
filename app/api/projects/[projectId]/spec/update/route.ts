import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getProjectOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import {
  dispatchSpecUpdateSession,
  hasPendingSpecUpdate,
} from "@/lib/workflow/spec-update";

type Params = { params: Promise<{ projectId: string }> };

const specUpdateSchema = z.object({
  /** Optional focus instruction injected into the update prompt. */
  instruction: z.string().max(10000).optional(),
  /** Optional explicit named agent, like other dispatch routes accept. */
  namedAgentId: z.string().min(1).optional(),
});

/**
 * POST /api/projects/[projectId]/spec/update
 *
 * Manual trigger for the "Mettre à jour la spec" action on the Spec view.
 * Dispatches a plan-mode agent session through the per-project scheduler —
 * see lib/workflow/spec-update.ts. The stored spec is replaced only when the
 * session delivers an answer.
 *
 * 409 when a spec update is already queued/running for the project: two
 * concurrent rewrites of the same document would race, last-write-wins.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const validated = await validateBody(specUpdateSchema, request);
  if (isValidationError(validated)) return validated;
  const { instruction, namedAgentId } = validated.data;

  if (hasPendingSpecUpdate(projectId)) {
    return NextResponse.json(
      {
        error: "A spec update is already in progress for this project.",
        code: "SPEC_UPDATE_PENDING",
      },
      { status: 409 }
    );
  }

  try {
    const { sessionId } = await dispatchSpecUpdateSession({
      projectId,
      instruction: instruction?.trim() || null,
      namedAgentId: namedAgentId ?? null,
    });
    return NextResponse.json({ data: { sessionId } });
  } catch (error) {
    return errorResponse(error, "Failed to dispatch spec update");
  }
}
