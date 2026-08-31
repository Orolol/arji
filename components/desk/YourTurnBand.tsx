"use client";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";
import type { DeskDismissalKind } from "@/lib/control-desk/aggregate";
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
 * OVERFLOW: the band caps at 30vh and the row list scrolls. Past VISIBLE_ROWS
 * a mono "+N de plus" line under the list says so, because an overflow marker
 * inside a scroll container is only visible once you have already scrolled.
 *
 * SIZING: the list is `justify-start`, NOT `justify-around`. With space-around
 * one or two rows spread across the whole 40vh, which is why an almost-empty
 * coral stratum still crushed READY TO LAND and UP NEXT underneath it.
 */

/** Rows the band shows before it admits to hiding some. */
const VISIBLE_ROWS = 3;
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
  /**
   * Wave a handled signal off the stratum. Takes the signal's own timestamp,
   * not the moment of the click: the server hides the row only until a NEWER
   * signal of the same kind lands on the epic.
   */
  onDismiss?: (
    kind: DeskDismissalKind,
    item: { epicId: string; signalAt: string | null },
  ) => void | Promise<void>;
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
  onDismiss,
  className,
}: YourTurnBandProps) {
  const count = awaitingReply.length + failed.length + conflicts.length;

  return (
    <StrataBand
      stratum="you"
      density="full"
      gap={11}
      // The band caps and its row list scrolls: a backlog of questions must
      // never push WORKING — the only band that grows — off the screen.
      className={cn("mx-[14px] mt-[10px] max-h-[30vh]", className)}
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
          className="flex min-h-0 flex-col justify-start gap-2 overflow-y-auto"
        >
          {awaitingReply.map((item) => (
            <AsksYouRow
              key={`asks-${item.epicId}`}
              item={item}
              project={projectsById.get(item.projectId)}
              onReply={onReply}
              onSendToDev={onSendToDev}
              onDismiss={
                onDismiss
                  ? (row) => onDismiss("asks", { epicId: row.epicId, signalAt: row.askedAt })
                  : undefined
              }
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
              onDismiss={
                onDismiss
                  ? (row) => onDismiss("failed", { epicId: row.epicId, signalAt: row.failedAt })
                  : undefined
              }
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
              onDismiss={
                onDismiss
                  ? (row) => onDismiss("conflict", { epicId: row.epicId, signalAt: row.at })
                  : undefined
              }
              pending={pendingIds?.has(item.epicId)}
            />
          ))}
        </div>
      ) : null}

      {count > VISIBLE_ROWS ? (
        // Mono takes no DOM props of its own (closed prop type, no rest
        // spread), so the test hook lives on the wrapper.
        <div data-testid="desk-your-turn-overflow" className="shrink-0">
          <Mono size={11} tone="you-mid">
            {`+${count - VISIBLE_ROWS} de plus`}
          </Mono>
        </div>
      ) : null}
    </StrataBand>
  );
}
