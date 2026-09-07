"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { usePolling } from "@/hooks/usePolling";
import type {
  AgentSessionStreamType,
  BoundedSessionChunk,
} from "@/lib/agent-sessions/chunks";
import {
  countCharacters,
  fetchSessionChunkPage,
} from "@/lib/agent-sessions/session-detail";
import {
  chunkElisionMarkerSplitter,
  isChunkElisionMarker,
} from "@/lib/agent-sessions/chunk-cap";
import {
  chunkPruneMarkerSplitter,
  isChunkPruneMarker,
} from "@/lib/agent-sessions/chunk-retention";

/** The bounded first page the session detail payload already carried. */
export interface SessionStreamSeed {
  chunks: BoundedSessionChunk[];
  nextAfter: number | null;
  /** Characters of the chunk at `nextAfter` already delivered, if any. */
  nextOffset?: number;
  hasMore: boolean;
}

interface SessionOutputStreamProps {
  projectId: string;
  sessionId: string;
  streamType: AgentSessionStreamType;
  /** Preview page from `GET .../sessions/:id`; the rest is fetched on demand. */
  seed: SessionStreamSeed | null;
  /** True when the route could not read the stream at all. */
  unavailable?: boolean;
  /** Shown when the stream is empty — usually the session's logs.json text. */
  fallback?: React.ReactNode;
  /** While the session runs, the stream tails itself from its own cursor. */
  isRunning: boolean;
  emptyLabel: string;
  /**
   * Shown instead of `emptyLabel` while the session is still writing.
   * Defaults to the catalogue's `stream.waiting` when the caller omits it.
   */
  waitingLabel?: string;
}

/**
 * Split the stream's text around Arij's two elision markers — the write-path
 * cap's "the middle of this chunk is gone" and data retention's "the head of
 * this stream is gone" — and give each its own element, so Arij's own voice
 * reads as a notice rather than as one more dim line of agent output.
 *
 * Split, not a line-by-line map: a page carries up to a megabyte of text, and
 * one element per line would be thousands of nodes where the flat block needs
 * one. `String.split` with a capturing pattern interleaves the markers back
 * into the parts, so the surrounding text stays in whole runs. The two passes
 * nest rather than combine into one pattern: each marker's shape belongs to
 * the module that writes it, and neither owns the other's regexp source.
 */
function withElisionMarkers(text: string): React.ReactNode[] {
  return text.split(chunkElisionMarkerSplitter()).flatMap((part, index) =>
    isChunkElisionMarker(part)
      ? [
          <span
            key={`cap-${index}`}
            data-testid="chunk-elision-marker"
            className="text-strata-live-mid"
          >
            {part}
          </span>,
        ]
      : part.split(chunkPruneMarkerSplitter()).map((inner, innerIndex) =>
          isChunkPruneMarker(inner) ? (
            <span
              key={`prune-${index}-${innerIndex}`}
              data-testid="chunk-prune-marker"
              className="text-strata-live-mid"
            >
              {inner}
            </span>
          ) : (
            inner
          )
        )
  );
}

/**
 * One chunk stream, paged.
 *
 * The session detail route used to inline all three streams in full — 112 MB
 * for the worst session on the live database, read synchronously on the one
 * shared connection, so opening the page stalled every other request. Here
 * the page starts from the small preview the detail payload carried and walks
 * forward with `?stream=&after=`, one bounded page per click (or per poll
 * while the session is still writing).
 */
export function SessionOutputStream({
  projectId,
  sessionId,
  streamType,
  seed,
  unavailable = false,
  fallback,
  isRunning,
  emptyLabel,
  waitingLabel,
}: SessionOutputStreamProps) {
  const t = useTranslations("Sessions");
  const [chunks, setChunks] = useState<BoundedSessionChunk[]>(seed?.chunks ?? []);
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
      setError(page.chunkStreamsUnavailable ? t("stream.unreadable") : null);
      if (Array.isArray(page.chunks) && page.chunks.length > 0) {
        setChunks((current) => [...current, ...page.chunks]);
      }
    } catch {
      setError(t("stream.loadMoreError"));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [projectId, sessionId, streamType, t]);

  // A running session appends as it writes; a finished one waits for a click.
  usePolling(loadMore, 3000, isRunning && !unavailable, { immediate: false });

  if (unavailable) {
    return (
      <p className="text-[13px] text-destructive/90" data-testid={`stream-unavailable-${streamType}`}>
        {t("stream.unavailable", { stream: streamType })}
      </p>
    );
  }

  if (chunks.length === 0) {
    if (fallback) return <>{fallback}</>;
    return (
      <p className="text-[13px] text-muted-foreground">
        {isRunning ? waitingLabel ?? t("stream.waiting") : emptyLabel}
      </p>
    );
  }

  /**
   * Chunks that are on screen only in part.
   *
   * Counted per CHUNK, not per slice — one 8.3 MB chunk walked out over five
   * pages is one oversized chunk, not five — and a chunk whose slices have
   * reached its end no longer counts at all: after "Load more" has walked it
   * out, the pane really is showing all of it.
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

  return (
    <div className="flex flex-col gap-[10px]" data-testid={`stream-${streamType}`}>
      <div className="max-h-[500px] overflow-y-auto overflow-x-hidden font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap break-words text-muted-foreground">
        {withElisionMarkers(chunks.map((chunk) => chunk.content).join(""))}
      </div>
      {truncatedCount > 0 && (
        <p className="text-[11.5px] text-meta" data-testid={`stream-truncated-${streamType}`}>
          {t("stream.truncated", { count: truncatedCount })}
          {hasMore ? ` ${t("stream.loadMoreHint")}` : ""}
        </p>
      )}
      {error && <p className="text-[12px] text-destructive">{error}</p>}
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="h-[29px] w-fit rounded-[8px] px-[12px] text-[12.5px]"
          onClick={loadMore}
          disabled={loading}
          data-testid={`stream-load-more-${streamType}`}
        >
          {loading ? t("stream.loading") : t("stream.loadMore")}
        </Button>
      )}
    </div>
  );
}
