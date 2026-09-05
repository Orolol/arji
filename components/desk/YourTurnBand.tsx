"use client";

import * as React from "react";

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
 * OVERFLOW: the band caps at 30vh and the row list scrolls. A mono "+N de plus"
 * line under the list says so, because an overflow marker inside a scroll
 * container is only visible once you have already scrolled.
 *
 * N IS MEASURED, NOT GUESSED. It used to be `count - 3`, on the assumption that
 * three rows fit. What fits is 30vh divided by the row height: at 1440x1300 a
 * fourth row is on screen and "+3 de plus" was simply false. The count now comes
 * from the scroll container — rows whose bottom edge falls past the fold — so it
 * stays true on any viewport, and it decreases as the user scrolls.
 *
 * SIZING: the list is `justify-start`, NOT `justify-around`. With space-around
 * one or two rows spread across the whole 40vh, which is why an almost-empty
 * coral stratum still crushed READY TO LAND and UP NEXT underneath it.
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

  const listRef = React.useRef<HTMLDivElement | null>(null);
  const [hiddenCount, setHiddenCount] = React.useState(0);

  // Re-measure when the ROWS change, not on every render: the desk rebuilds
  // `?? []` fallbacks each poll, so depending on the arrays themselves would
  // re-run this effect every 4 seconds for nothing.
  const rowsKey = [
    awaitingReply.map((row) => row.epicId).join(","),
    failed.map((row) => row.epicId).join(","),
    conflicts.map((row) => row.epicId).join(","),
  ].join("|");

  /**
   * CONVERGENCE BUDGET.
   *
   * The marker lives INSIDE the capped band, so showing it shrinks the very
   * scroll container it describes: one measurement reports a count for a
   * layout that no longer exists, which is how "+4 de plus" appeared over
   * three hidden rows at 1440x950. Re-measuring after each commit settles it
   * in two or three passes.
   *
   * The cap stops a pathological 3↔4 oscillation from spinning. It is spent
   * per BURST, not per mount: passes more than SETTLE_MS apart are a new
   * external cause (a resize, a row rewrapping) rather than our own feedback,
   * so the budget refills. Height alone cannot tell those apart — revealing
   * the marker changes the height too.
   */
  const passRef = React.useRef({ count: 0, at: 0 });
  const MAX_PASSES = 5;
  const SETTLE_MS = 250;

  const measure = React.useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    // Nothing overflows: every row is on screen and there is nothing to
    // admit to. This is also the jsdom path, where layout is all zeroes.
    if (list.scrollHeight <= list.clientHeight) {
      setHiddenCount(0);
      return;
    }
    // The fold, in viewport coordinates. A row counts as hidden when its
    // bottom edge falls past it — the same "fully visible" rule a reader
    // applies. Reading it live means the number also drops as you scroll.
    const fold = list.getBoundingClientRect().bottom;
    let hidden = 0;
    for (const child of Array.from(list.children)) {
      if (child.getBoundingClientRect().bottom > fold + 1) hidden += 1;
    }
    setHiddenCount(hidden);
  }, []);

  // Before paint, so a corrected count never flickers on screen — and on EVERY
  // render, deliberately without a dependency array.
  //
  // Rendering is the one thing guaranteed to follow a content change, so this
  // is the backstop under the settle schedule below: whatever reflows the rows,
  // the next render re-measures. It is cheap (a rect read per row, only while
  // rows are on screen) and it cannot spin — React bails out when the count is
  // unchanged, and SETTLE_MS/MAX_PASSES bound a real oscillation.
  React.useLayoutEffect(() => {
    const now = Date.now();
    const pass = passRef.current;
    if (now - pass.at > SETTLE_MS) pass.count = 0;
    if (pass.count >= MAX_PASSES) return;
    pass.count += 1;
    pass.at = now;
    measure();
  });

  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    // Scrolling does not change layout, so it cannot feed back: measure freely.
    // A row can grow after mount (a long question wraps) and the band is sized
    // in vh, so the viewport is a resize source too — those arrive well after
    // the mount burst and get a fresh budget from the SETTLE_MS rule.
    const onScroll = () => measure();
    list.addEventListener("scroll", onScroll, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(list);
      for (const child of Array.from(list.children)) observer.observe(child);
    }

    // AND on a short settle schedule after the rows change.
    //
    // Traced, not assumed: every trigger above fires by ~280ms reading
    // `scrollHeight` 366, then the rows reflow to 358 before 1200ms and
    // nothing fires for it. The band is height-capped, so the list's own box
    // never moves and the child observations do not deliver either — Chrome
    // drops follow-up notifications when a callback resizes what it observes,
    // which is exactly this component. Without these the marker stayed wrong
    // until the desk's 4s poll happened to re-render it.
    //
    // Two timers, then done: a settle schedule, not a poll.
    const timers = [
      requestAnimationFrame(measure),
      window.setTimeout(measure, 300),
      window.setTimeout(measure, 1200),
    ];

    return () => {
      cancelAnimationFrame(timers[0]);
      window.clearTimeout(timers[1]);
      window.clearTimeout(timers[2]);
      list.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [rowsKey, measure]);

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
          ref={listRef}
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

      {hiddenCount > 0 ? (
        // Mono takes no DOM props of its own (closed prop type, no rest
        // spread), so the test hook lives on the wrapper.
        <div data-testid="desk-your-turn-overflow" className="shrink-0">
          <Mono size={11} tone="you-mid">
            {`+${hiddenCount} de plus`}
          </Mono>
        </div>
      ) : null}
    </StrataBand>
  );
}
