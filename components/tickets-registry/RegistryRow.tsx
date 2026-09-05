"use client";

import { Check, Link2 } from "lucide-react";

import {
  BreathingDot,
  Chrono,
  IdentityChip,
  Mono,
  Stamp,
  projectTone,
} from "@/components/piscine";
import { shortId } from "@/components/ticket/derive";
import type { DeskProject } from "@/lib/control-desk/types";
import { TASK_LABEL } from "@/lib/tickets-registry/aggregate";
import type { RegistryRow as Row } from "@/lib/tickets-registry/types";
import { PRIORITY_LABELS } from "@/lib/types/kanban";
import { cn } from "@/lib/utils";

/**
 * One line of the registry — one STACK of two lines below `lg`.
 *
 * TWO SHAPES, ONE DOM. The seven-column table is the desktop shape; on a phone
 * the same cells re-flow into the identity chip and the title on one line and
 * the five trailing cells on a wrapping line beneath it. Nothing is hidden and
 * nothing is conditionally rendered — see `REGISTRY_GRID` and the `lg:contents`
 * cluster below for the two halves of the mechanism.
 *
 * THE ROW IS THE BUTTON. One interactive element, no nesting — which is why
 * the ticket chip is rendered WITHOUT an `onClick`: `IdentityChip` becomes a
 * `<button>` the moment one is passed, and a nested button is invalid HTML that
 * breaks click delegation.
 *
 * Colour on this row is stratum or project identity, never state. The chip is
 * the project's; the ÉTAT cell carries state as an icon plus a word plus (for
 * a live session) motion. The one adjudicated exception is PRIORITÉ, which the
 * frame and the handoff both specify in sun-deep / coral-deep — a magnitude,
 * not a state.
 */

/** Explicit map — Tailwind cannot see an interpolated class name. */
const PRIORITY_CLASS: Record<number, string> = {
  0: "text-muted-foreground",
  1: "text-muted-foreground",
  2: "font-semibold text-strata-land-deep",
  3: "font-semibold text-strata-you-deep",
};

/**
 * The row's track template, shared with the column header so the two can never
 * disagree.
 *
 * TWO SHAPES, ONE GRID. Below `lg` the row is a stack: the identity chip and
 * the title on the first line, everything else on a wrapping second line (the
 * `lg:contents` cluster in the row below). The seven-column table — 738px of
 * FIXED track before its gaps — only appears once the width exists to draw it,
 * because on a 390px screen those fixed tracks left the `1fr` title at zero and
 * pushed the tail of the row out of the card.
 *
 * `minmax(0,1fr)` rather than `1fr` for the title at BOTH shapes: a bare `1fr`
 * takes `auto` as its automatic minimum, so a long title widens the track past
 * the card instead of yielding to the ellipsis.
 */
export const REGISTRY_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-[3px] " +
  "lg:grid-cols-[112px_minmax(0,1fr)_130px_96px_120px_170px_110px] lg:gap-y-0";

export interface RegistryRowProps {
  row: Row;
  project: DeskProject | undefined;
  /** Even index within its group — the frame restarts the zebra per group. */
  striped: boolean;
  onOpen: () => void;
}

function StateCell({ row }: { row: Row }) {
  if (row.group === "active") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-strata-live-deep">
        <BreathingDot size={6} tone="live" />
        {`${row.taskType ? TASK_LABEL[row.taskType] : "Build"} · `}
        {row.startedAt ? (
          // Through `Chrono` even though the frame draws the sans stack: a
          // per-second ticker without tabular figures jitters, which is the
          // primitive's entire reason for existing. `font-normal` beats its
          // hard-coded `font-bold` through twMerge — Space Mono ships 400/700
          // only, so a synthesised weight is never an option.
          <Chrono
            startedAt={row.startedAt}
            size={12}
            tone="live"
            className="font-normal"
          />
        ) : null}
      </span>
    );
  }

  if (row.group === "your_turn") {
    // The frame paints ASKS YOU / CONFLICT #8f2f12; the frozen `Stamp` reserves
    // that pair for FAILED and gives the other two --strata-you-deep. The
    // primitive resolved that across 5a/6a and the token comments; both pairs
    // pass AA. Ship the primitive — 10px included.
    if (row.yourTurnKind === "failed") {
      return (
        <Stamp tone="failed" className="justify-self-start">
          FAILED
        </Stamp>
      );
    }
    if (row.yourTurnKind === "conflict") {
      return (
        <Stamp tone="conflict" className="justify-self-start">
          CONFLICT
        </Stamp>
      );
    }
    return (
      <Stamp tone="asks" className="justify-self-start">
        ASKS YOU
      </Stamp>
    );
  }

  if (row.group === "waiting") {
    if (row.blockedBy.length > 0) {
      const extra = row.blockedBy.length - 1;
      return (
        <span className="flex min-w-0 items-center gap-[5px] text-[12px] text-muted-foreground">
          <Link2 size={11} aria-hidden className="shrink-0" />
          <span className="line-clamp-1">
            {`waits on ${row.blockedBy[0]}${extra > 0 ? ` +${extra}` : ""}`}
          </span>
        </span>
      );
    }
    if (row.isDraft) {
      return (
        <Mono
          size={9.5}
          weight={700}
          uppercase
          className="justify-self-start rounded-full border-[1.5px] border-dashed border-border-strong px-[7px] py-[1px] text-muted-foreground"
        >
          Draft
        </Mono>
      );
    }
    if (row.isQueued) {
      // The app's own existing word (components/desk/QueuedTile.tsx), not
      // invented copy.
      return (
        <Stamp tone="next" className="justify-self-start">
          QUEUED
        </Stamp>
      );
    }
    if (row.queueRank !== null) {
      return (
        <span className="min-w-0 text-[12px] text-muted-foreground">
          {`${row.queueLabel ?? ""} · #${row.queueRank}`}
        </span>
      );
    }
    return (
      <span className="min-w-0 text-[12px] text-muted-foreground">
        {row.queueLabel ?? ""}
      </span>
    );
  }

  if (row.group === "done") {
    if (row.status === "to_merge" && row.mergeReady) {
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-strata-live-deep">
          <Check size={12} aria-hidden className="shrink-0" />
          Ready to land
        </span>
      );
    }
    if (row.status === "done") {
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          <Check size={12} aria-hidden className="shrink-0" />
          Merged
        </span>
      );
    }
    // to_merge but held back. The two conflict blockers were already routed to
    // YOUR TURN, so what reaches here is `changes_requested` or `no_branch`.
    return (
      <span className="line-clamp-1 min-w-0 text-[12px] text-muted-foreground">
        {row.mergeBlockerLine ?? ""}
      </span>
    );
  }

  // released
  if (row.releaseVersion) {
    return (
      <Stamp tone="land" className="justify-self-start">
        {row.releaseVersion}
      </Stamp>
    );
  }
  // No version recorded — the word, never a fabricated number.
  return <span className="min-w-0 text-[12px] text-muted-foreground">released</span>;
}

export function RegistryRow({ row, project, striped, onOpen }: RegistryRowProps) {
  const blocked = row.blockedBy.length > 0;
  const priorityLabel =
    row.priority === null ? null : (PRIORITY_LABELS[row.priority] ?? null);

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="tickets-row"
      data-group={row.group}
      data-epic-id={row.epicId}
      title={blocked ? `waits on ${row.blockedBy.join(", ")}` : undefined}
      className={cn(
        REGISTRY_GRID,
        // Taller on a phone: two stacked lines plus this padding clear the 44px
        // touch target, and the desktop density comes back with the table.
        "w-full px-[18px] py-[10px] text-left outline-none lg:py-[8px]",
        // outline-solid from B-arij-JJ5FdaHpX7d6: outline-none sets the STYLE
        // to none, so outline-2 alone paints nothing and the row would have no
        // keyboard affordance at all.
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        "hover:bg-muted/40",
        striped && "bg-background",
        row.group === "released" && "text-muted-foreground",
        blocked && "opacity-60",
      )}
    >
      <IdentityChip
        label={row.readableId ?? shortId(row.epicId)}
        tone={projectTone(project?.colorIndex ?? 0)}
        size="sm"
        className={cn("justify-self-start", row.group === "released" && "opacity-70")}
      />

      <span
        data-testid="tickets-row-title"
        className={cn(
          // Two lines on a phone, one in the table. The title is the cell the
          // registry exists for; a single clamped line at 390px reads as a
          // fragment, and the second line costs nothing the stack has not
          // already spent.
          "line-clamp-2 min-w-0 text-[13px] lg:line-clamp-1",
          row.group === "released" ? "font-normal" : "font-medium",
        )}
      >
        {row.title}
      </span>

      {/*
        The five trailing cells.

        `lg:contents` is the whole responsive trick: from `lg` up this wrapper
        stops generating a box, so its children become grid items of the row
        itself and land in columns 3-7 exactly as they did before. Below `lg`
        it is an ordinary wrapping flex line under the title — the columns are
        RE-LAID-OUT, never hidden, so every figure stays readable on a phone.
      */}
      <div
        data-testid="tickets-row-meta"
        className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-[2px] lg:contents"
      >
        <StateCell row={row} />

        <Mono size={11} tone="muted" className="min-w-0">
          {row.usCount > 0 ? `${row.usDone}/${row.usCount}` : "—"}
        </Mono>

        {priorityLabel === null ? (
          <Mono size={11} tone="muted" className="min-w-0">
            —
          </Mono>
        ) : (
          <span
            className={cn(
              "min-w-0 text-[11.5px]",
              PRIORITY_CLASS[row.priority as number] ?? "text-muted-foreground",
            )}
          >
            {priorityLabel}
          </span>
        )}

        <Mono size={10.5} tone={row.activityTone} clamp={1} className="min-w-0">
          {row.activity ?? "—"}
        </Mono>

        {/* `justify-self` is a no-op on a flex item, so the right alignment is
            the table's and only the table's. */}
        <Mono
          size={11}
          tone={row.costUsd === null ? "muted" : "ink"}
          className="min-w-0 lg:justify-self-end lg:text-right"
        >
          {row.costUsd === null ? "—" : `$${row.costUsd.toFixed(2)}`}
        </Mono>
      </div>
    </button>
  );
}
