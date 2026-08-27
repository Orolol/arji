"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { formatTokens } from "@/lib/utils/format-usage";
import type {
  PromptTokenBreakdown,
  LargestContextSection,
} from "@/lib/tokens/estimator";

export interface PromptTokenEstimateData {
  total: number;
  breakdown: PromptTokenBreakdown;
  budget: number | null;
  budgetExceeded: boolean;
  largestSection: LargestContextSection | null;
}

export interface PromptTokenEstimateViewProps {
  projectId: string;
  epicId?: string;
  userStoryId?: string;
  dispatchType?: "build" | "review" | "grading";
  reviewTypes?: string[];
  comment?: string;
  namedAgentId?: string | null;
  enabled?: boolean;
}

export function PromptTokenEstimateView({
  projectId,
  epicId,
  userStoryId,
  dispatchType = "build",
  reviewTypes,
  comment,
  namedAgentId,
  enabled = true,
}: PromptTokenEstimateViewProps) {
  const [estimate, setEstimate] = useState<PromptTokenEstimateData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || (!epicId && !userStoryId)) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`/api/projects/${projectId}/prompt-estimate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epicId,
          storyId: userStoryId,
          dispatchType,
          reviewTypes,
          comment,
          namedAgentId,
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (!cancelled && json?.data) {
            setEstimate(json.data);
          }
        })
        .catch(() => {
          // ignore network errors in estimate preview
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    projectId,
    epicId,
    userStoryId,
    dispatchType,
    reviewTypes ? reviewTypes.join(",") : "",
    comment,
    namedAgentId,
    enabled,
  ]);

  if (!enabled || (!epicId && !userStoryId)) {
    return null;
  }

  if (loading && !estimate) {
    return (
      <div
        className="rounded-[8px] border border-border bg-band/40 px-3 py-2 text-xs text-muted-foreground animate-pulse"
        data-testid="prompt-estimate-loading"
      >
        Estimating prompt tokens...
      </div>
    );
  }

  if (!estimate) {
    return null;
  }

  const { total, breakdown, budget, budgetExceeded, largestSection } = estimate;

  return (
    <div
      className="space-y-2 rounded-[8px] border border-border bg-band/30 p-2.5 text-xs"
      data-testid="prompt-token-estimate"
    >
      {/* Header with Total */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Estimated Prompt:</span>
          <span
            className="font-mono font-semibold"
            data-testid="prompt-estimate-total"
          >
            ~{formatTokens(total) ?? total} tokens
          </span>
        </div>
        {budget != null && (
          <span className="text-[11px] text-muted-foreground font-mono">
            Budget: {formatTokens(budget)}
          </span>
        )}
      </div>

      {/* Breakdown by context section */}
      <div
        className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 pt-1 text-[11px]"
        data-testid="prompt-estimate-breakdown"
      >
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">Spec:</span>
          <span className="font-mono font-medium">{formatTokens(breakdown.spec) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">Memory:</span>
          <span className="font-mono font-medium">{formatTokens(breakdown.memory) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">Ticket / Stories:</span>
          <span className="font-mono font-medium">{formatTokens(breakdown.ticket) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">Comments:</span>
          <span className="font-mono font-medium">{formatTokens(breakdown.comments) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">Findings:</span>
          <span className="font-mono font-medium">{formatTokens(breakdown.findings) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">Documents:</span>
          <span className="font-mono font-medium">{formatTokens(breakdown.documents) ?? 0}</span>
        </div>
      </div>

      {/* Budget warning banner if budget is exceeded */}
      {budgetExceeded && (
        <div
          className="mt-2 rounded-[6px] border border-priority-yellow/40 bg-priority-yellow/10 p-2 text-foreground"
          data-testid="prompt-budget-warning"
        >
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-priority-yellow mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-medium text-[11.5px] text-priority-yellow">
                Prompt token budget warning
              </p>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Estimated prompt (~{formatTokens(total)} tokens) exceeds the configured budget ({formatTokens(budget)} tokens).
                {largestSection && (
                  <> Largest section is <strong className="text-foreground">{largestSection.label}</strong> (~{formatTokens(largestSection.tokens)} tokens, {largestSection.percentage}%).</>
                )}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
