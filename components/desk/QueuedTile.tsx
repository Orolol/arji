"use client";

import {
  FieldKicker,
  IdentityChip,
  SurfaceCard,
  projectTone,
} from "@/components/piscine";
import type { DeskProject, DeskQueuedSession } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * Cell 5 of the WORKING grid: what the scheduler is holding for a slot.
 *
 * A translucent tile rather than a white card — the design's way of saying
 * "present but not alive" without spending a colour on it.
 */
export interface QueuedTileProps {
  queued: readonly DeskQueuedSession[];
  projectsById: ReadonlyMap<string, DeskProject>;
  onOpenTicket?: (epicId: string) => void;
  className?: string;
}

/** How many queued rows the tile lists before it summarises the rest. */
const VISIBLE_ROWS = 3;

export function QueuedTile({
  queued,
  projectsById,
  onOpenTicket,
  className,
}: QueuedTileProps) {
  const visible = queued.slice(0, VISIBLE_ROWS);
  const overflow = queued.length - visible.length;

  return (
    <SurfaceCard
      translucent
      radius={12}
      data-testid="desk-queued-tile"
      className={cn(
        "flex min-h-0 flex-col justify-center gap-[7px] px-[14px] py-[12px]",
        className,
      )}
    >
      <FieldKicker stratum="live" size={10.5}>
        {`QUEUED · ${queued.length}`}
      </FieldKicker>

      {visible.map((session) => {
        const project = projectsById.get(session.projectId);
        return (
          <button
            key={session.sessionId}
            type="button"
            disabled={!session.epicId || !onOpenTicket}
            onClick={() => session.epicId && onOpenTicket?.(session.epicId)}
            className={cn(
              "flex min-w-0 items-center gap-2 border-0 bg-transparent p-0 text-left",
              "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              "disabled:cursor-default",
            )}
          >
            <IdentityChip
              label={session.readableId ?? project?.shortName ?? "—"}
              tone={projectTone(project?.colorIndex ?? 0)}
              size="sm"
            />
            <span className="line-clamp-1 min-w-0 font-sans text-[13px] font-medium text-foreground">
              {session.title}
            </span>
          </button>
        );
      })}

      {overflow > 0 ? (
        <FieldKicker stratum="live" size={10}>
          {`+${overflow}`}
        </FieldKicker>
      ) : null}
    </SurfaceCard>
  );
}
