/**
 * GET  /api/projects/:projectId/refinement — is a pass in flight?
 * POST /api/projects/:projectId/refinement — start one.
 *
 * Thin route over lib/refinement/dispatch: it translates the dispatcher's
 * typed errors into the API's `{ data }` / `{ error }` shape and does not
 * duplicate any of its guards.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateOptionalBody } from "@/lib/validation/validate";
import { refinementOptionsSchema } from "@/lib/refinement/options";
import { errorResponse, isErrorResponse } from "@/lib/api/route-helpers";
import {
  RefinementDispatchError,
  dispatchRefinementSession,
  getActiveRefinementSession,
} from "@/lib/refinement/dispatch";
import { countRefinableTickets } from "@/lib/refinement/snapshot";

export interface RefinementStatus {
  running: boolean;
  sessionId: string | null;
  /** Tickets currently sitting in Backlog + To do — the pass's workload. */
  ticketCount: number;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  try {
    const active = getActiveRefinementSession(projectId);
    const data: RefinementStatus = {
      running: Boolean(active),
      sessionId: active?.id ?? null,
      ticketCount: countRefinableTickets(projectId),
    };
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error, "Failed to read refinement status");
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const parsed = await validateOptionalBody(refinementOptionsSchema, request);
  if (isErrorResponse(parsed)) return parsed;

  try {
    const result = await dispatchRefinementSession({
      projectId,
      ...parsed.data,
    });

    if (result.skipped) {
      return NextResponse.json({
        data: { started: false, reason: result.reason },
      });
    }

    return NextResponse.json({
      data: {
        started: true,
        sessionId: result.sessionId,
        provider: result.provider,
        ticketCount: result.ticketCount,
      },
    });
  } catch (error) {
    if (error instanceof RefinementDispatchError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.sessionId ? { sessionId: error.sessionId } : {}),
        },
        { status: error.status },
      );
    }
    return errorResponse(error, "Failed to start board refinement");
  }
}
