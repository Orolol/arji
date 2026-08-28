"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";

import {
  DeskHeader,
  Mono,
  PillButton,
  SegmentedControl,
  pillButtonVariants,
} from "@/components/piscine";
import { formatClock } from "@/components/usage/formatters";
import type { UsageRange } from "@/lib/types/usage";

/**
 * The 60px paper header of frame 8d.
 *
 * ONE FILLED BUTTON PER ROW: "Back to board" is it. Refresh is an outline pill
 * and the active range segment is a control state, not a second button.
 *
 * The segmented control carries an EXTRA 14px left margin on top of the
 * header's own 14px gap, so the gap between the title and the control reads as
 * 28px. That is the frame; do not unify it.
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
    <DeskHeader title="Usage">
      <SegmentedControl
        // `filled` is the white --card rail; the 1.5px hairline is added
        // because this control sits on shell paper, not on a card.
        chrome="filled"
        size="sm"
        className="ml-[14px] border-[1.5px] border-border"
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
        {/*
          PillButton is a <button>; the pill that NAVIGATES is a Link wearing
          the same cva recipe rather than a button nested in an anchor.
        */}
        <Link
          href="/"
          className={pillButtonVariants({ variant: "filled", size: "md" })}
        >
          <ArrowLeft size={13} aria-hidden="true" />
          Back to board
        </Link>
      </div>
    </DeskHeader>
  );
}
