"use client";

import {
  BandHeader,
  DiffDelta,
  Mono,
  QuietLink,
  RatioBar,
  StrataBand,
  type RatioSegment,
} from "@/components/piscine";

import { BAR_MAX_PX, scaleDiffBar } from "./log-lines";
import type { SessionDiff, SessionDiffFile } from "./types";

/**
 * FILES TOUCHED — the per-file diffstat of the session's worktree.
 *
 * Nothing stores a per-session diffstat, so this is derived live by the
 * `/files` route from `git diff --numstat`. When there is no worktree, the
 * worktree has been pruned, the project has no repository, or git throws, the
 * card COLLAPSES TO ITS LABEL LINE — header only, no meta, no rows, no
 * "0 files". That is the system's own rule for absent data, and it is strictly
 * better than a card full of em-dashes.
 */

export interface FilesTouchedCardProps {
  projectId: string;
  epicId: string | null;
  diff: SessionDiff | null;
}

/**
 * One file row: path, counts, then EITHER the proportion bar (the diff is
 * settled) OR the word "en cours" (the agent is still writing this file).
 * A bar over a diff that is still moving would be a lie about a number.
 */
function FileDiffRow({
  file,
  maxTotal,
}: {
  file: SessionDiffFile;
  maxTotal: number;
}) {
  const { addedPx, removedPx } = scaleDiffBar(
    file.added ?? 0,
    file.removed ?? 0,
    maxTotal
  );
  const segments: RatioSegment[] = [];
  if (addedPx > 0) {
    segments.push({
      percent: (addedPx / BAR_MAX_PX) * 100,
      color: "var(--strata-live-bar)",
      radius: removedPx > 0 ? "left" : "both",
    });
  }
  if (removedPx > 0) {
    segments.push({
      percent: (removedPx / BAR_MAX_PX) * 100,
      color: "var(--chart-fail)",
      radius: addedPx > 0 ? "right" : "both",
    });
  }

  return (
    <div className="flex items-center gap-[10px]">
      <Mono size={11} clamp={1} className="min-w-0 flex-1" as="span">
        {file.path}
      </Mono>
      <DiffDelta added={file.added} removed={file.removed} size={11} />
      {file.inProgress ? (
        <Mono size={10} tone="muted">
          en cours
        </Mono>
      ) : segments.length > 0 ? (
        <RatioBar
          height={6}
          track="none"
          width={BAR_MAX_PX}
          segments={segments}
        />
      ) : null}
    </div>
  );
}

export function FilesTouchedCard({
  projectId,
  epicId,
  diff,
}: FilesTouchedCardProps) {
  const files = diff?.available ? diff.files : [];
  const totals = diff?.available ? diff.totals : null;

  const maxTotal = files.reduce(
    (max, file) => Math.max(max, (file.added ?? 0) + (file.removed ?? 0)),
    0
  );

  return (
    <StrataBand stratum="card" density="full" gap={9} className="shrink-0">
      <BandHeader
        label="Files touched"
        stratum="neutral"
        labelSize={12}
        meta={
          totals ? (
            <>
              {`${totals.files} files · `}
              {/* `DiffDelta` is display:contents and relies on the parent's
                  gap; inside the header's inline mono run there is none. */}
              <span className="inline-flex items-baseline gap-[5px]">
                <DiffDelta
                  added={totals.added}
                  removed={totals.removed}
                  size={10.5}
                />
              </span>
            </>
          ) : undefined
        }
        right={
          epicId ? (
            // The board already knows how to consume `?ticket=`; this is the
            // existing deep link the old page's "View diff" button used.
            <QuietLink
              href={`/projects/${projectId}?ticket=${epicId}`}
              tone="next"
              size={12}
            >
              open diff →
            </QuietLink>
          ) : undefined
        }
      />
      {files.length > 0 && (
        // Bounded on purpose. The frame draws three rows; a real build touches
        // dozens, and a natural-height list of them would squeeze the LIVE LOG
        // band — the one thing on this screen that must stay the content — down
        // to a few dozen pixels. The card keeps its natural height until it
        // would start eating the log, then scrolls inside itself.
        <div className="flex max-h-[168px] flex-col gap-[6px] overflow-y-auto">
          {files.map((file) => (
            <FileDiffRow key={file.path} file={file} maxTotal={maxTotal} />
          ))}
        </div>
      )}
    </StrataBand>
  );
}
