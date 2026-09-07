"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Hammer, Search, CheckCircle2, Loader2 } from "lucide-react";

interface UserStory {
  id: string;
  status: string;
}

interface UserStoryQuickActionsProps {
  projectId: string;
  story: UserStory;
  onRefresh: () => void;
  isLocked?: boolean;
  /** Defaults to the catalogue's `actions.locked` when the caller omits it. */
  lockReason?: string;
}

export function UserStoryQuickActions({
  projectId,
  story,
  onRefresh,
  isLocked = false,
  lockReason,
}: UserStoryQuickActionsProps) {
  const t = useTranslations("Epic");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actionsLocked = loading !== null || isLocked;
  const lockedTooltip = lockReason ?? t("actions.locked");

  const canSendToDev = ["todo", "in_progress"].includes(story.status);
  const canReview = story.status === "review" || story.status === "done";
  const canApprove = story.status === "review";

  if (!canSendToDev && !canReview && !canApprove) return null;

  async function handleSendToDev() {
    setLoading("dev");
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${story.id}/build`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error)
        throw new Error(data.error || t("actions.sendToDevError"));
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("actions.sendToDevError"));
    }
    setLoading(null);
  }

  async function handleReview() {
    setLoading("review");
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${story.id}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewTypes: ["code_review"] }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error)
        throw new Error(data.error || t("actions.reviewError"));
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("actions.reviewError"));
    }
    setLoading(null);
  }

  async function handleApprove() {
    setLoading("approve");
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${story.id}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error)
        throw new Error(data.error || t("actions.approveError"));
      // Story approval closes the story only — the epic closes through its
      // own merge (to_merge → done).
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("actions.approveError"));
    }
    setLoading(null);
  }

  return (
    <>
      {/* Stays visible outside the hover-gated action row so a failed
          action is not silently swallowed when the pointer leaves. */}
      {error && (
        <span
          role="alert"
          title={error}
          data-testid="story-quick-action-error"
          className="max-w-[200px] truncate text-[11px] text-destructive"
        >
          {error}
        </span>
      )}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {canSendToDev && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t("actions.sendToDev")}
              onClick={(e) => {
                e.preventDefault();
                handleSendToDev();
              }}
              disabled={actionsLocked}
            >
              {loading === "dev" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Hammer className="h-3 w-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isLocked ? lockedTooltip : t("actions.sendToDev")}
          </TooltipContent>
        </Tooltip>
      )}

      {canReview && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t("actions.codeReview")}
              onClick={(e) => {
                e.preventDefault();
                handleReview();
              }}
              disabled={actionsLocked}
            >
              {loading === "review" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Search className="h-3 w-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isLocked ? lockedTooltip : t("actions.codeReview")}
          </TooltipContent>
        </Tooltip>
      )}

      {canApprove && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-green-500 hover:text-green-600"
              aria-label={t("actions.approve")}
              onClick={(e) => {
                e.preventDefault();
                handleApprove();
              }}
              disabled={actionsLocked}
            >
              {loading === "approve" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isLocked ? lockedTooltip : t("actions.approve")}
          </TooltipContent>
        </Tooltip>
      )}
      </div>
    </>
  );
}
