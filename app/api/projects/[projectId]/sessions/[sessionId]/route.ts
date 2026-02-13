import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { processManager } from "@/lib/claude/process-manager";
import { activityRegistry } from "@/lib/activity-registry";
import fs from "fs";
import { extractLastNonEmptyText } from "@/lib/utils/extract-last-text";
import { listSessionChunks } from "@/lib/agent-sessions/chunks";
import {
  getSessionStatusForApi,
  isSessionLifecycleConflictError,
  isSessionNotFoundError,
  markSessionCancelled,
} from "@/lib/agent-sessions/lifecycle";
import { runBackfillRecentSessionLastNonEmptyTextOnce } from "@/lib/agent-sessions/backfill";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> }
) {
  const { projectId, sessionId } = await params;
  runBackfillRecentSessionLastNonEmptyTextOnce(projectId);

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

  let chunkStreams: {
    raw: ReturnType<typeof listSessionChunks>;
    output: ReturnType<typeof listSessionChunks>;
    response: ReturnType<typeof listSessionChunks>;
  } | null = null;

  try {
    chunkStreams = {
      raw: listSessionChunks(sessionId, "raw"),
      output: listSessionChunks(sessionId, "output"),
      response: listSessionChunks(sessionId, "response"),
    };
  } catch {
    chunkStreams = null;
  }

  const extractedLastNonEmptyText = extractLastNonEmptyText(session.logsPath);
  const lastNonEmptyText = extractedLastNonEmptyText || session.lastNonEmptyText || null;

  return NextResponse.json({
    data: {
      ...session,
      status: getSessionStatusForApi(session.status),
      logs,
      chunkStreams,
      lastNonEmptyText,
    },
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> }
) {
  const { sessionId } = await params;

  // Try activity registry as fallback for ephemeral activities
  {
    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();

    if (!session) {
      const cancelled = activityRegistry.cancel(sessionId);
      if (cancelled) {
        return NextResponse.json({ data: { cancelled: true } });
      }
      // Fall through to markSessionCancelled which will throw SessionNotFoundError
    }
  }

  // Cancel in process manager
  processManager.cancel(sessionId);
  const now = new Date().toISOString();

  try {
    markSessionCancelled(sessionId, "Cancelled by user", now);
  } catch (error) {
    if (isSessionNotFoundError(error)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (isSessionLifecycleConflictError(error)) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          details: error.details,
        },
        { status: 409 }
      );
    }
    throw error;
  }

  return NextResponse.json({ data: { cancelled: true } });
}
