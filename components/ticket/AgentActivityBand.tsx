"use client";

/**
 * WHAT THE AGENT IS DOING on the turquoise ground (frame 6a, lines 248-259).
 *
 * The only growing band in the modal: it absorbs whatever height the other
 * three left-column blocks leave, and its timeline scrolls inside it.
 *
 * TWO SOURCES, ONE CHRONOLOGY. The lines come from the latest session's
 * recorded board effects AND from the ticket's transition log — status moves
 * and autonomous-pipeline narration, which no other band shows. They arrive
 * already interleaved (`hooks/useTicketOverlayData.ts`); this band only draws
 * them.
 *
 * A `group` line is a collapsed burst of automatic transitions. It expands in
 * place behind a QuietLink rather than being dropped: the burst is exactly
 * what buries a pipeline run's real lines when it is left uncollapsed, and
 * exactly what the user came looking for when it is hidden.
 *
 * LIVENESS IS NOT DECORATION. The `ProgressTrack` — an indeterminate crawl —
 * is rendered ONLY while a session is actually running. A crawl bar with
 * nothing crawling is a lie about liveness and breaks the design's first
 * rule (state is icon + word + motion, and motion means alive).
 *
 * NON-LIVE: the band keeps its label line and the recorded history, with no
 * chrono, no Stop and no track. With nothing recorded at all it is the bare
 * label line — `grow` is dropped too, so an idle ticket's band does not
 * stretch to fill the modal.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";

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
  const t = useTranslations("Ticket");
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
        label={t("activity.label")}
        stratum="live"
        className="gap-[10px]"
        meta={meta ?? undefined}
        right={
          sessionHref ? (
            <QuietLink tone="live" href={sessionHref}>
              {t("activity.openSession")}
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
            <ActivityLine key={line.key} line={line} />
          ))}
        </div>
      ) : null}

      {isRunning ? (
        <ProgressTrack height={4} className="mt-[2px] shrink-0" />
      ) : null}
    </StrataBand>
  );
}

function ActivityLine({ line }: { line: TimelineEntry }) {
  const t = useTranslations("Ticket");
  const [expanded, setExpanded] = useState(false);

  if (!line.group || line.group.length === 0) {
    return (
      <TimelineLine kind={line.kind} size={11}>
        {line.text}
      </TimelineLine>
    );
  }

  return (
    <div className="flex flex-col gap-[6px]" data-testid="ticket-activity-group">
      <span className="flex flex-wrap items-baseline gap-2">
        <TimelineLine kind={line.kind} size={11}>
          {line.text}
        </TimelineLine>
        <QuietLink
          tone="live"
          size={11.5}
          onClick={() => setExpanded((value) => !value)}
          testId="ticket-activity-group-toggle"
        >
          {expanded ? t("activity.collapseGroup") : t("activity.expandGroup")}
        </QuietLink>
      </span>
      {expanded
        ? line.group.map((text, index) => (
            <TimelineLine
              key={`${line.key}-${index}`}
              kind="done"
              size={11}
              className="pl-4"
            >
              {text}
            </TimelineLine>
          ))
        : null}
    </div>
  );
}
