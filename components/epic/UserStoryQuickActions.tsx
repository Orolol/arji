"use client";

import { useState } from "react";
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
  lockReason?: string;
}

export function UserStoryQuickActions({
  projectId,
  story,
  onRefresh,
  isLocked = false,
  lockReason = "Another agent is already running for this task.",
}: UserStoryQuickActionsProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const actionsLocked = loading !== null || isLocked;

  const canSendToDev = ["todo", "in_progress"].includes(story.status);
  const canReview = story.status === "review" || story.status === "done";
  const canApprove = story.status === "review";

  if (!canSendToDev && !canReview && !canApprove) return null;

  async function handleSendToDev() {
    setLoading("dev");
    try {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${story.id}/build`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      onRefresh();
    } catch {
      // silent
    }
    setLoading(null);
  }

  async function handleReview() {
    setLoading("review");
    try {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${story.id}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewTypes: ["code_review"] }),
        }
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      onRefresh();
    } catch {
      // silent
    }
    setLoading(null);
  }

  async function handleApprove() {
    setLoading("approve");
    try {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${story.id}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      onRefresh();
    } catch {
      // silent
    }
    setLoading(null);
  }

  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {canSendToDev && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
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
          <TooltipContent>{isLocked ? lockReason : "Send to Dev"}</TooltipContent>
        </Tooltip>
      )}

      {canReview && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
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
          <TooltipContent>{isLocked ? lockReason : "Code Review"}</TooltipContent>
        </Tooltip>
      )}

      {canApprove && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-green-500 hover:text-green-600"
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
          <TooltipContent>{isLocked ? lockReason : "Approve"}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
