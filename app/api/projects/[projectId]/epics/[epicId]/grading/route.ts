import { NextRequest, NextResponse } from "next/server";
import {
  dispatchGradingSession,
  GradingDispatchError,
} from "@/lib/grading/dispatch";
import { errorResponse } from "@/lib/api/route-helpers";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

/** Manual acceptance-grading dispatch. Grading never changes ticket status. */
export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;
  const body = await request.json().catch(() => ({}));
  const namedAgentId =
    typeof body.namedAgentId === "string" && body.namedAgentId.trim()
      ? body.namedAgentId.trim()
      : null;

  try {
    const result = await dispatchGradingSession({
      projectId,
      epicId,
      namedAgentId,
    });

    if (result.skipped) {
      return NextResponse.json({ data: result });
    }

    return NextResponse.json({
      data: {
        skipped: false,
        sessionId: result.sessionId,
        provider: result.provider,
        segregated: result.segregated,
        builderProvider: result.builderProvider,
      },
    });
  } catch (error) {
    if (error instanceof GradingDispatchError) {
      if (error.payload) {
        return NextResponse.json(error.payload, { status: error.status });
      }
      return NextResponse.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status },
      );
    }
    return errorResponse(error, "Failed to start acceptance grading");
  }
}
