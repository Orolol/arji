"use client";

import { GitMerge, RefreshCw } from "lucide-react";

import { Mono, PillButton } from "@/components/piscine";
import { useGitStatus } from "@/hooks/useGitStatus";
import { useWorktrees } from "@/hooks/useWorktrees";
import { cn } from "@/lib/utils";

export interface ReleaseHeaderClusterProps {
  projectId: string;
  /** The project's stored default branch; "main" is only the legacy fallback. */
  branch: string;
  /** `Boolean(gitRepoPath)` — a plain enabled flag, never the GitHub PAT state. */
  enabled: boolean;
}

/**
 * The screen-specific right cluster of the Releases header: the repo line, an
 * outline Fetch and the single filled Push button.
 *
 * Every frame carries a different cluster (8b has ⌘K + Régénérer par chat, 8a a
 * chrono + Stop), so the shared project layout cannot own this — it is rendered
 * by the page, above the two-column body.
 *
 * Deliberately NOT RepoStrataBand (Git Sync): that band also draws PR pills and a behind
 * count the frame does not have, and its testids are asserted on by an existing
 * test. Same hooks, different composition.
 */
export function ReleaseHeaderCluster({
  projectId,
  branch,
  enabled,
}: ReleaseHeaderClusterProps) {
  const { ahead, loading, error, refresh, push, pushing } = useGitStatus(
    projectId,
    branch,
    enabled,
  );
  // Never polled by design; only the Fetch button below refreshes it, which is
  // why Fetch must call BOTH refreshers or the worktree count freezes forever.
  const { count: worktreeCount, refresh: refreshWorktrees } = useWorktrees(
    projectId,
    enabled,
  );

  // No repo, nothing true to say. An "↑ 0 to push" the user cannot detect as
  // meaningless is worse than an absent cluster.
  if (!enabled) return null;

  const worktreeClause =
    worktreeCount === null
      ? ""
      : ` · ${worktreeCount} ${worktreeCount === 1 ? "worktree" : "worktrees"}`;

  return (
    <div className="flex h-[38px] shrink-0 items-center justify-end gap-[14px] px-[14px]">
      <span data-testid="release-repo-line" title={error ?? undefined}>
        {error ? (
          // The hook resolves ahead/behind against this branch; when it cannot,
          // it reports why. A stale "↑ 0 to push" is a lie the user cannot see.
          <Mono size={11} tone="danger" clamp={1}>
            {error}
          </Mono>
        ) : (
          <Mono size={11} tone="muted">
            {`${branch} · ↑ ${ahead} to push${worktreeClause}`}
          </Mono>
        )}
      </span>

      <PillButton
        variant="outline"
        outlineTone="action"
        size="md"
        icon={RefreshCw}
        disabled={loading}
        onClick={() => {
          refresh();
          void refreshWorktrees();
        }}
        data-testid="release-fetch-button"
        className={cn(
          loading && "[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none",
        )}
      >
        Fetch
      </PillButton>

      <PillButton
        variant="filled"
        size="md"
        icon={GitMerge}
        disabled={pushing || ahead === 0}
        pending={pushing}
        pendingLabel="Pushing…"
        onClick={() => void push()}
        data-testid="release-push-button"
      >
        {`Push ${branch}`}
      </PillButton>
    </div>
  );
}
