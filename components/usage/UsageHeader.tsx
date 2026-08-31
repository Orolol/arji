"use client";

import { RefreshCw } from "lucide-react";

import { Mono, PillButton, SegmentedControl } from "@/components/piscine";
import { formatClock } from "@/components/usage/formatters";
import type { UsageRange } from "@/lib/types/usage";

/**
 * The usage screen's SECOND ROW — frame 13a's retrofit of frame 8d.
 *
 * 8d drew a 60px page header (logo · "Usage" · range control · Refresh · a
 * filled "Back to board"). 13a made the top bar global, so the logo, the page
 * identity and the way home all live there now and this file keeps only what
 * is genuinely per-screen: the range the report covers and the way to re-read
 * it. "Back to board" is gone — the bar's "A · Now" pill IS the way home, and a
 * second control saying the same thing next to it was the duplication 13a
 * exists to remove.
 *
 * NO FILLED BUTTON. Losing "Back to board" left the row without one, and that
 * is correct rather than an omission to fill: the system caps a row at one
 * filled button, it does not require one, and Refresh is a re-read — the least
 * committing action on the screen. Painting it deep water-green would make the
 * cheapest thing here the loudest.
 *
 * The gutter is the body's 14px, not the retired header's 24px: this row now
 * sits INSIDE the screen, so it lines up with the tiles under it.
 */
export interface UsageHeaderProps {
  range: UsageRange;
  onRangeChange: (range: UsageRange) => void;
  generatedAt: string;
  /** Present only when a refresh failed while a stale report is still shown. */
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}

const RANGE_OPTIONS: { value: UsageRange; label: string }[] = [
  { value: "7d", label: "7 j" },
  { value: "30d", label: "30 j" },
  { value: "all", label: "Tout" },
];

export function UsageHeader({
  range,
  onRangeChange,
  generatedAt,
  error,
  loading,
  onRefresh,
}: UsageHeaderProps) {
  return (
    <div
      data-testid="usage-controls"
      className="flex h-[38px] shrink-0 items-center gap-[14px] px-[14px]"
    >
      <SegmentedControl
        // `filled` is the white --card rail; the 1.5px hairline is added
        // because this control sits on shell paper, not on a card.
        chrome="filled"
        size="sm"
        className="border-[1.5px] border-border"
        options={RANGE_OPTIONS}
        value={range}
        onChange={onRangeChange}
      />

      <div className="ml-auto flex items-center gap-[8px]">
        {error && (
          <span data-testid="usage-refresh-error">
            <Mono size={11} tone="danger">
              {error}
            </Mono>
          </span>
        )}
        <Mono size={10.5} tone="muted">
          {`Updated ${formatClock(generatedAt)}`}
        </Mono>
        <PillButton
          variant="outline"
          outlineTone="neutral"
          size="md"
          icon={RefreshCw}
          disabled={loading}
          onClick={onRefresh}
          data-testid="usage-refresh"
        >
          Refresh
        </PillButton>
      </div>
    </div>
  );
}
