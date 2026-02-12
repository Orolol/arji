import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { processManager } from "@/lib/claude/process-manager";
import fs from "fs";
import { extractLastNonEmptyText } from "@/lib/utils/extract-last-text";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> }
) {
  const { sessionId } = await params;

  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  let logs = null;
  if (session.logsPath && fs.existsSync(session.logsPath)) {
    try {
      logs = JSON.parse(fs.readFileSync(session.logsPath, "utf-8"));
    } catch {
      logs = null;
    }
  }

  const lastNonEmptyText = extractLastNonEmptyText(session.logsPath);

  return NextResponse.json({ data: { ...session, logs, lastNonEmptyText } });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> }
) {
  const { sessionId } = await params;

  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.status !== "running") {
    return NextResponse.json(
      { error: "Session is not running" },
      { status: 400 }
    );
  }

  // Cancel in process manager
  processManager.cancel(sessionId);

  // Update DB
  const now = new Date().toISOString();
  db.update(agentSessions)
    .set({ status: "cancelled", completedAt: now, error: "Cancelled by user" })
    .where(eq(agentSessions.id, sessionId))
    .run();

  return NextResponse.json({ data: { cancelled: true } });
}
