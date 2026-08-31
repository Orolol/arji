"use client";

import { useCallback, useEffect, useState } from "react";
import { Github, GitMerge, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrBadge } from "@/components/github/PrBadge";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";
import { useGitStatus } from "@/hooks/useGitStatus";
import { useWorktrees } from "@/hooks/useWorktrees";
import { timeAgo } from "@/lib/utils/format-date";
import { cn } from "@/lib/utils";

type PrStatus = "draft" | "open" | "closed" | "merged";

interface OpenPr {
  id: string;
  number: number;
  url: string;
  status: string;
}

interface RepoStatusBarProps {
  projectId: string;
  /** From the project record the layout already fetched; may be null. */
  ownerRepo: string | null;
  /** Local repository path from the project record; may be null. */
  gitRepoPath: string | null;
  /** The project's stored default branch (captured at GitHub import).
   *  The bar falls back to "main" for legacy rows that predate the column. */
  defaultBranch?: string | null;
}

/**
 * Footer state of the repository: where the project's default branch stands
 * against its remote, which pull requests are still open, and the two
 * actions that change that.
 *
 * It deliberately never shows agent or session activity — the board's
 * breathing dots and the Sessions tab already own that, and a second,
 * differently-timed copy of it here would make both surfaces untrustworthy.
 * Renders nothing at all when the project has no local git repository. The
 * GitHub PAT only gates the PR pills — ahead/behind/worktrees/fetch/push are
 * plain local git and must not disappear with the token.
 */
export function RepoStatusBar({
  projectId,
  ownerRepo,
  gitRepoPath,
  defaultBranch,
}: RepoStatusBarProps) {
  const config = useGitHubConfig(projectId);
  const repo = ownerRepo ?? config.ownerRepo;
  const enabled = Boolean(gitRepoPath);
  const prsEnabled = enabled && config.isConfigured;
  // The stored default branch is authoritative — it is the branch worktrees
  // are cut from and merged into. "main" is only the legacy fallback.
  const branch = defaultBranch || "main";

  const { ahead, behind, lastFetchedAt, loading, error, refresh, push, pushing } =
    useGitStatus(projectId, branch, enabled);

  // Count only — the list and the cleanup action live on Git Sync. Null while
  // unknown (no git repo, failed listing): a "0 worktrees" we cannot vouch
  // for would be worse than no counter at all.
  const { count: worktreeCount, refresh: refreshWorktrees } = useWorktrees(
    projectId,
    enabled
  );

  const [prs, setPrs] = useState<OpenPr[]>([]);
  const prsUrl = `/api/projects/${projectId}/prs`;

  const loadPrs = useCallback(async () => {
    if (!prsEnabled) return;
    try {
      const res = await fetch(prsUrl);
      const json = await res.json();
      if (Array.isArray(json?.data)) setPrs(json.data as OpenPr[]);
    } catch {
      // ignore — pills are informational
    }
  }, [prsUrl, prsEnabled]);

  // The initial load applies its result from a promise callback rather than
  // through `loadPrs`, so the effect body never updates state synchronously.
  useEffect(() => {
    if (!prsEnabled) return;
    let cancelled = false;
    fetch(prsUrl)
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled && Array.isArray(json?.data)) setPrs(json.data as OpenPr[]);
      })
      .catch(() => {
        // ignore — pills are informational
      });
    return () => {
      cancelled = true;
    };
  }, [prsUrl, prsEnabled]);

  if (!enabled) return null;

  const fetchedLabel = lastFetchedAt
    ? `fetched ${timeAgo(new Date(lastFetchedAt).toISOString())}`
    : "never fetched";

  return (
    <div
      className="h-[64px] shrink-0 flex items-center gap-[20px] px-[22px] bg-sidebar border-t border-border"
      data-testid="repo-status-bar"
    >
      <div className="flex items-center gap-[9px] min-w-0">
        <Github className="w-4 h-4 shrink-0 text-muted-foreground" />
        <div className="flex flex-col min-w-0">
          <span className="text-[12.5px] font-medium truncate">
            {repo ?? gitRepoPath?.split("/").filter(Boolean).pop() ?? "local repo"}
          </span>
          {error ? (
            // The hook resolves ahead/behind against this branch; when it
            // cannot (branch missing locally, git unreadable) it reports why
            // — surface that instead of a stale zero-count bar.
            <span
              data-testid="repo-status-error"
              className="font-mono text-[11px] text-destructive truncate"
              title={error}
            >
              {error}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-meta truncate">
              {`${branch} · ${fetchedLabel}`}
            </span>
          )}
        </div>
      </div>

      <span className="w-px h-4 bg-border shrink-0" />

      <div className="flex items-center gap-[14px] font-mono text-[11.5px] text-meta shrink-0">
        <span data-testid="repo-ahead">{`↑ ${ahead} to push`}</span>
        <span data-testid="repo-behind">{`↓ ${behind} behind`}</span>
        {worktreeCount !== null && (
          <span data-testid="repo-worktrees">
            {`${worktreeCount} ${worktreeCount === 1 ? "worktree" : "worktrees"}`}
          </span>
        )}
      </div>

      {prs.length > 0 && (
        <>
          <span className="w-px h-4 bg-border shrink-0" />
          <div className="flex items-center gap-[8px] min-w-0 overflow-hidden">
            {prs.map((pr) => (
              <PrBadge
                key={pr.id}
                status={pr.status as PrStatus}
                number={pr.number}
                url={pr.url}
              />
            ))}
          </div>
        </>
      )}

      <div className="ml-auto flex items-center gap-[8px] shrink-0">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            refresh();
            void loadPrs();
            void refreshWorktrees();
          }}
          disabled={loading}
          data-testid="repo-fetch-button"
          className="h-[29px] rounded-[8px] px-[12px] text-[12.5px] gap-[7px]"
        >
          <RefreshCw
            className={cn("w-[13px] h-[13px]", loading && "animate-spin motion-reduce:animate-none")}
          />
          Fetch
        </Button>
        <Button
          type="button"
          onClick={() => void push()}
          disabled={pushing || ahead === 0}
          data-testid="repo-push-button"
          className="h-[29px] rounded-[8px] px-[12px] text-[12.5px] font-medium gap-[7px]"
        >
          <GitMerge className="w-[13px] h-[13px]" />
          Push {branch}
        </Button>
      </div>
    </div>
  );
}
