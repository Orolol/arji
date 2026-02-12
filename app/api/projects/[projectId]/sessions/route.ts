import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { getSessionStatusForApi } from "@/lib/agent-sessions/lifecycle";
import { runBackfillRecentSessionLastNonEmptyTextOnce } from "@/lib/agent-sessions/backfill";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  runBackfillRecentSessionLastNonEmptyTextOnce(projectId);

  const sessions = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.projectId, projectId))
    .orderBy(desc(agentSessions.createdAt))
    .all();

  const normalized = sessions.map((session) => ({
    ...session,
    status: getSessionStatusForApi(session.status),
  }));

  return NextResponse.json({ data: normalized });
}
