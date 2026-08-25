import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gradingReports } from "@/lib/db/schema";
import {
  dispatchGradingSession,
  GradingDispatchError,
} from "@/lib/grading/dispatch";
import {
  errorResponse,
  getEpicOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { parseGradingEntries } from "@/lib/grading/report";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

/** Latest atomic report used by the detail badges. */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;
  const found = getEpicOr404(projectId, epicId);
  if (isErrorResponse(found)) return found;

  const report = db
    .select()
    .from(gradingReports)
    .where(eq(gradingReports.epicId, epicId))
    .orderBy(desc(gradingReports.createdAt), desc(gradingReports.id))
    .limit(1)
    .get();
  if (!report) return NextResponse.json({ data: null });

  const gradings = parseGradingEntries(report.gradings);
  if (!gradings) {
    return NextResponse.json(
      { error: "Latest grading report is malformed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ data: { ...report, gradings } });
}

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
