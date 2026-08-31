"use client";

import { FieldKicker, Mono, SurfaceCard } from "@/components/piscine";
import type { DeskToday } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * Cell 6 of the WORKING grid: the day's roll-up.
 *
 * EVERY FIGURE HERE CAN BE ABSENT, and an absent figure is an em-dash, never a
 * zero. `landed` counts `ticket_activity_log` transitions into done/released
 * since 00:00 UTC — deliberately not /api/dashboard/summary's `yesterday`,
 * which is a rolling 24h count of SESSIONS and would answer a different
 * question with a plausible-looking number.
 *
 * The failed numeral is one of the two loud colours the screen allows (coral
 * deep = blocking). That is the exception the invariant names, not a state
 * colour: it is a NUMBER of failures, and the word beside it carries the state.
 */
export interface TodayTileProps {
  today: DeskToday;
  className?: string;
}

function figure(value: number | null): string {
  return value === null ? "—" : String(value);
}

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

export function TodayTile({ today, className }: TodayTileProps) {
  // French agrees in the singular too — "1 projets" is the kind of detail the
  // frame's own copy gets right.
  const plural = (value: number | null, word: string): string =>
    `${figure(value)} ${word}${value !== null && Math.abs(value) < 2 ? "" : "s"}`;
  const footer = [
    money(today.costUsd),
    plural(today.projects, "projet"),
    plural(today.sessions, "session"),
  ].join(" · ");

  return (
    <SurfaceCard
      translucent
      radius={12}
      data-testid="desk-today-tile"
      className={cn(
        "flex min-h-0 flex-col justify-center gap-[6px] px-[14px] py-[12px]",
        className,
      )}
    >
      <FieldKicker stratum="live" size={10.5}>
        TODAY
      </FieldKicker>

      <div className="flex items-baseline gap-3">
        <span data-testid="desk-today-landed">
          <Mono size={22} weight={700} tone="ink">
            {figure(today.ticketsShipped)}
          </Mono>
        </span>
        <span className="font-sans text-[12.5px] font-medium text-strata-live-mid">
          landed
        </span>
        <span data-testid="desk-today-failed">
          <Mono size={22} weight={700} tone="you-deep">
            {figure(today.failedSessions)}
          </Mono>
        </span>
        <span className="font-sans text-[12.5px] font-medium text-strata-live-mid">
          failed
        </span>
      </div>

      <Mono size={11} tone="live-mid" clamp={1}>
        {footer}
      </Mono>
    </SurfaceCard>
  );
}
