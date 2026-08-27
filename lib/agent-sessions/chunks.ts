import type Database from "better-sqlite3";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createId } from "@/lib/utils/nanoid";
import { sqlite } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  agentSessionChunks,
  agentSessionSequences,
  agentSessions,
} from "@/lib/db/schema";
import { extractLastNonEmptyText } from "@/lib/agent-sessions/last-text";

export type AgentSessionStreamType = "response" | "raw" | "output";

export interface SessionChunk {
  id: string;
  sessionId: string;
  streamType: AgentSessionStreamType;
  sequence: number;
  chunkKey: string | null;
  content: string;
  createdAt: string | null;
}

/**
 * Page size when a caller does not ask for one. Chunks average ~5.5 KB on the
 * live database, so this is a few hundred KB of content, not tens of MB.
 */
export const SESSION_CHUNK_PAGE_DEFAULT_LIMIT = 200;

/**
 * Byte budget for one page's content. A row limit alone does not bound a
 * page: chunks are capped at 64 KiB by most producers, but the store has
 * accepted single chunks of 8.3 MB (one CLI result blob written as one
 * chunk), so `limit` rows can still be tens of MB.
 */
export const SESSION_CHUNK_PAGE_MAX_BYTES = 1024 * 1024;

/**
 * Per-chunk content cap. A chunk larger than this is split across pages: the
 * page stops inside it and the cursor carries how much of it was delivered,
 * so the whole chunk is still reachable. The live database holds 19 chunks
 * over 1 MB and one of 8.3 MB — a one-shot CLI result blob written as a
 * single chunk — and no row-count bound can bound those.
 */
export const SESSION_CHUNK_MAX_CONTENT_BYTES = 256 * 1024;

/**
 * How many rows one underlying query may materialise. The page is assembled
 * batch by batch so that `limit` — which a client picks — never multiplies
 * with the per-chunk cap into one huge read: the byte budget usually ends the
 * loop after the first batch.
 */
const CHUNK_PAGE_BATCH_ROWS = 64;

/** A chunk, or a slice of one, as a bounded page serves it. */
export interface BoundedSessionChunk extends SessionChunk {
  /**
   * Character length of the STORED chunk (SQLite `length()`), before any cap,
   * so a client rendering a slice can say how much of it it is holding.
   */
  contentLength: number;
  /** True when `content` is only part of the stored chunk. */
  contentTruncated: boolean;
  /** Character offset of `content` within the stored chunk. */
  contentOffset: number;
}

export interface SessionChunkPageOptions {
  /** Exclusive lower bound on `sequence`. Omit or null for the first page. */
  after?: number | null;
  /**
   * Characters of the chunk AT `after` already delivered. Non-zero only when
   * the previous page stopped inside an oversized chunk; the page then
   * resumes from that offset before moving on to later chunks.
   */
  afterOffset?: number | null;
  /** Maximum number of chunks in the page. */
  limit?: number;
  /** Byte budget for the page's total content. */
  maxBytes?: number;
  /** Byte cap applied to each individual chunk's content. */
  maxChunkBytes?: number;
}

export interface SessionChunkPage {
  streamType: AgentSessionStreamType;
  chunks: BoundedSessionChunk[];
  /**
   * Cursor for the next request. The sequence of the last chunk in the page,
   * or the `after` the caller passed when the page came back empty — a live
   * session that has not written since simply yields the same cursor again.
   */
  nextAfter: number | null;
  /**
   * Second half of the cursor: characters of the chunk at `nextAfter` already
   * delivered, or 0 when that chunk was delivered whole. Echo both back.
   */
  nextOffset: number;
  /** True when more chunks — or more of the current one — remain. */
  hasMore: boolean;
}

/**
 * Characters, as SQLite counts them: `substr`/`length` work in code points,
 * and a UTF-16 length would drift on astral characters — enough to duplicate
 * or drop text at a slice boundary.
 */
function countCharacters(text: string): number {
  return [...text].length;
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte
 * character. Measuring in UTF-16 units instead would under-count: one unit is
 * up to three UTF-8 bytes, so a CJK-heavy page would blow its budget 3x.
 */
export function truncateUtf8(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  // Walk back off a continuation byte (0b10xxxxxx) so the slice ends on a
  // character boundary rather than decoding to U+FFFD.
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

export interface AppendSessionChunkInput {
  sessionId: string;
  streamType: AgentSessionStreamType;
  content: string;
  chunkKey?: string | null;
  createdAt?: string;
}

export interface AppendSessionChunkResult {
  inserted: boolean;
  chunk: SessionChunk;
}

export interface SessionChunkStore {
  appendChunk: (input: AppendSessionChunkInput) => AppendSessionChunkResult;
  listChunks: (
    sessionId: string,
    streamType: AgentSessionStreamType
  ) => SessionChunk[];
  /**
   * Bounded variant of `listChunks`: one keyset page of a single stream,
   * ordered by sequence, capped by row count AND by bytes. Added alongside
   * `listChunks` rather than replacing it — the forensic collector and the
   * Arij-action scanner want the whole stream and are unaffected.
   */
  listChunkPage: (
    sessionId: string,
    streamType: AgentSessionStreamType,
    options?: SessionChunkPageOptions
  ) => SessionChunkPage;
  /**
   * Timestamp of the most recent chunk for a session across all stream
   * types, or null when the session has no chunks yet. Cheap (single
   * indexed MAX) — used by the silent-session watchdog and the active
   * sessions monitor to derive "last output" freshness.
   */
  lastChunkAt: (sessionId: string) => string | null;
}

type ChunkRow = {
  id: string;
  sessionId: string;
  streamType: string;
  sequence: number;
  chunkKey: string | null;
  content: string;
  createdAt: string | null;
};

/**
 * `stream_type` is a plain text column in the schema; the store is the layer
 * that narrows it back to the union the rest of the app works with.
 */
function toSessionChunk(row: ChunkRow): SessionChunk {
  return {
    ...row,
    streamType: row.streamType as AgentSessionStreamType,
  };
}

export function createSessionChunkStore(
  database: Database.Database
): SessionChunkStore {
  const db = drizzle(database, { schema });

  // Built here rather than at module scope so that importing this module
  // stays free of any schema/driver evaluation.
  const chunkColumns = {
    id: agentSessionChunks.id,
    sessionId: agentSessionChunks.sessionId,
    streamType: agentSessionChunks.streamType,
    sequence: agentSessionChunks.sequence,
    chunkKey: agentSessionChunks.chunkKey,
    content: agentSessionChunks.content,
    createdAt: agentSessionChunks.createdAt,
  };

  const selectExistingByKeyStmt = db
    .select(chunkColumns)
    .from(agentSessionChunks)
    .where(
      and(
        eq(agentSessionChunks.sessionId, sql.placeholder("sessionId")),
        eq(agentSessionChunks.streamType, sql.placeholder("streamType")),
        eq(agentSessionChunks.chunkKey, sql.placeholder("chunkKey"))
      )
    )
    .limit(1)
    .prepare();

  const reserveSequenceStmt = db
    .insert(agentSessionSequences)
    .values({
      sessionId: sql.placeholder("sessionId"),
      nextSequence: 2,
      updatedAt: sql.placeholder("updatedAt"),
    })
    .onConflictDoUpdate({
      target: agentSessionSequences.sessionId,
      set: {
        nextSequence: sql`${agentSessionSequences.nextSequence} + 1`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning({
      sequence: sql`next_sequence - 1`.mapWith(Number),
    })
    .prepare();

  const insertChunkStmt = db
    .insert(agentSessionChunks)
    .values({
      id: sql.placeholder("id"),
      sessionId: sql.placeholder("sessionId"),
      streamType: sql.placeholder("streamType"),
      sequence: sql.placeholder("sequence"),
      chunkKey: sql.placeholder("chunkKey"),
      content: sql.placeholder("content"),
      createdAt: sql.placeholder("createdAt"),
    })
    .prepare();

  const listChunksStmt = db
    .select(chunkColumns)
    .from(agentSessionChunks)
    .where(
      and(
        eq(agentSessionChunks.sessionId, sql.placeholder("sessionId")),
        eq(agentSessionChunks.streamType, sql.placeholder("streamType"))
      )
    )
    .orderBy(asc(agentSessionChunks.sequence))
    .prepare();

  // The bounded page. `substr` caps each chunk at the source so an 8 MB blob
  // never becomes an 8 MB JS string, and `length()` still reports the full
  // stored size. Both bounds ride the existing
  // agent_session_chunks_session_stream_sequence_idx.
  const pageChunksStmt = db
    .select({
      ...chunkColumns,
      content: sql<string>`substr(${agentSessionChunks.content}, 1, ${sql.placeholder("maxChunkChars")})`,
      contentLength: sql<number>`length(${agentSessionChunks.content})`,
    })
    .from(agentSessionChunks)
    .where(
      and(
        eq(agentSessionChunks.sessionId, sql.placeholder("sessionId")),
        eq(agentSessionChunks.streamType, sql.placeholder("streamType")),
        gt(agentSessionChunks.sequence, sql.placeholder("after"))
      )
    )
    .orderBy(asc(agentSessionChunks.sequence))
    .limit(sql.placeholder("limit"))
    .prepare();

  // The tail of a chunk a previous page stopped inside. `substr(content,
  // offset + 1, cap)` is the one query that makes an 8.3 MB chunk readable
  // without ever putting 8.3 MB on one response.
  const chunkRemainderStmt = db
    .select({
      ...chunkColumns,
      content: sql<string>`substr(${agentSessionChunks.content}, ${sql.placeholder("offsetPlusOne")}, ${sql.placeholder("maxChunkChars")})`,
      contentLength: sql<number>`length(${agentSessionChunks.content})`,
    })
    .from(agentSessionChunks)
    .where(
      and(
        eq(agentSessionChunks.sessionId, sql.placeholder("sessionId")),
        eq(agentSessionChunks.streamType, sql.placeholder("streamType")),
        eq(agentSessionChunks.sequence, sql.placeholder("sequence"))
      )
    )
    .limit(1)
    .prepare();

  // One indexed existence probe, so "the page ended" and "the stream ended"
  // are never confused — including when the byte budget, not the row limit,
  // is what closed the page.
  const hasMoreChunksStmt = db
    .select({ sequence: agentSessionChunks.sequence })
    .from(agentSessionChunks)
    .where(
      and(
        eq(agentSessionChunks.sessionId, sql.placeholder("sessionId")),
        eq(agentSessionChunks.streamType, sql.placeholder("streamType")),
        gt(agentSessionChunks.sequence, sql.placeholder("after"))
      )
    )
    .limit(1)
    .prepare();

  const lastChunkAtStmt = db
    .select({
      lastChunkAt: sql<string | null>`max(${agentSessionChunks.createdAt})`,
    })
    .from(agentSessionChunks)
    .where(eq(agentSessionChunks.sessionId, sql.placeholder("sessionId")))
    .prepare();

  const updateLastNonEmptyTextStmt = db
    .update(agentSessions)
    // Wrapped in `sql` because `.set()` only accepts SQL / literal values.
    .set({ lastNonEmptyText: sql`${sql.placeholder("lastNonEmptyText")}` })
    .where(eq(agentSessions.id, sql.placeholder("sessionId")))
    .prepare();

  function listChunkPage(
    sessionId: string,
    streamType: AgentSessionStreamType,
    options: SessionChunkPageOptions = {}
  ): SessionChunkPage {
    const limit = Math.max(1, options.limit ?? SESSION_CHUNK_PAGE_DEFAULT_LIMIT);
    const maxBytes = Math.max(
      1,
      options.maxBytes ?? SESSION_CHUNK_PAGE_MAX_BYTES
    );
    // Clamped to the page budget so a page always carries something: without
    // it, a per-chunk cap above the budget would leave nothing to deliver.
    const maxChunkBytes = Math.max(
      1,
      Math.min(
        options.maxChunkBytes ?? SESSION_CHUNK_MAX_CONTENT_BYTES,
        maxBytes
      )
    );

    // Sequences start at 1, so 0 is "from the beginning of the stream".
    const start = options.after ?? 0;
    const startOffset = Math.max(0, options.afterOffset ?? 0);
    let cursor = start;
    // Characters of the chunk at `cursor` delivered so far; 0 means the
    // cursor sits between chunks.
    let offset = 0;
    let usedBytes = 0;
    const chunks: BoundedSessionChunk[] = [];

    /**
     * Add one row (or the tail of one) to the page. Returns false when the
     * page has to stop — either the budget is spent or the chunk is only
     * partly delivered and the cursor now points inside it.
     */
    const take = (
      row: {
        id: string;
        sessionId: string;
        streamType: string;
        sequence: number;
        chunkKey: string | null;
        content: string;
        contentLength: number;
        createdAt: string | null;
      },
      contentOffset: number
    ): boolean => {
      const capped = truncateUtf8(row.content, maxChunkBytes);
      const size = Buffer.byteLength(capped.text, "utf8");
      // Never an empty page over budget: the first slice always goes in, so a
      // client following the cursor always makes progress.
      if (chunks.length > 0 && usedBytes + size > maxBytes) return false;

      const delivered = contentOffset + countCharacters(capped.text);
      const complete = delivered >= row.contentLength;
      chunks.push({
        id: row.id,
        sessionId: row.sessionId,
        streamType: row.streamType as AgentSessionStreamType,
        sequence: row.sequence,
        chunkKey: row.chunkKey,
        content: capped.text,
        createdAt: row.createdAt,
        contentLength: row.contentLength,
        contentTruncated: !complete || contentOffset > 0,
        contentOffset,
      });
      usedBytes += size;
      cursor = row.sequence;
      offset = complete ? 0 : delivered;
      return complete;
    };

    // Resume inside the chunk the previous page stopped in, before moving on.
    if (startOffset > 0) {
      const remainder = chunkRemainderStmt.get({
        sessionId,
        streamType,
        sequence: start,
        offsetPlusOne: startOffset + 1,
        maxChunkChars: maxChunkBytes,
      });
      if (remainder && remainder.contentLength > startOffset) {
        if (!take(remainder, startOffset)) {
          return finish();
        }
      } else {
        // The chunk shrank or vanished: fall through to whatever follows it
        // rather than looping on a cursor that can never advance.
        offset = 0;
      }
    }

    let exhausted = false;
    while (chunks.length < limit && !exhausted) {
      const batchSize = Math.min(limit - chunks.length, CHUNK_PAGE_BATCH_ROWS);
      const rows = pageChunksStmt.all({
        sessionId,
        streamType,
        after: cursor,
        // SQLite's substr() counts characters, not bytes; this is the cheap
        // upper bound, and truncateUtf8 below cuts to the exact byte cap.
        maxChunkChars: maxChunkBytes,
        limit: batchSize,
      });
      if (rows.length < batchSize) exhausted = true;

      // `take` returns false both when the budget refuses the chunk and when
      // the chunk is only partly delivered; either way the page ends here and
      // the cursor says where to resume.
      for (const row of rows) {
        if (!take(row, 0)) return finish();
      }
    }

    return finish();

    function finish(): SessionChunkPage {
      return {
        streamType,
        chunks,
        nextAfter: chunks.length > 0 ? cursor : (options.after ?? null),
        nextOffset: chunks.length > 0 ? offset : startOffset,
        // More of the current chunk, or another chunk after it. One indexed
        // probe, so "the page ended" and "the stream ended" are never
        // confused — including when the byte budget closed the page.
        hasMore:
          offset > 0 ||
          Boolean(
            hasMoreChunksStmt.get({
              sessionId,
              streamType,
              after: chunks.length > 0 ? cursor : start,
            })
          ),
      };
    }
  }

  function appendChunk(
    input: AppendSessionChunkInput
  ): AppendSessionChunkResult {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const chunkKey = input.chunkKey ?? null;

    if (chunkKey) {
      const existing = selectExistingByKeyStmt.get({
        sessionId: input.sessionId,
        streamType: input.streamType,
        chunkKey,
      });
      if (existing) {
        return {
          inserted: false,
          chunk: toSessionChunk(existing),
        };
      }
    }

    const sequenceRow = reserveSequenceStmt.get({
      sessionId: input.sessionId,
      updatedAt: createdAt,
    });
    if (!sequenceRow) {
      throw new Error(
        `Failed to reserve sequence for session ${input.sessionId}`
      );
    }

    const chunk: SessionChunk = {
      id: createId(),
      sessionId: input.sessionId,
      streamType: input.streamType,
      sequence: sequenceRow.sequence,
      chunkKey,
      content: input.content,
      createdAt,
    };

    insertChunkStmt.run({
      id: chunk.id,
      sessionId: chunk.sessionId,
      streamType: chunk.streamType,
      sequence: chunk.sequence,
      chunkKey: chunk.chunkKey,
      content: chunk.content,
      createdAt: chunk.createdAt ?? createdAt,
    });

    if (input.streamType === "output" || input.streamType === "response") {
      const lastNonEmptyText = extractLastNonEmptyText(input.content);
      if (lastNonEmptyText) {
        updateLastNonEmptyTextStmt.run({
          lastNonEmptyText,
          sessionId: input.sessionId,
        });
      }
    }

    return {
      inserted: true,
      chunk,
    };
  }

  return {
    appendChunk(input: AppendSessionChunkInput): AppendSessionChunkResult {
      return db.transaction(() => appendChunk(input));
    },
    listChunks(
      sessionId: string,
      streamType: AgentSessionStreamType
    ): SessionChunk[] {
      return listChunksStmt.all({ sessionId, streamType }).map(toSessionChunk);
    },
    listChunkPage(
      sessionId: string,
      streamType: AgentSessionStreamType,
      options?: SessionChunkPageOptions
    ): SessionChunkPage {
      return listChunkPage(sessionId, streamType, options);
    },
    lastChunkAt(sessionId: string): string | null {
      return lastChunkAtStmt.get({ sessionId })?.lastChunkAt ?? null;
    },
  };
}

let defaultStore: SessionChunkStore | null = null;

function getDefaultStore(): SessionChunkStore {
  if (!defaultStore) {
    defaultStore = createSessionChunkStore(sqlite);
  }
  return defaultStore;
}

export function appendSessionChunk(
  input: AppendSessionChunkInput
): AppendSessionChunkResult {
  return getDefaultStore().appendChunk(input);
}

export function listSessionChunks(
  sessionId: string,
  streamType: AgentSessionStreamType
): SessionChunk[] {
  return getDefaultStore().listChunks(sessionId, streamType);
}

/**
 * Bounded counterpart to `listSessionChunks`: one page of a single stream.
 * Kept as a separate export on purpose — `listSessionChunks` still serves the
 * whole stream to the forensic collector and the Arij-action scanner, which
 * summarise it server-side and never ship it to a client.
 */
export function listSessionChunkPage(
  sessionId: string,
  streamType: AgentSessionStreamType,
  options?: SessionChunkPageOptions
): SessionChunkPage {
  return getDefaultStore().listChunkPage(sessionId, streamType, options);
}

export function lastSessionChunkAt(sessionId: string): string | null {
  return getDefaultStore().lastChunkAt(sessionId);
}
