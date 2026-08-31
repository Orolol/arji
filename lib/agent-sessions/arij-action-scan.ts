/**
 * Bounded, resumable scan of a session's raw chunk stream for
 * `mcp__arij__*` tool calls.
 *
 * The durable half of the Arij-actions list is three indexed reads
 * (`collectDurableArijActions`). The other half — read-only calls like
 * `get_ticket`, and effectful calls that left no artifact because the board
 * refused them — only exists in the provider's raw output, and finding it
 * used to mean `listSessionChunks(sessionId, "raw")`: one unbounded SELECT.
 * On the live database the largest raw stream is 3,015 rows / 113.6 MB, and
 * replaying just that SELECT takes 276–287 ms before any JSON parsing. That
 * ran on the session detail request, which the detail page polls every three
 * seconds, on the one shared synchronous better-sqlite3 connection — so it
 * stalled every other request, the SSE heartbeats and the Full Auto sweep,
 * however small the response itself was.
 *
 * This module makes the scan pay-as-you-go:
 *
 *   - one call reads at most `ARIJ_ACTION_SCAN_MAX_BYTES` of the stream,
 *     through the same bounded page reader the output tabs use;
 *   - where it stopped, and the partially-parsed line it stopped inside, are
 *     kept in a small process-local cache, so the next call resumes instead
 *     of starting over;
 *   - a live session therefore only ever scans what it appended since the
 *     last poll, and a terminal session is scanned once per process.
 *
 * The cache is a cache: losing it (restart, eviction) costs a rescan, never
 * correctness. Nothing durable depends on it.
 */
import {
  createArijToolCallScanner,
  type ArijToolCall,
  type ArijToolCallScanner,
} from "./arij-actions";
import { listSessionChunkPage } from "./chunks";

/**
 * Bytes of raw stream one call may read. Small enough that the synchronous
 * read plus its JSON parsing stays a few tens of milliseconds; large enough
 * that an ordinary session finishes in one call.
 */
export const ARIJ_ACTION_SCAN_MAX_BYTES = 2 * 1024 * 1024;

/** Chunk rows one call may read, whichever bound is reached first. */
export const ARIJ_ACTION_SCAN_MAX_CHUNKS = 500;

/**
 * Sessions kept mid-scan. Only the ones being looked at right now matter, and
 * each entry holds a handful of tool calls plus at most
 * `ARIJ_SCAN_MAX_PENDING_CHARS` of carry.
 */
const ARIJ_ACTION_SCAN_CACHE_SIZE = 16;

interface ScanState {
  scanner: ArijToolCallScanner;
  /** Chunk sequence the next page resumes after. */
  after: number | null;
  /** Characters of the chunk at `after` already fed to the scanner. */
  offset: number;
}

/** Insertion-ordered, so the first key is the least recently used. */
const scans = new Map<string, ScanState>();

export interface ArijToolCallScanResult {
  /** Every call found so far — a prefix of the stream's calls, in order. */
  toolCalls: ArijToolCall[];
  /** True when the stream has more to scan; call again to continue. */
  hasMore: boolean;
}

function stateFor(sessionId: string): ScanState {
  const existing = scans.get(sessionId);
  if (existing) {
    // Re-insert to mark it most recently used.
    scans.delete(sessionId);
    scans.set(sessionId, existing);
    return existing;
  }

  while (scans.size >= ARIJ_ACTION_SCAN_CACHE_SIZE) {
    const oldest = scans.keys().next().value;
    if (oldest === undefined) break;
    scans.delete(oldest);
  }

  const created: ScanState = {
    scanner: createArijToolCallScanner(),
    after: null,
    offset: 0,
  };
  scans.set(sessionId, created);
  return created;
}

/**
 * Advance the scan of one session by one bounded page and return everything
 * found so far. Synchronous, like every other read on this connection — the
 * point is that it is bounded, not that it yields.
 */
export function scanArijToolCalls(
  sessionId: string,
  options: { maxBytes?: number; limit?: number } = {}
): ArijToolCallScanResult {
  const state = stateFor(sessionId);

  const page = listSessionChunkPage(sessionId, "raw", {
    after: state.after,
    afterOffset: state.offset,
    limit: options.limit ?? ARIJ_ACTION_SCAN_MAX_CHUNKS,
    maxBytes: options.maxBytes ?? ARIJ_ACTION_SCAN_MAX_BYTES,
  });

  for (const chunk of page.chunks) {
    state.scanner.push(chunk.content, chunk.createdAt);
  }
  // An empty page leaves the cursor where it was, so a live session that has
  // not written since simply asks again from the same place.
  state.after = page.nextAfter;
  state.offset = page.nextOffset;

  return { toolCalls: state.scanner.snapshot(), hasMore: page.hasMore };
}

/** Drop all cached scans. Tests use it; nothing in the app needs to. */
export function resetArijToolCallScans(): void {
  scans.clear();
}
