"use client";

import { IdentityChip, Mono, SurfaceCard, projectTone } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaQueuedRun } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

/**
 * The last cell of the QA RUNS grid: review passes the scheduler is holding.
 *
 * A translucent tile rather than a white card — the design's way of saying
 * "present but not alive" without spending a colour on it.
 *
 * It renders NOTHING when there is nothing queued. The desk's own QUEUED tile
 * stays at zero because it shares a row with the TODAY roll-up and dropping it
 * would leave a hole; here it is the only tile, so an empty one would be a
 * fabricated card on a coloured ground. With no live runs either, the whole
 * band folds to its label line — see `QaRunsBand`.
 */
export interface QaQueuedTileProps {
  queued: readonly QaQueuedRun[];
  projectsById: ReadonlyMap<string, DeskProject>;
  onOpenTicket?: (epicId: string) => void;
  className?: string;
}

/** How many queued rows the tile lists before it summarises the rest. */
const VISIBLE_ROWS = 3;

export function QaQueuedTile({
  queued,
  projectsById,
  onOpenTicket,
  className,
}: QaQueuedTileProps) {
  if (queued.length === 0) return null;

  const visible = queued.slice(0, VISIBLE_ROWS);
  const overflow = queued.length - visible.length;

  return (
    <SurfaceCard
      translucent
      radius={12}
      data-testid="qa-queued-tile"
      className={cn(
        "flex flex-col justify-center gap-[6px] px-[14px] py-[12px]",
        className,
      )}
    >
      {/* Space Mono is non-variable: 700 is the only heavier weight there is. */}
      <Mono size={10.5} weight={700} uppercase tracking={0.08} tone="live-mid">
        {`QUEUED · ${queued.length}`}
      </Mono>

      {visible.map((run) => {
        const project = projectsById.get(run.projectId);
        return (
          <button
            key={run.sessionId}
            type="button"
            disabled={!run.epicId || !onOpenTicket}
            onClick={() => run.epicId && onOpenTicket?.(run.epicId)}
            className={cn(
              "flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left",
              "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
              "disabled:cursor-default",
            )}
          >
            <IdentityChip
              label={run.readableId ?? project?.shortName ?? "—"}
              tone={projectTone(project?.colorIndex ?? 0)}
              size="sm"
            />
            <span className="line-clamp-1 min-w-0 font-sans text-[12.5px] text-foreground">
              {run.title}
            </span>
          </button>
        );
      })}

      {overflow > 0 ? (
        <Mono size={10} weight={700} uppercase tracking={0.08} tone="live-mid">
          {`+${overflow}`}
        </Mono>
      ) : null}
    </SurfaceCard>
  );
}
