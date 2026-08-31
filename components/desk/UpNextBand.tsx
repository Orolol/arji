"use client";

import * as React from "react";

import {
  BandHeader,
  Mono,
  StrataBand,
  type ProjectTone,
  projectTone,
} from "@/components/piscine";
import type {
  DeskProject,
  DeskQueueTicket,
  DeskUpNextProject,
} from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * UP NEXT — the pool-blue stratum: the order Full Auto will pick from.
 *
 * The header's meta is a HINT, not a counter ("l'ordre où Full Auto va
 * piocher"), and the band has no count at all. That is deliberate in the frame
 * and it is also honest here: the ranks come from `compareExecutionOrder` in
 * lib/kanban/queue.ts, which IS `compareEpics` in lib/auto-mode/select.ts —
 * one function, so the column shows the supervisor's own order rather than a
 * lookalike. Dependency-blocked and awaiting-reply tickets are skipped by both
 * sides too.
 *
 * The one thing this column still cannot see: the in-process registry's parked
 * tickets and pipeline/night-run claims. They are not in the database and no
 * API exposes them, so a parked ticket keeps its rank here.
 *
 * NO DRAG-AND-DROP. Order is execution order; re-prioritising happens in the
 * ticket overlay or in Refinement, which rewrite `epics.position` deliberately.
 */
export interface UpNextBandProps {
  upNext: readonly DeskUpNextProject[];
  projectsById: ReadonlyMap<string, DeskProject>;
  /** The event rides along so ⌘/Ctrl-click can select instead of open. */
  onOpenTicket?: (epicId: string, event: React.MouseEvent) => void;
  selectedEpicIds?: ReadonlySet<string>;
  className?: string;
}

/** Chips per row. The frame drew three; the fourth is the height YOUR TURN
 *  gave back when it stopped spreading its rows over 40vh. Short rows pad. */
const SLOTS = 4;

const PROJECT_LABEL_CLASS: Record<ProjectTone, string> = {
  1: "text-project-1-deep",
  2: "text-project-2-deep",
  3: "text-project-3-deep",
  4: "text-project-4-deep",
};

/**
 * The three chip ranks share identical box geometry, so the columns line up
 * whatever a row contains:
 *   rank 1 — card fill, weight 500, ink       (the next one)
 *   rank 2 — translucent fill, weight 400     (after that)
 *   rank 3 / blocked / spec — no fill at all, but the same padding and radius,
 *   so it still occupies a full chip slot.
 */
export type QueueChipRank = 1 | 2 | 3;

export function chipRank(ticket: DeskQueueTicket): QueueChipRank {
  if (ticket.rank === 1) return 1;
  if (ticket.rank === 2) return 2;
  return 3;
}

export function chipLabel(ticket: DeskQueueTicket): string {
  const id = ticket.readableId ?? "";
  if (ticket.blockedBy.length > 0) {
    return `${id} bloqué`.trim();
  }
  if (ticket.awaitingReply) {
    return `${id} en attente`.trim();
  }
  const base = `${id} ${ticket.title}`.trim();
  return ticket.specOnly ? `${base} · spec` : base;
}

/**
 * ONE LINE, and `truncate` is what delivers it — not `line-clamp-1`.
 *
 * The chip is a fixed 31px pill, so a label that wraps has nowhere to go. With
 * `line-clamp-1` Chrome put the ellipsis on line one and then PAINTED the
 * second line below the pill, sliced in half against the band. Measured on the
 * scratch stack at 1440x950: `scrollHeight` 50 against a `clientHeight` of 31.
 *
 * It predates the fourth slot — reproduced with `SLOTS = 3` on the same tree —
 * but four narrower chips wrap far more labels, so it went from one chip in a
 * row to all of them. `truncate` (`white-space: nowrap`) is the honest
 * expression of a single-line pill anyway, and it fits MORE of the title,
 * since the whole width is one line. The sibling `line-clamp-1` call sites are
 * unaffected: READY TO LAND's row was checked with a 140-character title and
 * clamps correctly, because its row is not height-capped.
 */
const CHIP_BASE = "min-w-0 flex-1 truncate rounded-full px-[11px] py-[6px] text-[12.5px] text-left";

const CHIP_RANK: Record<QueueChipRank, string> = {
  1: "bg-card font-medium text-foreground",
  2: "bg-card-translucent font-normal text-strata-next-alt",
  3: "font-normal text-strata-next-mid",
};

export function UpNextBand({
  upNext,
  projectsById,
  onOpenTicket,
  selectedEpicIds,
  className,
}: UpNextBandProps) {
  const rows = upNext.filter((row) => row.tickets.length > 0);

  return (
    <StrataBand
      stratum="next"
      density="half"
      gap={9}
      className={cn("min-w-0", className)}
    >
      <BandHeader
        label="Up next"
        stratum="next"
        labelSize={13}
        right={
          rows.length > 0 ? (
            <Mono size={11} tone="next-mid">
              l&apos;ordre où Full Auto va piocher
            </Mono>
          ) : undefined
        }
      />

      {rows.map((row) => {
        const project = projectsById.get(row.projectId);
        const tone = projectTone(project?.colorIndex ?? 0);
        // Past three tickets the LAST slot becomes the "+N" chip, so the row
        // still occupies exactly three columns.
        const overflowing = row.tickets.length > SLOTS;
        const visible = row.tickets.slice(0, overflowing ? SLOTS - 1 : SLOTS);
        const overflow = row.tickets.length - visible.length;
        // Short rows pad with empty spacers so every row's chips share the same
        // three columns; the spacer takes the width of the slots it replaces.
        const spacerFlex = SLOTS - visible.length - (overflowing ? 1 : 0);

        return (
          <div
            key={row.projectId}
            data-testid="desk-up-next-row"
            className="flex items-center gap-[9px]"
          >
            {/*
              Mono, not a hand-rolled `font-mono` run: the primitive is what
              guarantees Space Mono (the canvas helper resolves to Geist Mono)
              and `tabular-nums` on every mono run in the design. The project
              deep is a colour no `MonoTone` carries, so it arrives the
              documented way — a utility class through `className`, which
              twMerge lets win over the tone class.
            */}
            <Mono
              size={10}
              weight={700}
              className={cn("w-[70px] shrink-0", PROJECT_LABEL_CLASS[tone])}
            >
              {project?.shortName ?? "—"}
            </Mono>

            {visible.map((ticket) => {
              const rank = chipRank(ticket);
              return (
                <button
                  key={ticket.epicId}
                  type="button"
                  data-testid="desk-queue-chip"
                  data-rank={rank}
                  disabled={!onOpenTicket}
                  onClick={(event) => onOpenTicket?.(ticket.epicId, event)}
                  title={
                    ticket.blockedBy.length > 0
                      ? `Bloqué par ${ticket.blockedBy.join(", ")}`
                      : ticket.title
                  }
                  className={cn(
                    CHIP_BASE,
                    CHIP_RANK[rank],
                    "border-0 font-sans outline-none",
                    selectedEpicIds?.has(ticket.epicId) &&
                      "ring-2 ring-foreground",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    "disabled:cursor-default",
                  )}
                >
                  {chipLabel(ticket)}
                </button>
              );
            })}

            {overflowing ? (
              <span
                data-testid="desk-queue-overflow"
                className={cn(CHIP_BASE, CHIP_RANK[3], "font-sans")}
              >
                {`+${overflow}`}
              </span>
            ) : null}

            {spacerFlex > 0 ? (
              <span aria-hidden="true" style={{ flex: spacerFlex }} />
            ) : null}
          </div>
        );
      })}
    </StrataBand>
  );
}
