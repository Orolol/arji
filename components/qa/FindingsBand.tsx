"use client";

import { BandHeader, StrataBand } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaFinding } from "@/lib/qa/types";

import {
  FindingFilterPills,
  type FindingFilter,
} from "./FindingFilterPills";
import { FindingRow } from "./FindingRow";

/**
 * FINDINGS À ARBITRER — the coral stratum, and the ONE band on 11b that grows.
 *
 * The rows scroll inside the band, so the bottom split is never pushed
 * off-screen however many findings are open.
 *
 * THE HEADER COUNTERS DESCRIBE THE UNFILTERED SET. `4 open · 1 blocking` is the
 * project-scoped truth; changing the filter changes which rows are drawn, never
 * how many exist. A counter that moved with the filter would make "1 blocking"
 * mean "1 blocking among what I am currently showing you", which is not a
 * number anybody wants.
 *
 * EMPTY: header + footnote. The footnote stays — it is the screen's explanation
 * of the link to Ready to land, and it is true whether or not there are
 * findings today. The band still grows, so a clean morning is a large coral
 * rectangle; that is correct, since findings are 11b's whole subject.
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
    <StrataBand stratum="you" density="full" gap={10} grow className={className}>
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
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
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
