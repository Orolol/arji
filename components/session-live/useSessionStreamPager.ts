"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { usePolling } from "@/hooks/usePolling";
import type { SessionStreamSeed } from "@/components/sessions/SessionOutputStream";
import type {
  AgentSessionStreamType,
  BoundedSessionChunk,
} from "@/lib/agent-sessions/chunks";
import {
  countCharacters,
  fetchSessionChunkPage,
} from "@/lib/agent-sessions/session-detail";

/**
 * One chunk stream, paged — the cursor discipline of
 * `components/sessions/SessionOutputStream.tsx` lifted out of the component so
 * the LIVE LOG can render the same stream its own way (line grammar, glyphs,
 * per-chunk timestamps) without forking the paging.
 *
 * `SessionOutputStream` itself is untouched: 16 tests pin it, and the Réponse
 * pane on this screen still mounts it as-is.
 *
 * The session detail route used to inline all three streams in full — 112 MB
 * for the worst session on the live database, read synchronously on the one
 * shared connection, so opening the page stalled every other request. This
 * starts from the small preview the detail payload carried and walks forward
 * with `?stream=&after=`, one bounded page per click (or per poll while the
 * session is still writing).
 */

export interface SessionStreamPagerOptions {
  projectId: string;
  sessionId: string;
  streamType: AgentSessionStreamType;
  /** Preview page from `GET .../sessions/:id`; the rest is fetched on demand. */
  seed: SessionStreamSeed | null;
  /** True when the route could not read the stream at all. */
  unavailable?: boolean;
  /** While the session runs, the stream tails itself from its own cursor. */
  isRunning: boolean;
}

export interface SessionStreamPager {
  chunks: BoundedSessionChunk[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** Chunks on screen only in part — counted per CHUNK, not per slice. */
  truncatedCount: number;
  loadMore: () => Promise<void>;
}

export function useSessionStreamPager({
  projectId,
  sessionId,
  streamType,
  seed,
  unavailable = false,
  isRunning,
}: SessionStreamPagerOptions): SessionStreamPager {
  const [chunks, setChunks] = useState<BoundedSessionChunk[]>(
    seed?.chunks ?? []
  );
  const [hasMore, setHasMore] = useState(seed?.hasMore ?? false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Held in refs, not state: the poll below must never read a stale cursor
  // and re-append chunks it already has. The cursor has two halves — the last
  // sequence delivered, and how much of THAT chunk went out, which is
  // non-zero only for a chunk too large to fit one page.
  const cursor = useRef<number | null>(seed?.nextAfter ?? null);
  const cursorOffset = useRef<number>(seed?.nextOffset ?? 0);
  const inFlight = useRef(false);

  // A different session (or stream) in the same mounted page starts over.
  useEffect(() => {
    setChunks(seed?.chunks ?? []);
    setHasMore(seed?.hasMore ?? false);
    setError(null);
    cursor.current = seed?.nextAfter ?? null;
    cursorOffset.current = seed?.nextOffset ?? 0;
    // Seeding is deliberately keyed on the identity of the stream, not on the
    // seed object: the detail route re-sends its preview on every 3s poll, and
    // re-seeding from it would throw away everything paged in since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, streamType]);

  const loadMore = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const page = await fetchSessionChunkPage(projectId, sessionId, streamType, {
        after: cursor.current,
        offset: cursorOffset.current,
      });
      cursor.current = page.nextAfter;
      cursorOffset.current = page.nextOffset ?? 0;
      setHasMore(page.hasMore);
      setError(
        page.chunkStreamsUnavailable
          ? "This session's output could not be read."
          : null
      );
      if (Array.isArray(page.chunks) && page.chunks.length > 0) {
        setChunks((current) => [...current, ...page.chunks]);
      }
    } catch {
      setError("Could not load more output.");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [projectId, sessionId, streamType]);

  // A running session appends as it writes; a finished one waits for a click.
  usePolling(loadMore, 3000, isRunning && !unavailable, { immediate: false });

  /**
   * Chunks that are on screen only in part.
   *
   * Counted per CHUNK, not per slice — one 8.3 MB chunk walked out over five
   * pages is one oversized chunk, not five — and a chunk whose slices have
   * reached its end no longer counts at all: after "Load more" has walked it
   * out, the pane really is showing all of it. `countCharacters` counts code
   * points, because `contentLength` comes from SQLite `length()` and a JS
   * `.length` over-counts anything astral — agent output carries emoji
   * routinely.
   */
  const truncatedCount = (() => {
    const reachBySequence = new Map<number, { reach: number; length: number }>();
    for (const chunk of chunks) {
      if (!chunk.contentTruncated && chunk.contentOffset === 0) continue;
      const reach = chunk.contentOffset + countCharacters(chunk.content);
      const seen = reachBySequence.get(chunk.sequence);
      reachBySequence.set(chunk.sequence, {
        reach: Math.max(reach, seen?.reach ?? 0),
        length: chunk.contentLength,
      });
    }
    let count = 0;
    for (const { reach, length } of reachBySequence.values()) {
      if (reach < length) count += 1;
    }
    return count;
  })();

  return { chunks, hasMore, loading, error, truncatedCount, loadMore };
}
