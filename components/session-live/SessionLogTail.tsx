"use client";

import { useEffect, useMemo, useRef } from "react";

import {
  DiffDelta,
  Mono,
  PillButton,
  SurfaceCard,
  TimelineLine,
} from "@/components/piscine";
import type { SessionStreamSeed } from "@/components/sessions/SessionOutputStream";
import { isChunkElisionMarker } from "@/lib/agent-sessions/chunk-cap";
import { isChunkPruneMarker } from "@/lib/agent-sessions/chunk-retention";

import {
  classifyLogLine,
  elapsedStamp,
  splitInlineDelta,
  type LogLineKind,
} from "./log-lines";
import { useSessionStreamPager } from "./useSessionStreamPager";

/**
 * The terminal card of the LIVE LOG band — the screen's only real scroller.
 *
 * It reads the `raw` stream, and only `raw`: that is the one stream written
 * incrementally as the process emits (`lib/providers/base-provider.ts`, one
 * chunk per emission with `chunkKey: "<source>:<index>"`). `output` and
 * `response` are each a single final chunk written once at the end
 * (`"final-output"` / `"final-response"`), so neither of them streams. The old
 * page hid `raw` in a third tab; here the raw stream IS the screen.
 */

/** Verbatim, from the sentence the old Raw Logs tab showed. */
const UNAVAILABLE_COPY =
  "This session's raw output could not be read — the record may be damaged. This is not the same as a session that produced no output.";

export interface SessionLogTailProps {
  projectId: string;
  sessionId: string;
  seed: SessionStreamSeed | null;
  unavailable?: boolean;
  isRunning: boolean;
  /** The session's ISO start, against which each chunk's mm:ss is measured. */
  startedAt: string | null;
  /** Pre-chunk-store sessions: their text only exists in `logs.json`. */
  logsFallback?: React.ReactNode;
  /** While on, every append re-pins the scroll to the bottom. */
  tailOn: boolean;
  /** Bumped by the tail toggle to force a re-pin even when `tailOn` was true. */
  pinKey: number;
  /** The reader scrolled away from the bottom; the band releases the tail. */
  onTailBreak: () => void;
}

/** How far off the bottom counts as "the reader has taken over". */
const TAIL_RELEASE_PX = 24;

interface RenderLine {
  key: string;
  text: string;
  /** Only the FIRST line of a chunk carries one — see below. */
  stamp: string | null;
}

/**
 * The counts at the end of a log line, spaced by their own inline-flex.
 * `DiffDelta` is `display:contents` so that the row's gap spaces the two
 * numerals; inside a sentence there is no row gap, so one is supplied here.
 */
function InlineDelta({
  added,
  removed,
}: {
  added: number | null;
  removed: number | null;
}) {
  if (added === null && removed === null) return null;
  return (
    <span className="ml-[5px] inline-flex items-baseline gap-[5px]">
      <DiffDelta added={added} removed={removed} size={11.5} />
    </span>
  );
}

export function SessionLogTail({
  projectId,
  sessionId,
  seed,
  unavailable = false,
  isRunning,
  startedAt,
  logsFallback,
  tailOn,
  pinKey,
  onTailBreak,
}: SessionLogTailProps) {
  const { chunks, hasMore, loading, error, truncatedCount, loadMore } =
    useSessionStreamPager({
      projectId,
      sessionId,
      streamType: "raw",
      seed,
      unavailable,
      isRunning,
    });

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  /**
   * One row per line of output.
   *
   * TIMESTAMPS ARE PER CHUNK, NOT PER LINE. `agent_session_chunks.created_at`
   * is the only time this data has; nothing stores when an individual line was
   * written. So the FIRST line of each chunk carries the chunk's mm:ss and the
   * rest of that chunk carries none — inventing a time per line would be a
   * fabrication, and repeating the chunk's time down every line would be a
   * different one.
   */
  const lines = useMemo<RenderLine[]>(() => {
    const out: RenderLine[] = [];
    for (const chunk of chunks) {
      const parts = chunk.content.split("\n");
      // A chunk that ends in a newline would otherwise draw a blank last row.
      if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
      const stamp = elapsedStamp(startedAt, chunk.createdAt ?? null);
      parts.forEach((text, index) => {
        out.push({
          key: `${chunk.id}:${chunk.contentOffset}:${index}`,
          text,
          stamp: index === 0 ? stamp : null,
        });
      });
    }
    return out;
  }, [chunks, startedAt]);

  /**
   * Tailing: pin to the bottom and STAY there.
   *
   * A one-shot `scrollTop = scrollHeight` in a render effect is not enough —
   * it runs before the flex column has settled its final height, so the
   * browser clamps the assignment to zero and the first paint of a long log
   * opens at the TOP. A ResizeObserver on the content re-pins after every
   * layout change: the settling first paint, a late web font, and every
   * appended chunk. Programmatic scrolling does not trip the release check
   * below, because it lands at distance 0.
   */
  useEffect(() => {
    if (!tailOn) return;
    const element = scroller.current;
    const inner = content.current;
    if (!element) return;

    const pin = () => {
      element.scrollTop = element.scrollHeight;
    };
    pin();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pin);
    observer.observe(element);
    if (inner) observer.observe(inner);
    return () => observer.disconnect();
  }, [tailOn, pinKey]);

  function handleScroll() {
    if (!tailOn) return;
    const element = scroller.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance > TAIL_RELEASE_PX) onTailBreak();
  }

  const body = (() => {
    if (unavailable) {
      return (
        <span data-testid="stream-unavailable-raw">
          <Mono size={11.5} tone="danger">
            {UNAVAILABLE_COPY}
          </Mono>
        </span>
      );
    }

    if (lines.length === 0) {
      if (logsFallback) return <>{logsFallback}</>;
      return (
        <Mono size={11.5} tone="muted">
          {isRunning ? "Waiting for agent output…" : "No logs available"}
        </Mono>
      );
    }

    return lines.map((line, index) => {
      // Arij's own voice, not the agent's: the write-path cap dropped the
      // middle of this chunk, or data retention dropped the head of this
      // stream. Rendered in the live stratum's mid tone rather than the dim
      // `plain` every other unrecognised line gets — read as muted mono it
      // disappears into the output it is reporting on. Colour here is the
      // band's own stratum, not a state.
      if (isChunkElisionMarker(line.text) || isChunkPruneMarker(line.text)) {
        return (
          <span
            key={line.key}
            data-testid={
              isChunkPruneMarker(line.text)
                ? "chunk-prune-marker"
                : "chunk-elision-marker"
            }
          >
            <Mono size={11.5} tone="live-mid">
              {line.stamp ? `${line.stamp} ` : ""}
              {line.text}
            </Mono>
          </span>
        );
      }

      const { kind, body: text } = classifyLogLine(line.text);
      // The trailing row of a running session IS the running line, whatever
      // its glyph would otherwise have been. That is the frame's last row.
      const effective: LogLineKind =
        isRunning && index === lines.length - 1 ? "live" : kind;
      const delta = splitInlineDelta(text);

      if (effective === "plain") {
        return (
          <Mono key={line.key} size={11.5} tone="muted">
            {line.stamp ? `${line.stamp} ` : ""}
            {delta.text}
            <InlineDelta added={delta.added} removed={delta.removed} />
          </Mono>
        );
      }

      return (
        <TimelineLine
          key={line.key}
          kind={effective}
          size={11.5}
          timestamp={line.stamp ?? undefined}
        >
          {delta.text}
          <InlineDelta added={delta.added} removed={delta.removed} />
        </TimelineLine>
      );
    });
  })();

  return (
    <div
      data-testid="stream-raw"
      className="flex min-h-0 flex-1 flex-col"
    >
      <SurfaceCard
        radius={10}
        className="flex min-h-0 flex-1 flex-col gap-[8px] px-[16px] py-[13px]"
      >
        {hasMore && (
          <PillButton
            variant="outline"
            outlineTone="neutral"
            size="sm"
            onClick={loadMore}
            disabled={loading}
            className="self-start"
            data-testid="stream-load-more-raw"
          >
            {loading ? "Loading..." : "Load more output"}
          </PillButton>
        )}
        {truncatedCount > 0 && (
          <span data-testid="stream-truncated-raw">
            <Mono size={10.5} tone="live-mid">
              {truncatedCount === 1
                ? "One oversized chunk is shown in part."
                : `${truncatedCount} oversized chunks are shown in part.`}
              {hasMore ? " Load more to continue reading it." : ""}
            </Mono>
          </span>
        )}
        {error && (
          <Mono size={10.5} tone="danger">
            {error}
          </Mono>
        )}
        {/*
          Bottom-anchored WITHOUT `justify-content: flex-end` on the scroller
          itself: a column flex container that is both `justify-end` and
          `overflow-y:auto` makes its overflowing top unreachable in Chrome.
          A `min-h-full` inner column with `justify-end` pins short output to
          the bottom and scrolls normally once it is long.
        */}
        <div
          ref={scroller}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          <div
            ref={content}
            className="flex min-h-full flex-col justify-end gap-[6px] break-words"
          >
            {body}
          </div>
        </div>
      </SurfaceCard>
    </div>
  );
}
