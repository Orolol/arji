import type { ReactNode } from "react";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";
import { cn } from "@/lib/utils";
import type { MonoTone } from "@/components/piscine";

/**
 * The BY AGENT / BY PROJECT bands of frame 8d — one component, two instances.
 *
 * EMPTY BAND: header and footnote only, with NO list element at all, so the
 * band collapses to its label line. That is the universal fallback of this
 * design (an empty stratum collapses; it never fabricates a placeholder row)
 * and it is also what lets `queryByTestId("usage-agent-table")` be null on a
 * fresh database.
 *
 * The list SCROLLS past four rows rather than truncating. This screen is about
 * money; hiding a spend row is lying. Four or fewer rows keep the frame's
 * `space-evenly` distribution.
 */
export interface UsageBarBandProps {
  /** Authored in sentence case — `BandHeader` uppercases it in CSS. */
  label: string;
  stratum: "live" | "next";
  footnote: string;
  listTestId: string;
  rowCount: number;
  children: ReactNode;
}

const FOOTNOTE_TONE: Record<"live" | "next", MonoTone> = {
  live: "live-mid",
  next: "next-mid",
};

export function UsageBarBand({
  label,
  stratum,
  footnote,
  listTestId,
  rowCount,
  children,
}: UsageBarBandProps) {
  return (
    <StrataBand stratum={stratum} gap={10} className="px-[18px] py-[15px]">
      <BandHeader label={label} stratum={stratum} labelSize={12} standalone />

      {rowCount > 0 && (
        <div
          data-testid={listTestId}
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-[9px] text-[12.5px]",
            rowCount <= 4 ? "justify-evenly" : "justify-start overflow-y-auto",
          )}
        >
          {children}
        </div>
      )}

      <Mono size={10.5} tone={FOOTNOTE_TONE[stratum]} className="mt-auto">
        {footnote}
      </Mono>
    </StrataBand>
  );
}
