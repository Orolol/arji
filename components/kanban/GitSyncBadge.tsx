"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGitStatus } from "@/hooks/useGitStatus";
import {
  ArrowUp,
  ArrowDown,
  Upload,
  Loader2,
  RefreshCw,
  AlertCircle,
} from "lucide-react";

interface GitSyncBadgeProps {
  projectId: string;
  branchName: string;
  githubConfigured?: boolean;
  disabled?: boolean;
  onPushResult?: (result: { success: boolean; error?: string }) => void;
}

/**
 * Displays ahead/behind badge counts for a branch and provides
 * a Push to Remote button with loading and feedback states.
 */
export function GitSyncBadge({
  projectId,
  branchName,
  githubConfigured = true,
  disabled = false,
  onPushResult,
}: GitSyncBadgeProps) {
  const {
    ahead,
    behind,
    loading,
    pushing,
    error,
    push,
    refresh,
  } = useGitStatus(projectId, branchName, githubConfigured);

  async function handlePush() {
    try {
      await push();
      onPushResult?.({ success: true });
    } catch (e) {
      onPushResult?.({ success: false, error: e instanceof Error ? e.message : "Push failed" });
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Checking sync...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertCircle className="h-3 w-3" />
        <span className="truncate max-w-[200px]">{error}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={refresh}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* Ahead badge */}
      {ahead > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 gap-0.5">
              <ArrowUp className="h-2.5 w-2.5" />
              {ahead}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {ahead} commit{ahead !== 1 ? "s" : ""} ahead of remote
          </TooltipContent>
        </Tooltip>
      )}

      {/* Behind badge */}
      {behind > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 gap-0.5">
              <ArrowDown className="h-2.5 w-2.5" />
              {behind}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {behind} commit{behind !== 1 ? "s" : ""} behind remote
          </TooltipContent>
        </Tooltip>
      )}

      {/* In-sync indicator */}
      {ahead === 0 && behind === 0 && (
        <span className="text-[10px] text-muted-foreground">in sync</span>
      )}

      {/* Push button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={handlePush}
            disabled={ahead === 0 || disabled || pushing}
          >
            {pushing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Upload className="h-3 w-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {pushing
            ? "Pushing..."
            : ahead === 0
              ? "Nothing to push"
              : `Push ${ahead} commit${ahead !== 1 ? "s" : ""} to remote`}
        </TooltipContent>
      </Tooltip>

      {/* Refresh button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh sync status</TooltipContent>
      </Tooltip>
    </div>
  );
}
