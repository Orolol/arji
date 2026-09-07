"use client";

import { GitMerge, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";

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
 * The Releases screen's SECOND ROW: the repo line, an outline Fetch and the
 * single filled Push button.
 *
 * This one was born body-rendered and is the shape the 13a retrofit adopted for
 * every screen: h38, the body's 14px gutter, no border, no background — a row
 * INSIDE the content, never a header. The global bar
 * (`components/piscine/TopBar.tsx`) is the only header on the route.
 *
 * Every screen carries a different row (8b Écrire/Prévisualiser + Régénérer par
 * chat, 8a chrono + Stop, 8d the range control), which is precisely why the
 * shared project layout cannot own any of them.
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
  const t = useTranslations("Releases");
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

  // The ` · ` is frame furniture, so it stays inline; the clause it joins is
  // an ICU plural in the catalogue rather than a bespoke ternary here.
  const worktreeClause =
    worktreeCount === null
      ? ""
      : ` · ${t("controls.worktrees", { count: worktreeCount })}`;

  return (
    <div
      data-testid="release-controls"
      className="flex h-[38px] shrink-0 items-center justify-end gap-[14px] px-[14px]"
    >
      <span data-testid="release-repo-line" title={error ?? undefined}>
        {error ? (
          // The hook resolves ahead/behind against this branch; when it cannot,
          // it reports why. A stale "↑ 0 to push" is a lie the user cannot see.
          <Mono size={11} tone="danger" clamp={1}>
            {error}
          </Mono>
        ) : (
          <Mono size={11} tone="muted">
            {`${t("controls.repoLine", { branch, ahead: String(ahead) })}${worktreeClause}`}
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
        {t("controls.fetch")}
      </PillButton>

      <PillButton
        variant="filled"
        size="md"
        icon={GitMerge}
        disabled={pushing || ahead === 0}
        pending={pushing}
        pendingLabel={t("controls.pushing")}
        onClick={() => void push()}
        data-testid="release-push-button"
      >
        {t("controls.push", { branch })}
      </PillButton>
    </div>
  );
}
