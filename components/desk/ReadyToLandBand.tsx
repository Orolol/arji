"use client";

import * as React from "react";
import { GitMerge } from "lucide-react";
import { useTranslations } from "next-intl";

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

/**
 * The three phrases the meta line is made of, already resolved by the caller's
 * translator — `landMeta` composes, it does not hold copy. Agreement on the
 * finding count is the catalogue's ICU plural, not an `=== 1` here.
 */
export interface LandMetaCopy {
  findings: (count: number) => string;
  clean: string;
  userStories: (done: number, count: number) => string;
}

/** "#218 · clean · 4/4 US" — the PR number is optional, as in the frame. */
export function landMeta(row: DeskLandRow, copy: LandMetaCopy): string {
  const parts: string[] = [];
  if (row.prNumber !== null && row.prNumber !== undefined) parts.push(`#${row.prNumber}`);
  parts.push(row.openFindings > 0 ? copy.findings(row.openFindings) : copy.clean);
  parts.push(copy.userStories(row.usDone, row.usCount));
  return parts.join(" · ");
}

/**
 * The land row's skeleton — B-arij-M9zsQujUTCoR.
 *
 * The chip, the `#218 · clean · 4/4 US` meta and the Land pill are all
 * `shrink-0`, so the title button is the only child that can absorb a deficit
 * and it absorbs all of it: measured 0px wide in Chrome at both 390×844 (the
 * band 139px, with the Land pill painted over UP NEXT) and 768×1024 (328px).
 *
 * Below `sm` the row becomes two lines — identity and title, then meta and
 * Land. `sm`, not `lg`: once `NowDesk` stops putting the two bands side by
 * side below `lg`, a 640px-wide band already leaves the title ~205px, and a
 * second line there would only be spent height.
 *
 * From `sm` up the two wrappers are `display: contents`, so the desktop row
 * still has its four children as direct flex items.
 */
const ROW_CLASS = cn(
  "flex items-center gap-3 px-[13px] py-[10px]",
  "max-sm:flex-col max-sm:items-stretch max-sm:gap-1.5",
);

const ROW_HEAD_CLASS = cn("contents", "max-sm:flex max-sm:min-w-0 max-sm:items-center max-sm:gap-2");

const ROW_ACTIONS_CLASS = cn(
  "contents",
  "max-sm:flex max-sm:min-w-0 max-sm:flex-wrap max-sm:items-center max-sm:justify-end max-sm:gap-2",
);

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
  const t = useTranslations("Desk");
  const landable = rows.filter((row) => !row.agentBusy);
  const metaCopy: LandMetaCopy = {
    findings: (count) => t("land.findings", { count }),
    clean: t("land.clean"),
    userStories: (done, count) => t("land.userStories", { done, count }),
  };

  return (
    <StrataBand
      stratum="land"
      density="half"
      gap={9}
      className={cn("min-w-0", className)}
    >
      <BandHeader
        label={t("land.label")}
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
              pendingLabel={t("land.landing")}
              data-testid="desk-land-all"
            >
              {landable.length === 2
                ? t("land.landBoth")
                : t("land.landAll", { count: landable.length })}
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
            className={cn(ROW_CLASS)}
          >
            <div data-testid="desk-land-row-head" className={ROW_HEAD_CLASS}>
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
            </div>
            <div data-testid="desk-land-row-actions" className={ROW_ACTIONS_CLASS}>
              <Mono size={10.5} tone="muted" className="shrink-0">
                {landMeta(row, metaCopy)}
              </Mono>
              {row.agentBusy ? (
                <Mono size={10.5} tone="land-mid" className="shrink-0">
                  {t("land.agentBusy")}
                </Mono>
              ) : (
                <PillButton
                  variant="filled"
                  size="sm"
                  icon={GitMerge}
                  onClick={() => void onLand(row)}
                  pending={landingEpicId === row.epicId}
                  pendingLabel={t("land.landing")}
                  disabled={landingAll || (landingEpicId !== null && landingEpicId !== undefined)}
                  data-testid="desk-land-button"
                >
                  {t("land.land")}
                </PillButton>
              )}
            </div>
          </SurfaceCard>
        );
      })}

      {heldBackCount > 0 ? (
        <QuietLink tone="land" size={11.5} onClick={onShowHeldBack}>
          {t("land.heldBack", { count: heldBackCount })}
        </QuietLink>
      ) : null}
    </StrataBand>
  );
}
