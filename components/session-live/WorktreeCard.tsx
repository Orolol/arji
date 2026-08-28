"use client";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";

import type { SessionDiff } from "./types";

/**
 * WORKTREE — where this session is doing its work, on the sun ground.
 *
 * Omitted entirely when the session has neither a branch nor a worktree path
 * (chat sessions, spec generation): there is nothing to say, and a card of
 * em-dashes says it worse than silence.
 */

export interface WorktreeCardProps {
  branchName: string | null;
  worktreePath: string | null;
  diff: SessionDiff | null;
}

export function WorktreeCard({
  branchName,
  worktreePath,
  diff,
}: WorktreeCardProps) {
  if (!branchName && !worktreePath) return null;

  // The rail is ~468px wide; show the tail of the path and keep the whole of
  // it in the title attribute.
  const shortPath = worktreePath
    ? worktreePath.split("/").filter(Boolean).slice(-2).join("/")
    : null;

  const baseBranch = diff?.baseBranch ?? null;
  const mergeBase = diff?.mergeBase ?? null;
  const behind = diff?.behind ?? null;
  const showMergeBase = Boolean(baseBranch && mergeBase);

  return (
    <StrataBand stratum="land" density="rail" gap={7}>
      <BandHeader label="Worktree" stratum="land" labelSize={12} standalone />

      {branchName && (
        <span className="self-start rounded-full bg-card px-[9px] py-[5px]">
          <Mono size={11} clamp={1}>
            {branchName}
          </Mono>
        </span>
      )}

      {shortPath && (
        <span title={worktreePath ?? undefined}>
          <Mono size={10.5} tone="land-mid" clamp={1}>
            {`${shortPath} · isolé`}
          </Mono>
        </span>
      )}

      {/* Never `main@—`: with no merge base the line simply is not drawn, and
          with no behind count the "à jour" claim is not made. */}
      {showMergeBase && (
        <Mono size={10.5} tone="land-mid">
          {"merge base "}
          <span className="text-foreground">
            {`${baseBranch}@${mergeBase!.slice(0, 6)}`}
          </span>
          {behind === null ? "" : behind === 0 ? " · à jour" : ` · ${behind} derrière`}
        </Mono>
      )}
    </StrataBand>
  );
}
