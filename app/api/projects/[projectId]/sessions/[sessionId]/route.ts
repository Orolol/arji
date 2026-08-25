import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { processManager } from "@/lib/claude/process-manager";
import { agentScheduler } from "@/lib/agents/scheduler";
import { activityRegistry } from "@/lib/activity-registry";
import fs from "fs";
import { extractLastNonEmptyTextFromFile } from "@/lib/agent-sessions/last-text";
import { listSessionChunks } from "@/lib/agent-sessions/chunks";
import {
  collectArijActions,
  type ArijAction,
} from "@/lib/agent-sessions/arij-actions";
import {
  getSessionStatusForApi,
  isSessionLifecycleConflictError,
  isSessionNotFoundError,
  markSessionCancelled,
} from "@/lib/agent-sessions/lifecycle";
import { runBackfillRecentSessionLastNonEmptyTextOnce } from "@/lib/agent-sessions/backfill";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> }
) {
  const { projectId, sessionId } = await params;
  runBackfillRecentSessionLastNonEmptyTextOnce(projectId);

  // Scoped by the PAIR, not by id alone. The URL says which project this
  // session belongs to, and `agent_sessions.project_id` is NOT NULL, so a
  // mismatch is never ambiguous — it is a session from somewhere else, and
  // the prompt, logs and raw output on this payload are not this project's to
  // hand over. 404 rather than 403: a caller with the wrong project has no
  // business learning the id exists.
  const session = db
    .select()
    .from(agentSessions)
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.projectId, projectId))
    )
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

  // Structured board effects of this session (MCP tool calls + dispatch
  // wrapper artifacts) — best-effort, the detail page must not 500 over it.
  let arijActions: ArijAction[] = [];
  try {
    arijActions = collectArijActions({ sessionId });
  } catch {
    arijActions = [];
  }

  const extractedLastNonEmptyText = extractLastNonEmptyTextFromFile(session.logsPath);
  const lastNonEmptyText = extractedLastNonEmptyText || session.lastNonEmptyText || null;

  return NextResponse.json({
    data: {
      ...session,
      status: getSessionStatusForApi(session.status),
      // Legacy-row fallback handled inside resolveCliSessionId().
      cliSessionId: resolveCliSessionId(session),
      logs,
      chunkStreams,
      lastNonEmptyText,
      arijActions,
    },
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> }
) {
  const { projectId, sessionId } = await params;

  // Cancelling is the destructive half of this route, so the project scope
  // matters more here than on GET: without it, knowing an id is enough to kill
  // a run belonging to another project.
  const session = db
    .select()
    .from(agentSessions)
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.projectId, projectId))
    )
    .get();

  if (!session) {
    // Ephemeral activities (chat, spec generation, releases) have no
    // agent_sessions row — the registry is their only record, and it carries
    // the same project scope.
    if (activityRegistry.cancelInProject(sessionId, projectId)) {
      return NextResponse.json({ data: { cancelled: true } });
    }
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Drop a not-yet-started launch from the scheduler queue (no-op when the
  // session already started), then cancel any live process.
  agentScheduler.remove(sessionId);
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
