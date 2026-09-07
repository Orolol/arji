"use client";

/**
 * GIT on the sun ground (frame 6a, lines 287-297).
 *
 * NO BRANCH ⇒ the whole band collapses to its label line: no chip, no
 * diffstat, no buttons. Every Arij epic branch has a worktree by construction,
 * so `worktree isolé` is a constant that appears with the branch.
 *
 * DIFFSTAT PENDING OR FAILED ⇒ em-dashes, never `+0 −0 · 0 files`. `DiffDelta`
 * renders nothing for null, so the signs disappear with the numbers and the
 * dashes are written as literal children.
 *
 * MERGE. The merge IS the approval — there is no separate approve action —
 * and its error surface belongs HERE, next to the "Resolve with agent"
 * action the message points at, not in a global toast.
 */

import { useTranslations } from "next-intl";
import { ArrowUpRight, FileDiff, GitMerge, GitPullRequest, Wrench } from "lucide-react";

import {
  BandHeader,
  DiffDelta,
  Mono,
  PillButton,
  pillButtonVariants,
  Stamp,
  StrataBand,
} from "@/components/piscine";
import type { DiffTotals } from "@/components/ticket/derive";

export interface GitBandPr {
  number: number;
  url: string;
}

export interface GitBandProps {
  branchName: string | null;
  diffstat: DiffTotals;
  status: string;
  githubConfigured: boolean;
  pr: GitBandPr | null;
  prLoading: boolean;
  prError: string | null;
  onCreatePr: () => void;
  onSyncPr: () => void;
  onOpenDiff: () => void;
  onMerge: () => void;
  merging: boolean;
  mergeError: string | null;
  mergeConflict: boolean;
  conflictFiles?: string[];
  onResolveMerge: () => void;
  resolvingMerge: boolean;
  isRunning: boolean;
}

export function GitBand({
  branchName,
  diffstat,
  status,
  githubConfigured,
  pr,
  prLoading,
  prError,
  onCreatePr,
  onSyncPr,
  onOpenDiff,
  onMerge,
  merging,
  mergeError,
  mergeConflict,
  conflictFiles,
  onResolveMerge,
  resolvingMerge,
  isRunning,
}: GitBandProps) {
  const t = useTranslations("Ticket");
  const hasDiff = diffstat.files !== null;

  return (
    <StrataBand
      stratum="land"
      density="rail"
      gap={8}
      className="shrink-0"
    >
      <BandHeader label={t("git.label")} stratum="land" standalone className="gap-[10px]" />

      {branchName ? (
        <>
          <Mono
            size={11}
            tone="ink"
            clamp={1}
            className="rounded-[10px] bg-card px-[9px] py-[5px]"
          >
            {branchName}
          </Mono>

          <div data-testid="ticket-diffstat">
            <Mono size={11} tone="land-mid">
              {hasDiff ? (
                <>
                  <DiffDelta
                    added={diffstat.added}
                    removed={diffstat.removed}
                    size={11}
                  />{" "}
                  {t("git.diffstat", { files: String(diffstat.files) })}
                </>
              ) : (
                // Unavailable numerals are em-dashes, never zeros.
                <>{t("git.diffstatUnknown")}</>
              )}
            </Mono>
          </div>

          <div className="flex flex-wrap gap-2">
            {githubConfigured ? (
              pr ? (
                // A real link, not a button that opens one: the pill recipe is
                // exported precisely so an anchor can wear it.
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="ticket-pr-link"
                  className={pillButtonVariants({
                    variant: "filled",
                    size: "sm",
                  })}
                >
                  <ArrowUpRight size={12} aria-hidden="true" />
                  {t("git.prLink", { number: String(pr.number) })}
                </a>
              ) : (
                <PillButton
                  variant="filled"
                  size="sm"
                  icon={GitPullRequest}
                  onClick={onCreatePr}
                  pending={prLoading}
                  pendingLabel={t("git.creatingPr")}
                  data-testid="ticket-create-pr"
                >
                  {t("git.createPr")}
                </PillButton>
              )
            ) : null}

            <PillButton
              variant="outline"
              outlineTone="action"
              size="sm"
              icon={FileDiff}
              onClick={onOpenDiff}
              data-testid="ticket-open-diff"
            >
              {t("git.diff")}
            </PillButton>

            {githubConfigured && pr ? (
              <PillButton
                variant="outline"
                outlineTone="neutral"
                size="sm"
                onClick={onSyncPr}
                pending={prLoading}
                pendingLabel={t("git.syncing")}
                data-testid="ticket-sync-pr"
              >
                {t("git.sync")}
              </PillButton>
            ) : null}
          </div>

          {prError ? (
            <p className="m-0 text-[12px] leading-[1.5] text-destructive">
              {prError}
            </p>
          ) : null}

          {/* The land action: its own row, so the one-filled-button-per-row
              rule still holds with Create PR above it. */}
          {status === "to_merge" ? (
            <div className="flex">
              <PillButton
                variant="filled"
                size="sm"
                icon={GitMerge}
                onClick={onMerge}
                pending={merging}
                pendingLabel={t("git.merging")}
                data-testid="ticket-merge"
              >
                {t("git.merge")}
              </PillButton>
            </div>
          ) : null}

          {mergeError ? (
            <div className="flex flex-col gap-2" data-testid="ticket-merge-error">
              {mergeConflict ? <Stamp tone="conflict">{t("git.conflict")}</Stamp> : null}
              <p className="m-0 text-[12px] leading-[1.5] text-strata-you-deep">
                {mergeError}
              </p>
              {/* `conflictFiles` stays undefined rather than becoming [] —
                  render the list when there is one, never an empty one. */}
              {mergeConflict && conflictFiles && conflictFiles.length > 0 ? (
                <div data-testid="ticket-conflict-files">
                  <Mono size={11} tone="danger">
                    {conflictFiles.join(", ")}
                  </Mono>
                </div>
              ) : null}
              {mergeConflict ? (
                <div className="flex">
                  <PillButton
                    variant="outline"
                    outlineTone="action"
                    size="sm"
                    icon={Wrench}
                    onClick={onResolveMerge}
                    disabled={resolvingMerge || isRunning}
                    data-testid="ticket-resolve-merge"
                  >
                    {t("git.resolveWithAgent")}
                  </PillButton>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </StrataBand>
  );
}
