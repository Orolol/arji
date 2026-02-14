import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq, and, isNotNull, desc } from "drizzle-orm";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const { searchParams } = new URL(request.url);
  const epicId = searchParams.get("epicId");
  const agentType = searchParams.get("agentType");

  const conditions = [
    eq(agentSessions.projectId, projectId),
    eq(agentSessions.status, "completed"),
    isNotNull(agentSessions.claudeSessionId),
  ];

  if (epicId) {
    conditions.push(eq(agentSessions.epicId, epicId));
  }

  if (agentType) {
    conditions.push(eq(agentSessions.agentType, agentType));
  }

  const sessions = db
    .select({
      id: agentSessions.id,
      claudeSessionId: agentSessions.claudeSessionId,
      agentType: agentSessions.agentType,
      lastNonEmptyText: agentSessions.lastNonEmptyText,
      completedAt: agentSessions.completedAt,
    })
    .from(agentSessions)
    .where(and(...conditions))
    .orderBy(desc(agentSessions.completedAt))
    .limit(10)
    .all();

  return NextResponse.json({ data: sessions });
}
