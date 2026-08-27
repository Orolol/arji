/**
 * Client/server contract for the session detail route
 * (`GET /api/projects/:projectId/sessions/:sessionId`).
 *
 * The route used to answer with the whole session row (prompt included), the
 * entire `logs.json` parsed into memory, and all three chunk streams in full.
 * Measured against the live database that is 112 MB for the worst session and
 * over 5 MB for 19 of them — read synchronously on the one shared
 * better-sqlite3 connection, so a single click blocked every other request,
 * every SSE heartbeat and the Full Auto sweep for as long as it took.
 *
 * The bounded shape:
 * - the row comes back without `prompt` unless `?include=prompt` is passed;
 * - `logs.result` is capped, with a marker in the text when it was cut;
 * - each stream ships a short preview page, and clients that want the rest
 *   page forward with `?stream=<raw|output|response>&after=<sequence>&limit=`.
 *
 * This module is imported by client components, so it must stay free of any
 * server-only import (`@/lib/db`, `fs`, better-sqlite3). Types from the chunk
 * store are imported with `import type` for that reason.
 */
import type {
  AgentSessionStreamType,
  BoundedSessionChunk,
} from "@/lib/agent-sessions/chunks";

/** The three streams a session records. */
export const SESSION_STREAM_TYPES = ["raw", "output", "response"] as const;

export function isSessionStreamType(
  value: string | null
): value is AgentSessionStreamType {
  return (
    value !== null &&
    (SESSION_STREAM_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Ceiling for an explicit `?limit=` on a stream page. The byte budget in the
 * store is the real bound; this stops a client from asking for a row count
 * that would take many batches to refuse.
 */
export const SESSION_CHUNK_PAGE_MAX_LIMIT = 1000;

/**
 * Chunks embedded per stream in the combined payload. Deliberately small:
 * the session detail page polls this route every 3 seconds while a session
 * runs, and the two other callers (the board's completion toast and "What the
 * agent did") read no chunks at all. Clients that want the stream page
 * forward with `?stream=`.
 */
export const SESSION_DETAIL_PREVIEW_LIMIT = 20;

/** Byte budget for each embedded preview — three of them per response. */
export const SESSION_DETAIL_PREVIEW_BYTES = 64 * 1024;

/** Cap on the `result` string served from `logs.json`. */
export const SESSION_LOGS_MAX_RESULT_BYTES = 256 * 1024;

/**
 * Above this, `logs.json` is not parsed at all — `logsTruncated` is set and
 * the same text is available, paginated, from the `response` stream. Parsing
 * an 8.6 MB document (the largest on the live database) on the shared
 * synchronous connection is the stall this route exists to stop.
 */
export const SESSION_LOGS_MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Hard ceiling on the served `logs` document, whatever its shape. Capping
 * `result` bounds what Arij writes today; this bounds everything else.
 */
export const SESSION_LOGS_MAX_SERVED_BYTES = 512 * 1024;

/**
 * Cap on the one-line `lastNonEmptyText` preview. The stored value is the
 * last non-empty LINE of the session's output, which is ~1 KB at worst across
 * the live database — but nothing bounds it at the write side, and a CLI that
 * emits one very long line would put megabytes of it on every poll of this
 * route. The UI renders it truncated to a single line either way.
 */
export const SESSION_LAST_TEXT_MAX_BYTES = 4 * 1024;

/**
 * Runaway guard for a follow-the-cursor loop over one stream. At the default
 * page size this is far past any real session, and it keeps a bad cursor from
 * spinning the browser forever.
 */
export const SESSION_CHUNK_MAX_PAGES = 50;

/** One stream page as the route returns it. */
export interface SessionChunkPageResponse {
  sessionId: string;
  streamType: AgentSessionStreamType;
  chunks: BoundedSessionChunk[];
  nextAfter: number | null;
  /**
   * Characters of the chunk at `nextAfter` already delivered — non-zero when
   * a page stopped inside an oversized chunk. Echo it back with `after`.
   */
  nextOffset?: number;
  hasMore: boolean;
  /** Set when the chunk read failed — distinct from a stream with no output. */
  chunkStreamsUnavailable?: boolean;
}

/** Fetch one page of one stream. Rejects on a failed response. */
export async function fetchSessionChunkPage(
  projectId: string,
  sessionId: string,
  streamType: AgentSessionStreamType,
  options: {
    after?: number | null;
    offset?: number | null;
    limit?: number;
    signal?: AbortSignal;
  } = {}
): Promise<SessionChunkPageResponse> {
  const url = new URL(
    `/api/projects/${projectId}/sessions/${sessionId}`,
    window.location.origin
  );
  url.searchParams.set("stream", streamType);
  if (options.after != null) url.searchParams.set("after", String(options.after));
  if (options.offset) url.searchParams.set("offset", String(options.offset));
  if (options.limit !== undefined) {
    url.searchParams.set("limit", String(options.limit));
  }

  const response = await fetch(url.toString(), { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Session stream request failed (${response.status})`);
  }
  const body = (await response.json()) as { data?: SessionChunkPageResponse };
  if (!body.data) throw new Error("Session stream response had no data");
  return body.data;
}

/**
 * Read a stream forward from `after` until it is exhausted, appending each
 * page as it lands so a caller can paint before the tail arrives.
 */
export async function fetchSessionStream(
  projectId: string,
  sessionId: string,
  streamType: AgentSessionStreamType,
  options: {
    after?: number | null;
    offset?: number | null;
    limit?: number;
    signal?: AbortSignal;
    onPage?: (page: SessionChunkPageResponse) => void;
  } = {}
): Promise<{
  chunks: BoundedSessionChunk[];
  nextAfter: number | null;
  nextOffset: number;
}> {
  const chunks: BoundedSessionChunk[] = [];
  let after = options.after ?? null;
  let offset = options.offset ?? 0;

  for (let page = 0; page < SESSION_CHUNK_MAX_PAGES; page++) {
    const result = await fetchSessionChunkPage(projectId, sessionId, streamType, {
      after,
      offset,
      limit: options.limit,
      signal: options.signal,
    });
    chunks.push(...result.chunks);
    options.onPage?.(result);
    after = result.nextAfter;
    offset = result.nextOffset ?? 0;
    if (!result.hasMore) return { chunks, nextAfter: after, nextOffset: offset };
  }

  // Never silently: the caller is showing a truncated stream from here on.
  console.warn(
    `[sessions] stopped after ${SESSION_CHUNK_MAX_PAGES} pages of the ${streamType} stream for session ${sessionId}; the output shown is truncated.`
  );
  return { chunks, nextAfter: after, nextOffset: offset };
}
