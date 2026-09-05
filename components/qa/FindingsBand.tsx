"use client";

import { BandHeader, StrataBand } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaFinding } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

import {
  FindingFilterPills,
  type FindingFilter,
} from "./FindingFilterPills";
import { FindingRow } from "./FindingRow";

/**
 * FINDINGS À ARBITRER — the coral stratum, and the ONE band on 11b that grows.
 *
 * The rows scroll inside the band, so the bottom split is never pushed
 * off-screen however many findings are open. BELOW `lg` THEY DO NOT: a phone
 * has no leftover height to give the growing band, so it collapsed onto its
 * own header and drew the rows — and their actions — inside a zero-height
 * scroller (B-arij-iL4-FmyXgGr). There the band is as tall as its rows and the
 * page scrolls, which is how a phone reads a list anyway.
 *
 * THE HEADER COUNTERS DESCRIBE THE UNFILTERED SET. `4 open · 1 blocking` is the
 * project-scoped truth; changing the filter changes which rows are drawn, never
 * how many exist. A counter that moved with the filter would make "1 blocking"
 * mean "1 blocking among what I am currently showing you", which is not a
 * number anybody wants.
 *
 * EMPTY: header + footnote. The footnote stays — it is the screen's explanation
 * of the link to Ready to land, and it is true whether or not there are
 * findings today. The band still grows on a desk, so a clean morning is a large
 * coral rectangle; that is correct, since findings are 11b's whole subject. On
 * a phone it folds to the two lines it actually draws.
 */
export interface FindingsBandProps {
  /** Every open finding in scope — the counters and the filter both read this. */
  findings: readonly QaFinding[];
  /** The rows actually drawn, after the filter. */
  visible: readonly QaFinding[];
  filter: FindingFilter;
  onFilterChange: (filter: FindingFilter) => void;
  projectsById: ReadonlyMap<string, DeskProject>;
  pendingIds?: ReadonlySet<string>;
  onFix?: (finding: QaFinding) => void;
  onDiff?: (finding: QaFinding) => void;
  onDismiss?: (finding: QaFinding) => void;
  className?: string;
}

export function FindingsBand({
  findings,
  visible,
  filter,
  onFilterChange,
  projectsById,
  pendingIds,
  onFix,
  onDiff,
  onDismiss,
  className,
}: FindingsBandProps) {
  const blocking = findings.filter((finding) => finding.blocking).length;

  return (
    <StrataBand
      stratum="you"
      density="full"
      gap={10}
      grow
      // `grow` is `flex: 1` + `min-height: 0`, which is the right answer inside
      // one screenful and the wrong one on a phone: with the other bands taller
      // than the viewport, the leftover height is zero and the band collapses
      // onto its own header. Below `lg` it is as tall as its rows and the page
      // scrolls (see `QaScreen`'s root).
      className={cn("max-lg:flex-none", className)}
    >
      <BandHeader
        label="Findings à arbitrer"
        stratum="you"
        labelSize={13}
        meta={`${findings.length} open · ${blocking} blocking`}
        right={<FindingFilterPills value={filter} onChange={onFilterChange} />}
      />

      {findings.length > 0 ? (
        <div
          data-testid="qa-findings-list"
          // The rows scroll inside the band on a desk. On a phone the band has
          // no leftover height to scroll them in, so they are drawn in full and
          // the page carries the scrolling.
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto max-lg:flex-none max-lg:overflow-visible"
        >
          {visible.length === 0 ? (
            <span className="font-sans text-[11.5px] text-strata-you-mid">
              Aucun finding pour ce filtre.
            </span>
          ) : (
            visible.map((finding) => (
              <FindingRow
                key={finding.findingId}
                finding={finding}
                project={projectsById.get(finding.projectId)}
                pending={pendingIds?.has(finding.findingId)}
                onFix={onFix}
                onDiff={onDiff}
                onDismiss={onDismiss}
              />
            ))
          )}
        </div>
      ) : null}

      <span
        data-testid="qa-findings-footnote"
        className="font-sans text-[11.5px] text-strata-you-mid"
      >
        {"Un finding "}
        <strong className="font-semibold">blocking</strong>
        {" retire le ticket de Ready to land ; Fix with agent relance un build ciblé sur le finding."}
      </span>
    </StrataBand>
  );
}
