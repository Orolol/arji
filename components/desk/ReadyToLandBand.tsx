"use client";

import * as React from "react";
import { GitMerge } from "lucide-react";

import {
  BandHeader,
  IdentityChip,
  Mono,
  PillButton,
  QuietLink,
  StrataBand,
  SurfaceCard,
  projectTone,
} from "@/components/piscine";
import type { DeskLandRow, DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * READY TO LAND — the sun stratum: branches a merge click will plausibly land.
 *
 * Membership is `evaluateMergeReadiness().ready`, evaluated server-side from
 * the same facts Full Auto's merge selector reads, so the desk can never offer
 * a merge the engine refuses.
 *
 * DISPLAY-ONLY SLICE. This band never writes `epics.position`: position is
 * Full Auto's execution-order contract (lib/kanban/reorder.ts), and ordering a
 * display list into it would silently re-order the supervisor's queue. There is
 * no drag-and-drop here for the same reason.
 *
 * MERGE AFFORDANCE. A ticket any session still owns — QUEUED included — loses
 * its Land button rather than being offered a click the merge route refuses:
 * merging removes the worktree a queued build would land in.
 */
export interface ReadyToLandBandProps {
  rows: readonly DeskLandRow[];
  heldBackCount: number;
  projectsById: ReadonlyMap<string, DeskProject>;
  landingEpicId?: string | null;
  landingAll?: boolean;
  onLand: (row: DeskLandRow) => void | Promise<void>;
  onLandAll: (rows: readonly DeskLandRow[]) => void | Promise<void>;
  /** The event rides along so ⌘/Ctrl-click can select instead of open. */
  onOpenTicket?: (epicId: string, event: React.MouseEvent) => void;
  onShowHeldBack?: () => void;
  /** Batch selection, for the ⌘/Ctrl-click affordance. */
  selectedEpicIds?: ReadonlySet<string>;
  className?: string;
}

/** "#218 · clean · 4/4 US" — the PR number is optional, as in the frame. */
export function landMeta(row: DeskLandRow): string {
  const parts: string[] = [];
  if (row.prNumber !== null && row.prNumber !== undefined) parts.push(`#${row.prNumber}`);
  parts.push(
    row.openFindings > 0
      ? `${row.openFindings} finding${row.openFindings === 1 ? "" : "s"}`
      : "clean",
  );
  parts.push(`${row.usDone}/${row.usCount} US`);
  return parts.join(" · ");
}

export function ReadyToLandBand({
  rows,
  heldBackCount,
  projectsById,
  landingEpicId,
  landingAll = false,
  onLand,
  onLandAll,
  onOpenTicket,
  onShowHeldBack,
  selectedEpicIds,
  className,
}: ReadyToLandBandProps) {
  const landable = rows.filter((row) => !row.agentBusy);

  return (
    <StrataBand
      stratum="land"
      density="half"
      gap={9}
      className={cn("min-w-0", className)}
    >
      <BandHeader
        label="Ready to land"
        stratum="land"
        labelSize={13}
        meta={rows.length > 0 ? String(rows.length) : undefined}
        right={
          landable.length > 1 ? (
            <PillButton
              variant="filled"
              size="sm"
              onClick={() => void onLandAll(landable)}
              pending={landingAll}
              pendingLabel="Landing…"
              data-testid="desk-land-all"
            >
              {landable.length === 2 ? "Land both" : `Land all ${landable.length}`}
            </PillButton>
          ) : undefined
        }
      />

      {rows.map((row) => {
        const project = projectsById.get(row.projectId);
        return (
          <SurfaceCard
            key={row.epicId}
            radius={12}
            selected={selectedEpicIds?.has(row.epicId)}
            data-testid="desk-land-row"
            className="flex items-center gap-3 px-[13px] py-[10px]"
          >
            <IdentityChip
              label={row.readableId ?? project?.shortName ?? "—"}
              tone={projectTone(project?.colorIndex ?? 0)}
              size="sm"
            />
            <button
              type="button"
              disabled={!onOpenTicket}
              onClick={(event) => onOpenTicket?.(row.epicId, event)}
              className={cn(
                "line-clamp-1 min-w-0 flex-1 border-0 bg-transparent p-0 text-left",
                "font-sans text-[13px] font-medium text-foreground",
                "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
                "disabled:cursor-default",
              )}
            >
              {row.title}
            </button>
            <Mono size={10.5} tone="muted" className="shrink-0">
              {landMeta(row)}
            </Mono>
            {row.agentBusy ? (
              <Mono size={10.5} tone="land-mid" className="shrink-0">
                agent au travail
              </Mono>
            ) : (
              <PillButton
                variant="filled"
                size="sm"
                icon={GitMerge}
                onClick={() => void onLand(row)}
                pending={landingEpicId === row.epicId}
                pendingLabel="Landing…"
                disabled={landingAll || (landingEpicId !== null && landingEpicId !== undefined)}
                data-testid="desk-land-button"
              >
                Land
              </PillButton>
            )}
          </SurfaceCard>
        );
      })}

      {heldBackCount > 0 ? (
        <QuietLink tone="land" size={11.5} onClick={onShowHeldBack}>
          {`${heldBackCount} autre${heldBackCount === 1 ? "" : "s"} bloqué${heldBackCount === 1 ? "" : "s"} par des findings ouverts →`}
        </QuietLink>
      ) : null}
    </StrataBand>
  );
}
