"use client";

/**
 * WHAT THE AGENT IS DOING on the turquoise ground (frame 6a, lines 248-259).
 *
 * The only growing band in the modal: it absorbs whatever height the other
 * three left-column blocks leave, and its timeline scrolls inside it.
 *
 * LIVENESS IS NOT DECORATION. The `ProgressTrack` — an indeterminate crawl —
 * is rendered ONLY while a session is actually running. A crawl bar with
 * nothing crawling is a lie about liveness and breaks the design's first
 * rule (state is icon + word + motion, and motion means alive).
 *
 * NON-LIVE: the band keeps its label line and the last finished session's
 * recorded actions, with no chrono, no Stop and no track. With no session at
 * all it is the bare label line — `grow` is dropped too, so an idle ticket's
 * band does not stretch to fill the modal.
 */

import {
  BandHeader,
  ProgressTrack,
  QuietLink,
  StrataBand,
  TimelineLine,
} from "@/components/piscine";
import type { TimelineEntry } from "@/hooks/useTicketOverlayData";

export interface AgentActivityBandProps {
  lines: TimelineEntry[];
  isRunning: boolean;
  /** `Opus Builder · session #a41f2c`, or null when the ticket never ran. */
  meta: string | null;
  sessionHref: string | null;
}

export function AgentActivityBand({
  lines,
  isRunning,
  meta,
  sessionHref,
}: AgentActivityBandProps) {
  const hasBody = lines.length > 0;

  return (
    <StrataBand
      stratum="live"
      density="rail"
      gap={8}
      grow={hasBody || isRunning}
      className="pb-[15px]"
    >
      <BandHeader
        label="What the agent is doing"
        stratum="live"
        className="gap-[10px]"
        meta={meta ?? undefined}
        right={
          sessionHref ? (
            <QuietLink tone="live" href={sessionHref}>
              open full session →
            </QuietLink>
          ) : undefined
        }
      />

      {hasBody ? (
        <div
          data-testid="ticket-agent-timeline"
          className="flex min-h-0 flex-1 flex-col gap-[6px] overflow-y-auto"
        >
          {lines.map((line) => (
            <TimelineLine key={line.key} kind={line.kind} size={11}>
              {line.text}
            </TimelineLine>
          ))}
        </div>
      ) : null}

      {isRunning ? (
        <ProgressTrack height={4} className="mt-[2px] shrink-0" />
      ) : null}
    </StrataBand>
  );
}
