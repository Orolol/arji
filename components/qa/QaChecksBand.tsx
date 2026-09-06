"use client";

import type { ReactNode } from "react";

import { BandHeader, StrataBand } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaCheck, QaCheckTotals } from "@/lib/qa/types";

import { QaCheckRow } from "./QaCheckRow";

/**
 * QA CHECKS — the linden stratum, directly under QA RUNS.
 *
 * THE BAND THE REDESIGN NEEDED AND DID NOT HAVE. `/qa` describes the review
 * layer: sessions bound to a ticket and the findings they file. A tech check,
 * an E2E pass and a failure digest are none of those — they have no epic, they
 * file no `review_comments`, and `deriveRuns` filters them out by agent type.
 * Starting one from this screen and then seeing nothing happen would be worse
 * than not having the button, so the dispatch and this band ship together.
 *
 * LINDEN, not turquoise. Two turquoise bands would say "these are the same
 * kind of thing" about the one distinction this screen has to keep. Colour is
 * the stratum; a running check is told by its breathing dot and its word.
 *
 * `shrink-0`, like VERDICTS RÉCENTS: the coral findings band is the one band on
 * 11b that grows, and the route caps these rows (`QA_CHECK_LIMIT`) so the band
 * cannot push the split off the screen. The full history lives on
 * `/projects/:id/qa`, which is where every row links — and the header's `total`
 * is what says the rows are a window rather than the whole register.
 *
 * EMPTY: header only. `StrataBand`'s gap is a flex gap, so a band whose single
 * child is its header folds to the label line — no placeholder, no "all quiet".
 */
export interface QaChecksBandProps {
  checks: readonly QaCheck[];
  /**
   * Counts over EVERY report in scope, not over `checks`.
   *
   * The rows are a `QA_CHECK_LIMIT` window; counting them would print a
   * constant. `QaRunsBand` and `FindingsBand` count uncapped collections and
   * `VerdictsBand` — the other capped band — shows a window descriptor instead
   * of a count; this band is capped AND counts, so the count comes from the
   * server rather than from the slice.
   */
  totals: QaCheckTotals;
  projectsById: ReadonlyMap<string, DeskProject>;
  /** Rendered in the header's right slot — the "New check" control. */
  action?: ReactNode;
  className?: string;
}

export function QaChecksBand({
  checks,
  totals,
  projectsById,
  action,
  className,
}: QaChecksBandProps) {
  return (
    <StrataBand stratum="feed" density="full" gap={9} className={className}>
      <BandHeader
        label="QA checks"
        stratum="feed"
        labelSize={13}
        meta={`${totals.running} running · ${totals.total} total`}
        right={action}
      />
      {checks.map((check) => (
        <QaCheckRow
          key={check.reportId}
          check={check}
          project={projectsById.get(check.projectId)}
        />
      ))}
    </StrataBand>
  );
}
