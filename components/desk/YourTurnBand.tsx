"use client";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";
import type {
  DeskAwaitingReply,
  DeskConflict,
  DeskFailure,
  DeskProject,
} from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

import { AsksYouRow, ConflictRow, FailedRow } from "./AttentionRow";

/**
 * YOUR TURN — the coral stratum: everything that is blocked on a human.
 *
 * Order is urgency: questions first (an agent is idle waiting), then failures
 * (work stopped), then conflicts (work finished but cannot land).
 *
 * EMPTY IS THE POINT. With nothing blocking, this band renders its header and
 * nothing else — no placeholder, no "all clear" card — and folds to one line.
 * That is the design's own promise: "un matin sans blocage, l'abricot se
 * replie en une ligne."
 *
 * OVERFLOW: past three rows the row list scrolls and the band caps at 40vh, so
 * a backlog of questions can never push WORKING off the screen.
 */
export interface YourTurnBandProps {
  awaitingReply: readonly DeskAwaitingReply[];
  failed: readonly DeskFailure[];
  conflicts: readonly DeskConflict[];
  projectsById: ReadonlyMap<string, DeskProject>;
  pendingIds?: ReadonlySet<string>;
  onReply: (item: DeskAwaitingReply, message: string) => void | Promise<void>;
  onSendToDev: (item: DeskAwaitingReply, message: string) => void | Promise<void>;
  onRetry: (item: DeskFailure) => void | Promise<void>;
  onOpenLog: (item: DeskFailure) => void;
  onResolveConflict: (item: DeskConflict) => void | Promise<void>;
  onOpenDiff: (item: DeskConflict) => void;
  className?: string;
}

export function YourTurnBand({
  awaitingReply,
  failed,
  conflicts,
  projectsById,
  pendingIds,
  onReply,
  onSendToDev,
  onRetry,
  onOpenLog,
  onResolveConflict,
  onOpenDiff,
  className,
}: YourTurnBandProps) {
  const count = awaitingReply.length + failed.length + conflicts.length;

  return (
    <StrataBand
      stratum="you"
      density="full"
      gap={11}
      // Past three rows the band caps and its row list scrolls: a backlog of
      // questions must never push WORKING — the only band that grows — off
      // the screen.
      className={cn("mx-[14px] mt-[10px] max-h-[40vh]", className)}
    >
      <BandHeader
        label="Your turn"
        stratum="you"
        labelSize={13}
        meta={count > 0 ? String(count) : undefined}
        right={
          count > 0 ? (
            <Mono size={11} tone="you-mid">
              ↹ parcourir · ⏎ répondre
            </Mono>
          ) : undefined
        }
      />

      {count > 0 ? (
        <div
          data-testid="desk-your-turn-rows"
          className="flex min-h-0 flex-1 flex-col justify-around gap-2 overflow-y-auto"
        >
          {awaitingReply.map((item) => (
            <AsksYouRow
              key={`asks-${item.epicId}`}
              item={item}
              project={projectsById.get(item.projectId)}
              onReply={onReply}
              onSendToDev={onSendToDev}
              pending={pendingIds?.has(item.epicId)}
            />
          ))}
          {failed.map((item) => (
            <FailedRow
              key={`failed-${item.epicId}`}
              item={item}
              project={projectsById.get(item.projectId)}
              onRetry={onRetry}
              onOpenLog={onOpenLog}
              pending={pendingIds?.has(item.epicId)}
            />
          ))}
          {conflicts.map((item) => (
            <ConflictRow
              key={`conflict-${item.epicId}`}
              item={item}
              project={projectsById.get(item.projectId)}
              onResolve={onResolveConflict}
              onOpenDiff={onOpenDiff}
              pending={pendingIds?.has(item.epicId)}
            />
          ))}
        </div>
      ) : null}
    </StrataBand>
  );
}
