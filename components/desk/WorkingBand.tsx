"use client";

import { BandHeader, StrataBand } from "@/components/piscine";
import type {
  DeskProject,
  DeskQueuedSession,
  DeskToday,
  DeskWorkingSession,
} from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

import { LiveSessionCard } from "./LiveSessionCard";
import { WaveRunChips } from "./WaveRunChips";
import { QueuedTile } from "./QueuedTile";
import { TodayTile } from "./TodayTile";

/**
 * WORKING — the turquoise stratum, and the ONLY band on the desk that grows.
 *
 * Everything else is `flex: 0 0 auto` and sizes to its content, which is what
 * makes "an empty stratum collapses to its label line" literally true.
 *
 * UNDRAWN STATES, defined here:
 * - 0 live sessions → the grid has no session rows, so it shrinks to the two
 *   tiles and the band folds to roughly a header plus one tile row. The tiles
 *   stay: "queued: 0" and the day's roll-up are still the answer to "what is
 *   happening", and dropping them would leave a coloured empty rectangle.
 * - >4 live sessions → the grid adds rows and the band scrolls
 *   (`overflow-y:auto` + `min-h-0`), with QUEUED and TODAY pinned as the last
 *   two cells so they never scroll out of reach.
 *
 * THE NIGHT-RUN HEADER LINE IS ABSENT ON "/" ON PURPOSE. It needs a wave
 * concept: night runs are per-project and live in an in-process registry (lost
 * on restart), and no durable row aggregates them ACROSS projects. The
 * documented fallback is to omit the right slot rather than fabricate one, and
 * the cross-project desk still does exactly that.
 *
 * A PROJECT desk is the case that decision could not cover: there, one
 * `projectId` names one registry, and `WaveRunChips` fills the right slot with
 * the wave counter, the night-run marker and "Stop night run" — the three
 * things that had no home but the pre-redesign `AgentMonitor` bar.
 */
export interface WorkingBandProps {
  working: readonly DeskWorkingSession[];
  queued: readonly DeskQueuedSession[];
  today: DeskToday;
  projectsById: ReadonlyMap<string, DeskProject>;
  onOpenTicket?: (epicId: string) => void;
  onStopSession?: (sessionId: string) => void;
  /** Set on a project desk; omit on "/" — see the note above. */
  projectId?: string;
  className?: string;
}

export function WorkingBand({
  working,
  queued,
  today,
  projectsById,
  onOpenTicket,
  onStopSession,
  projectId,
  className,
}: WorkingBandProps) {
  const meta = `${working.length} agent${working.length === 1 ? "" : "s"} · ${queued.length} queued`;
  // The two tiles are always the last two cells.
  const cellCount = working.length + 2;
  const rowCount = Math.max(2, Math.ceil(cellCount / 3));

  return (
    <StrataBand
      stratum="live"
      density="full"
      gap={12}
      grow
      className={cn("mx-[14px] mt-0", className)}
    >
      <BandHeader
        label="Working"
        stratum="live"
        labelSize={13}
        meta={meta}
        right={
          projectId ? (
            <WaveRunChips projectId={projectId} />
          ) : undefined
        }
      />

      <div
        data-testid="desk-working-grid"
        // 3 columns × 2 rows is the frame. Past six cells the grid grows rows
        // of at least 150px and the band scrolls, so a busy morning never
        // squeezes four cards into an unreadable strip.
        style={{
          gridTemplateRows:
            cellCount <= 6 ? "1fr 1fr" : `repeat(${rowCount}, minmax(150px, 1fr))`,
        }}
        className={cn(
          "grid min-h-0 flex-1 grid-cols-3 gap-[11px] overflow-y-auto",
        )}
      >
        {working.map((session) => (
          <LiveSessionCard
            key={session.sessionId}
            session={session}
            project={projectsById.get(session.projectId)}
            onOpenTicket={onOpenTicket}
            onStop={onStopSession}
          />
        ))}
        <QueuedTile
          queued={queued}
          projectsById={projectsById}
          onOpenTicket={onOpenTicket}
        />
        <TodayTile today={today} />
      </div>
    </StrataBand>
  );
}
