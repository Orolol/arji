"use client";

import { useTranslations } from "next-intl";

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
  const t = useTranslations("Kanban");
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
      // The hook's own failure wins; this is only the nameless-error fallback.
      onPushResult?.({
        success: false,
        error: e instanceof Error ? e.message : t("gitSync.pushFailed"),
      });
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-[11.5px] text-meta">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        <span>{t("gitSync.checking")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-[11.5px] text-destructive">
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
            <Badge
              variant="outline"
              className="h-[22px] gap-0.5 rounded-full px-[8px] font-mono text-[11px] text-meta"
            >
              <ArrowUp className="h-2.5 w-2.5" />
              {ahead}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {t("gitSync.ahead", { count: ahead, value: String(ahead) })}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Behind badge */}
      {behind > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="h-[22px] gap-0.5 rounded-full px-[8px] font-mono text-[11px] text-meta"
            >
              <ArrowDown className="h-2.5 w-2.5" />
              {behind}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {t("gitSync.behind", { count: behind, value: String(behind) })}
          </TooltipContent>
        </Tooltip>
      )}

      {/* In-sync indicator */}
      {ahead === 0 && behind === 0 && (
        <span className="font-mono text-[11px] text-meta">
          {t("gitSync.inSync")}
        </span>
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
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <Upload className="h-3 w-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {pushing
            ? t("gitSync.pushing")
            : ahead === 0
              ? t("gitSync.nothingToPush")
              : t("gitSync.push", { count: ahead, value: String(ahead) })}
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
        <TooltipContent>{t("gitSync.refresh")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
