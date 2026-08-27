"use client";

import { Button } from "@/components/ui/button";
import { GitSyncBadge } from "@/components/kanban/GitSyncBadge";
import { PrBadge } from "@/components/github/PrBadge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils/format-date";
import {
  Loader2,
  GitMerge,
  GitPullRequest,
  Wrench,
  Upload,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  describeMergeBlocker,
  type MergeReadiness,
} from "@/lib/kanban/merge-readiness";

interface EpicGitSectionProps {
  projectId: string;
  branchName: string;
  epicStatus: string;
  githubConfigured: boolean;
  isRunning: boolean;
  ahead: number;
  behind: number;
  gitStatusLoading: boolean;
  gitStatusError: string | null;
  /** Epoch ms of the server's last successful `git fetch` for this repo. */
  lastFetchedAt?: number | null;
  /** Message from the last failed implicit fetch (offline, no remote, auth). */
  lastFetchError?: string | null;
  onRefreshGitStatus: () => void;
  onPush: () => void;
  pushing: boolean;
  pr: {
    status: "draft" | "open" | "closed" | "merged";
    number: number;
    url: string;
  } | null;
  prLoading: boolean;
  prError: string | null;
  onCreatePr: () => void;
  onSyncPr: () => void;
  merging: boolean;
  mergeError: string | null;
  onMerge: () => void;
  resolvingMerge: boolean;
  onOpenResolveMerge: () => void;
  mergeReadiness?: MergeReadiness | null;
}

const ROW_CLASS =
  "flex items-center justify-between gap-3 border-t border-border-soft py-[11px]";
const KEY_CLASS = "shrink-0 text-[12.5px] text-muted-foreground";

/**
 * Branch / git-sync / PR / merge UI for an epic, in the ticket panel's
 * key/value grammar. Pure presentation — all fetch state is owned by hooks
 * in the parent and passed down as props.
 */
export function EpicGitSection({
  projectId,
  branchName,
  epicStatus,
  githubConfigured,
  isRunning,
  ahead,
  behind,
  gitStatusLoading,
  gitStatusError,
  lastFetchedAt = null,
  lastFetchError = null,
  onRefreshGitStatus,
  onPush,
  pushing,
  pr,
  prLoading,
  prError,
  onCreatePr,
  onSyncPr,
  merging,
  mergeError,
  onMerge,
  resolvingMerge,
  onOpenResolveMerge,
  mergeReadiness,
}: EpicGitSectionProps) {
  const hasPersistedConflict = mergeReadiness?.blocker === "merge_conflict";

  const effectiveMergeError =
    mergeError ||
    (hasPersistedConflict
      ? describeMergeBlocker(mergeReadiness) || "Merge conflict with main"
      : null);

  return (
    <>
      <div className={ROW_CLASS}>
        <span className={KEY_CLASS}>Branch</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[12px]">{branchName}</span>
          {githubConfigured && (
            <GitSyncBadge
              projectId={projectId}
              branchName={branchName}
              disabled={isRunning}
            />
          )}
        </span>
      </div>

      {/* Git sync status — only shown when GitHub is configured */}
      {githubConfigured && (
        <div className={ROW_CLASS}>
          <span className={KEY_CLASS}>Sync</span>
          <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-[10px] gap-y-1">
            {gitStatusLoading ? (
              <span className="inline-flex items-center gap-1 font-mono text-[11.5px] text-meta">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking...
              </span>
            ) : (
              <>
                <span className="font-mono text-[11.5px] text-meta">
                  ↑ {ahead}
                </span>
                <span className="font-mono text-[11.5px] text-meta">
                  ↓ {behind}
                </span>
                {(lastFetchedAt !== null || lastFetchError) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          "font-mono text-[11.5px]",
                          lastFetchError ? "text-priority-yellow" : "text-meta",
                        )}
                      >
                        {lastFetchedAt !== null
                          ? `Synced ${timeAgo(new Date(lastFetchedAt).toISOString())}`
                          : "Never synced"}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {lastFetchError
                        ? `Could not fetch from remote: ${lastFetchError}`
                        : "Last successful fetch from the remote"}
                    </TooltipContent>
                  </Tooltip>
                )}
              </>
            )}

            {gitStatusError && (
              <span className="text-[12px] text-destructive">
                {gitStatusError}
              </span>
            )}

            <Button
              size="sm"
              variant="ghost"
              onClick={onRefreshGitStatus}
              disabled={gitStatusLoading}
              className="h-6 w-6 p-0"
              aria-label="Refresh git status"
            >
              <RefreshCw
                className={cn("h-3 w-3", gitStatusLoading && "animate-spin")}
              />
            </Button>

            {ahead > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={onPush}
                disabled={pushing || gitStatusLoading}
                className="h-[27px] rounded-[8px] text-[12.5px]"
              >
                {pushing ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Upload className="mr-1 h-3 w-3" />
                )}
                Push
              </Button>
            )}
          </span>
        </div>
      )}

      {/* PR row */}
      {githubConfigured && (
        <div className={ROW_CLASS}>
          <span className={KEY_CLASS}>Pull request</span>
          <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {pr ? (
              <>
                <PrBadge status={pr.status} number={pr.number} url={pr.url} />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onSyncPr}
                  disabled={prLoading}
                  className="h-6 px-2 text-[12.5px]"
                >
                  {prLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  <span className="ml-1">Sync</span>
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={onCreatePr}
                disabled={prLoading}
                className="h-[27px] rounded-[8px] text-[12.5px]"
              >
                {prLoading ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <GitPullRequest className="mr-1 h-3 w-3" />
                )}
                Create PR
              </Button>
            )}
            {prError && (
              <span className="text-[12px] text-destructive">{prError}</span>
            )}
          </span>
        </div>
      )}

      {(epicStatus === "review" || epicStatus === "done") && (
        <div className="flex justify-end pt-[11px]">
          <Button
            size="sm"
            variant="outline"
            onClick={onMerge}
            disabled={merging}
            className="h-[27px] rounded-[8px] text-[12.5px]"
          >
            {merging ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <GitMerge className="mr-1 h-3 w-3" />
            )}
            Merge into main
          </Button>
        </div>
      )}

      {effectiveMergeError && (
        <div className="flex items-center gap-2 pt-[8px]">
          <p className="flex-1 text-[12px] text-destructive">
            {effectiveMergeError}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={onOpenResolveMerge}
            disabled={resolvingMerge || isRunning}
            className="h-[27px] shrink-0 rounded-[8px] text-[12.5px]"
          >
            {resolvingMerge ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Wrench className="mr-1 h-3 w-3" />
            )}
            Resolve with Agent
          </Button>
        </div>
      )}
    </>
  );
}
