import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { extractLastNonEmptyText } from "@/lib/utils/extract-last-text";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const active = db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.status, "running")
      )
    )
    .all();

  const enriched = active.map((session) => ({
    ...session,
    lastNonEmptyText: extractLastNonEmptyText(session.logsPath),
  }));

  return NextResponse.json({ data: enriched });
}
