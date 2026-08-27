import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { and, eq, getTableColumns } from "drizzle-orm";
import { processManager } from "@/lib/claude/process-manager";
import { agentScheduler } from "@/lib/agents/scheduler";
import { activityRegistry } from "@/lib/activity-registry";
import fs from "fs";
import {
  extractLastNonEmptyTextFromFile,
  extractLastNonEmptyTextFromLogs,
} from "@/lib/agent-sessions/last-text";
import {
  listSessionChunkPage,
  truncateUtf8,
  SESSION_CHUNK_PAGE_MAX_BYTES,
  type AgentSessionStreamType,
  type SessionChunkPage,
} from "@/lib/agent-sessions/chunks";
import {
  isSessionStreamType,
  SESSION_CHUNK_PAGE_MAX_LIMIT,
  SESSION_DETAIL_PREVIEW_BYTES,
  SESSION_DETAIL_PREVIEW_LIMIT,
  SESSION_LOGS_MAX_FILE_BYTES,
  SESSION_LOGS_MAX_RESULT_BYTES,
  SESSION_LOGS_MAX_SERVED_BYTES,
  SESSION_LAST_TEXT_MAX_BYTES,
  SESSION_STREAM_TYPES,
} from "@/lib/agent-sessions/session-detail";
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

/**
 * Every column except `prompt`. On the live database the prompt is up to 1.8
 * MB of a single response and the detail page only shows it when the user
 * opens the Prompt tab, so it is served on `?include=prompt` and nowhere
 * else. Derived from the table rather than hand-listed: a column added to the
 * schema keeps appearing here, and only `prompt` is a deliberate omission.
 */
const { prompt: promptColumn, ...sessionColumnsWithoutPrompt } =
  getTableColumns(agentSessions);

const sessionColumnsWithPrompt = {
  ...sessionColumnsWithoutPrompt,
  prompt: promptColumn,
};

type SessionLogs = Record<string, unknown> & { result?: unknown };

interface SessionLogsRead {
  logs: unknown;
  /** The file was too large to parse, or its content was cut down to a cap. */
  truncated: boolean;
  /** The file exists but could not be read or parsed. */
  unavailable: boolean;
  /**
   * The parsed document, when there is one — so the caller can derive from it
   * instead of reading the same file again.
   */
  parsed?: unknown;
}

/**
 * Read `logs.json` under a byte bound. The file is a sibling of the chunk
 * streams — the same output, written once more at the end of the run — and
 * the largest on the live database is 8.6 MB, nearly all of it `result`.
 */
function readSessionLogs(logsPath: string | null): SessionLogsRead {
  if (!logsPath || !fs.existsSync(logsPath)) {
    return { logs: null, truncated: false, unavailable: false };
  }

  try {
    const size = fs.statSync(logsPath).size;
    if (size > SESSION_LOGS_MAX_FILE_BYTES) {
      // Not parsed at all: JSON.parse of a multi-megabyte document blocks the
      // event loop for every other caller. The same text is in the `response`
      // stream, which pages.
      return { logs: null, truncated: true, unavailable: false };
    }

    const parsed = JSON.parse(fs.readFileSync(logsPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { logs: null, truncated: false, unavailable: false, parsed };
    }

    let logs: unknown = parsed;
    let truncated = false;

    // `result` is where the size is: for the 8.6 MB log on the live database
    // it is 8,295,860 of the 8,600,000 bytes.
    if (!Array.isArray(parsed) && typeof (parsed as SessionLogs).result === "string") {
      const full = (parsed as SessionLogs).result as string;
      const capped = truncateUtf8(full, SESSION_LOGS_MAX_RESULT_BYTES);
      if (capped.truncated) {
        const total = Buffer.byteLength(full, "utf-8");
        // The marker rides inside the string so it survives everywhere the
        // result is shown OR exported, not just where a flag is read.
        logs = {
          ...(parsed as SessionLogs),
          result: `${capped.text}\n\n[Arij: output truncated — showing ${SESSION_LOGS_MAX_RESULT_BYTES} of ${total} bytes. The rest is in the Raw Logs stream below, which pages.]`,
        };
        truncated = true;
      }
    }

    // Shape-agnostic backstop. Capping `result` bounds the documents Arij
    // writes today; it does nothing for a legacy array-shaped log, or one
    // whose bulk sits in some other field. Serving nothing beats reopening
    // the hole this route exists to close — the streams still have the text.
    if (JSON.stringify(logs).length > SESSION_LOGS_MAX_SERVED_BYTES) {
      return { logs: null, truncated: true, unavailable: false, parsed };
    }

    return { logs, truncated, unavailable: false, parsed };
  } catch (error) {
    console.warn(
      `[sessions] failed to read logs for session at ${logsPath}:`,
      error
    );
    return { logs: null, truncated: false, unavailable: true };
  }
}

/** One-line preview, so it is served as one — never as a whole stream. */
function capLastNonEmptyText(text: string | null): string | null {
  if (!text) return null;
  const capped = truncateUtf8(text, SESSION_LAST_TEXT_MAX_BYTES);
  return capped.truncated ? `${capped.text}…` : capped.text;
}

function parseLimit(raw: string | null): number | undefined {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(parsed, 1), SESSION_CHUNK_PAGE_MAX_LIMIT);
}

/** `?after=` is a sequence number; anything else means "from the start". */
function parseAfter(raw: string | null): number | null {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * `?offset=` is the other half of the cursor: how much of the chunk at
 * `after` the last page already delivered. Non-zero only for a chunk too
 * large to fit one page.
 */
function parseOffset(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * One stream page, or an explicit unavailable marker. A chunk read that fails
 * used to collapse to `null` alongside a session that simply produced no
 * output — indistinguishable to the client, and silent in the log.
 */
function readChunkPage(
  sessionId: string,
  streamType: AgentSessionStreamType,
  options: {
    after?: number | null;
    afterOffset?: number;
    limit?: number;
    maxBytes: number;
  }
): { page: SessionChunkPage; unavailable: boolean } {
  try {
    return {
      page: listSessionChunkPage(sessionId, streamType, options),
      unavailable: false,
    };
  } catch (error) {
    console.warn(
      `[sessions] failed to read the ${streamType} stream of session ${sessionId}:`,
      error
    );
    return {
      page: {
        streamType,
        chunks: [],
        nextAfter: options.after ?? null,
        nextOffset: options.afterOffset ?? 0,
        hasMore: false,
      },
      unavailable: true,
    };
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> }
) {
  const { projectId, sessionId } = await params;
  const { searchParams } = new URL(request.url);
  const streamParam = searchParams.get("stream");
  const include = new Set(
    (searchParams.get("include") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );

  runBackfillRecentSessionLastNonEmptyTextOnce(projectId);

  if (streamParam !== null && !isSessionStreamType(streamParam)) {
    return NextResponse.json(
      {
        error: `Unknown stream "${streamParam}". Expected one of: ${SESSION_STREAM_TYPES.join(", ")}.`,
      },
      { status: 400 }
    );
  }

  // Scoped by the PAIR, not by id alone. The URL says which project this
  // session belongs to, and `agent_sessions.project_id` is NOT NULL, so a
  // mismatch is never ambiguous — it is a session from somewhere else, and
  // the prompt, logs and raw output on this payload are not this project's to
  // hand over. 404 rather than 403: a caller with the wrong project has no
  // business learning the id exists.
  const scope = and(
    eq(agentSessions.id, sessionId),
    eq(agentSessions.projectId, projectId)
  );

  // A stream page needs the scope check but none of the row: the id lookup
  // stays a single indexed read no matter how large the session grew.
  if (isSessionStreamType(streamParam)) {
    const exists = db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(scope)
      .get();
    if (!exists) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const after = parseAfter(searchParams.get("after"));
    const { page, unavailable } = readChunkPage(sessionId, streamParam, {
      after,
      afterOffset: parseOffset(searchParams.get("offset")),
      limit: parseLimit(searchParams.get("limit")),
      maxBytes: SESSION_CHUNK_PAGE_MAX_BYTES,
    });

    return NextResponse.json({
      data: {
        sessionId,
        ...page,
        ...(unavailable ? { chunkStreamsUnavailable: true } : {}),
      },
    });
  }

  const wantsPrompt = include.has("prompt");
  const session = db
    .select(wantsPrompt ? sessionColumnsWithPrompt : sessionColumnsWithoutPrompt)
    .from(agentSessions)
    .where(scope)
    .get();

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const logsRead = readSessionLogs(session.logsPath);

  // A preview of each stream, so a client that only wants the tail of a run
  // does not pay for a second round trip — and so no client pays for 112 MB.
  let chunkStreamsUnavailable = false;
  const chunkStreams = Object.fromEntries(
    SESSION_STREAM_TYPES.map((streamType) => {
      const { page, unavailable } = readChunkPage(sessionId, streamType, {
        limit: SESSION_DETAIL_PREVIEW_LIMIT,
        maxBytes: SESSION_DETAIL_PREVIEW_BYTES,
      });
      chunkStreamsUnavailable = chunkStreamsUnavailable || unavailable;
      return [streamType, page];
    })
  ) as Record<AgentSessionStreamType, SessionChunkPage>;

  // Structured board effects of this session (MCP tool calls + dispatch
  // wrapper artifacts) — best-effort, the detail page must not 500 over it.
  let arijActions: ArijAction[] = [];
  let arijActionsUnavailable = false;
  try {
    arijActions = collectArijActions({ sessionId });
  } catch (error) {
    console.warn(
      `[sessions] failed to collect Arij actions for session ${sessionId}:`,
      error
    );
    arijActions = [];
    arijActionsUnavailable = true;
  }

  // Derived from the document `readSessionLogs` already parsed. Only the
  // paths where there is no parsed document — an unreadable file, or one too
  // large to parse — fall back to the reader that opens the file itself.
  const extractedLastNonEmptyText =
    logsRead.parsed !== undefined
      ? extractLastNonEmptyTextFromLogs(logsRead.parsed)
      : logsRead.unavailable
        ? extractLastNonEmptyTextFromFile(session.logsPath)
        : null;
  const lastNonEmptyText = capLastNonEmptyText(
    extractedLastNonEmptyText || session.lastNonEmptyText || null
  );

  return NextResponse.json({
    data: {
      ...session,
      status: getSessionStatusForApi(session.status),
      // Legacy-row fallback handled inside resolveCliSessionId().
      cliSessionId: resolveCliSessionId(session),
      logs: logsRead.logs,
      // Explicit rather than inferred: "no logs" and "logs too large to serve
      // here" and "the logs file is unreadable" are three different states.
      logsTruncated: logsRead.truncated,
      ...(logsRead.unavailable ? { logsUnavailable: true } : {}),
      chunkStreams,
      ...(chunkStreamsUnavailable ? { chunkStreamsUnavailable: true } : {}),
      lastNonEmptyText,
      arijActions,
      ...(arijActionsUnavailable ? { arijActionsUnavailable: true } : {}),
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
