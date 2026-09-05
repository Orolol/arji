"use client";

import { BandHeader, StrataBand } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaQueuedRun, QaRun } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

import { QaQueuedTile } from "./QaQueuedTile";
import { QaRunCard } from "./QaRunCard";

/**
 * QA RUNS — the turquoise stratum of frame 11b.
 *
 * It does NOT grow: on 11b the coral findings band owns the leftover height
 * (exactly one band per screen may), so the grid rows here are content-height
 * rather than the desk's `1fr 1fr`. A fixed row height would leave dead
 * turquoise on a quiet morning.
 *
 * EMPTY STRATUM: with no live and no queued review sessions the band renders
 * its `BandHeader` and nothing else, and folds to the label line —
 * `StrataBand`'s `gap` is a flex gap, so a single child costs zero extra
 * height. No placeholder card, no "all quiet" copy.
 */
export interface QaRunsBandProps {
  runs: readonly QaRun[];
  queued: readonly QaQueuedRun[];
  projectsById: ReadonlyMap<string, DeskProject>;
  onOpenTicket?: (epicId: string) => void;
  onStopRun?: (sessionId: string) => void;
  className?: string;
}

export function QaRunsBand({
  runs,
  queued,
  projectsById,
  onOpenTicket,
  onStopRun,
  className,
}: QaRunsBandProps) {
  const empty = runs.length === 0 && queued.length === 0;

  return (
    <StrataBand stratum="live" density="full" gap={10} className={className}>
      <BandHeader
        label="QA runs"
        stratum="live"
        labelSize={13}
        meta={`${runs.length} live · ${queued.length} queued`}
      />

      {empty ? null : (
        <div
          data-testid="qa-runs-grid"
          // THREE COLUMNS IS A DESKTOP FIGURE. A grid column's implicit
          // `min-width: auto` never shrinks below its card, so at 320/390px
          // the three of them measured 384/431px inside a 292/362px band —
          // the third card and its Stop control were simply outside it
          // (B-arij-iL4-FmyXgGr). One column on a phone, two from `sm`, and
          // the frame's three from `lg`.
          className={cn("grid grid-cols-1 gap-[11px] sm:grid-cols-2 lg:grid-cols-3")}
        >
          {runs.map((run) => (
            <QaRunCard
              key={run.sessionId}
              run={run}
              project={projectsById.get(run.projectId)}
              onOpenTicket={onOpenTicket}
              onStop={onStopRun}
            />
          ))}
          <QaQueuedTile
            queued={queued}
            projectsById={projectsById}
            onOpenTicket={onOpenTicket}
          />
        </div>
      )}
    </StrataBand>
  );
}
