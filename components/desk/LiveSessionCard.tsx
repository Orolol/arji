"use client";

import { Hourglass, Moon, StopCircle } from "lucide-react";

import {
  Chrono,
  IdentityChip,
  Mono,
  ProgressTrack,
  SurfaceCard,
  projectTone,
} from "@/components/piscine";
import type { DeskProject, DeskWorkingSession } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * One running agent, in cells 1-4 of the WORKING grid.
 *
 * The card carries no state colour anywhere: "alive" is the ticking chrono,
 * the crawling 4px track and the breathing rail dot, not a green border. The
 * one loud colour it is allowed is the turquoise progress fill.
 *
 * PROGRESS IS INDETERMINATE ON PURPOSE. Nothing in Arij computes per-session
 * progress — `session:progress` is declared in lib/events/bus.ts and NOTHING
 * emits it — so the bar crawls rather than lying about a percentage.
 */
export interface LiveSessionCardProps {
  session: DeskWorkingSession;
  project: DeskProject | undefined;
  onOpenTicket?: (epicId: string) => void;
  onStop?: (sessionId: string) => void;
  className?: string;
}

export function LiveSessionCard({
  session,
  project,
  onOpenTicket,
  onStop,
  className,
}: LiveSessionCardProps) {
  const tone = projectTone(project?.colorIndex ?? 0);
  const metaParts = [session.readableId, session.agentName].filter(Boolean);

  return (
    <SurfaceCard
      radius={12}
      interactive={Boolean(session.epicId && onOpenTicket)}
      className={cn(
        "flex min-h-0 flex-col justify-between gap-[7px] px-[14px] py-[12px]",
        className,
      )}
      data-testid="desk-live-session"
    >
      <div className="flex items-center gap-2">
        <IdentityChip label={project?.shortName ?? "—"} tone={tone} size="sm" />
        <Mono size={10} tone="live-mid">
          {session.taskType}
        </Mono>
        {session.nightRun ? (
          // The frame reads "NIGHT 2/3". Wave numbers live only in the
          // in-process night-run registry (per project, lost on restart) and no
          // durable row carries them, so the tag names the run without
          // inventing a wave.
          <span
            data-testid="desk-night-tag"
            className="flex shrink-0 items-center gap-1 text-strata-live-mid"
          >
            <Moon size={11} aria-hidden="true" />
            <Mono size={10} tone="live-mid">
              NIGHT
            </Mono>
          </span>
        ) : null}
        {session.stale ? (
          // Colour is stratum, never state — so the stall is an icon plus the
          // word, in this band's own turquoise mid, exactly like NIGHT above
          // it. Painting it coral would have imported the YOUR TURN deep into
          // the WORKING band to mean "bad", which is the thing the card's
          // header comment says it never does.
          <span
            data-testid="desk-stalled-tag"
            className="flex shrink-0 items-center gap-1 text-strata-live-mid"
          >
            <Hourglass size={11} aria-hidden="true" />
            <Mono size={10} tone="live-mid">
              STALLED
            </Mono>
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Stop this session"
          data-testid="desk-stop-session"
          onClick={(event) => {
            event.stopPropagation();
            onStop?.(session.sessionId);
          }}
          className={cn(
            "ml-auto flex shrink-0 text-muted-foreground outline-none",
            "hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
        >
          <StopCircle size={14} aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        disabled={!session.epicId || !onOpenTicket}
        onClick={() => session.epicId && onOpenTicket?.(session.epicId)}
        className={cn(
          "line-clamp-2 min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left",
          "font-sans text-[14.5px] leading-[1.35] font-semibold text-foreground",
          "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "disabled:cursor-default",
        )}
      >
        {session.title}
      </button>

      <div className="flex items-baseline gap-[9px]">
        <Chrono startedAt={session.startedAt} size={21} />
        <Mono size={11} tone="muted" clamp={1}>
          {metaParts.length > 0 ? metaParts.join(" · ") : "—"}
        </Mono>
      </div>

      <ProgressTrack height={4} />

      <Mono size={11} tone="muted" clamp={1}>
        {session.lastLogLine ? `› ${session.lastLogLine}` : "› …"}
      </Mono>
    </SurfaceCard>
  );
}
