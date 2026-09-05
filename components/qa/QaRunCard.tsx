"use client";

import { StopCircle } from "lucide-react";

import {
  Chrono,
  IdentityChip,
  Mono,
  ProgressTrack,
  SurfaceCard,
  projectTone,
} from "@/components/piscine";
import { runLastLine } from "@/lib/qa/aggregate";
import type { QaRun } from "@/lib/qa/types";
import type { DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * One review pass in flight, in the turquoise QA RUNS grid.
 *
 * The card carries NO state colour: "alive" is the ticking chrono, the crawling
 * 4px track and the word REVIEW — not a green border. The single loud colour it
 * is allowed is the turquoise progress fill.
 *
 * PROGRESS IS INDETERMINATE ON PURPOSE. `session:progress` is declared in
 * `lib/events/bus.ts` and NOTHING emits it, so the bar crawls rather than lying
 * about a percentage.
 */
export interface QaRunCardProps {
  run: QaRun;
  project: DeskProject | undefined;
  onOpenTicket?: (epicId: string) => void;
  onStop?: (sessionId: string) => void;
  className?: string;
}

export function QaRunCard({
  run,
  project,
  onOpenTicket,
  onStop,
  className,
}: QaRunCardProps) {
  const tone = projectTone(project?.colorIndex ?? 0);

  return (
    <SurfaceCard
      radius={12}
      interactive={Boolean(run.epicId && onOpenTicket)}
      data-testid="qa-run-card"
      className={cn(
        "flex min-h-0 flex-col gap-[7px] px-[14px] py-[12px]",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <IdentityChip
          label={run.readableId ?? project?.shortName ?? "—"}
          tone={tone}
          size="sm"
        />
        <Mono size={10} tone="live-mid">
          REVIEW
        </Mono>
        <button
          type="button"
          aria-label="Stop this review"
          data-testid="qa-run-stop"
          onClick={(event) => {
            event.stopPropagation();
            onStop?.(run.sessionId);
          }}
          className={cn(
            "ml-auto flex shrink-0 text-muted-foreground outline-none",
            "hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
        >
          <StopCircle size={14} aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        disabled={!run.epicId || !onOpenTicket}
        onClick={() => run.epicId && onOpenTicket?.(run.epicId)}
        className={cn(
          "line-clamp-2 min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left",
          "font-sans text-[13.5px] leading-[1.35] font-semibold text-foreground",
          "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
          "disabled:cursor-default",
        )}
      >
        {run.title}
      </button>

      <div className="flex items-baseline gap-2">
        {/* A session with neither a start nor a creation stamp has no elapsed
            time to show; an em-dash is the honest glyph, never a zero. */}
        {run.startedAt ? (
          <Chrono startedAt={run.startedAt} size={19} />
        ) : (
          <Mono size={19} weight={700} tone="live-deep">
            —
          </Mono>
        )}
        <Mono size={10.5} tone="muted" clamp={1}>
          {run.agentName ?? "—"}
        </Mono>
      </div>

      <ProgressTrack height={4} />

      <Mono size={11} tone="muted" clamp={1}>
        {runLastLine(run)}
      </Mono>
    </SurfaceCard>
  );
}
