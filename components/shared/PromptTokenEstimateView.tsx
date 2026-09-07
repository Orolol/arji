"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Sparkles } from "lucide-react";
import { formatTokens } from "@/lib/utils/format-usage";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import type {
  PromptTokenBreakdown,
  LargestContextSection,
} from "@/lib/tokens/estimator";

/**
 * The short name each per-session chip prints, as catalogue KEY REFERENCES
 * (`lib/i18n/catalogue.ts`, pattern 3) — an `id → key` choice is an explicit
 * map, never `t(`reviewType.${id}`)`. An unlisted review type keeps its raw
 * id with the underscore softened, which is data rather than copy.
 *
 * Three of the four are the review picker's own words. `compliance` is not:
 * this chip has room for "Compliance" and not for "Compliance /
 * Accessibility", and that shorter word is its own string.
 */
const PER_SESSION_LABEL_KEYS: Record<string, TranslationKey> = {
  security: "Shared.reviewTypes.security.label",
  code_review: "Shared.reviewTypes.codeReview.label",
  compliance: "Shared.promptEstimate.compliance",
  feature_review: "Shared.reviewTypes.featureReview.label",
};

export interface PromptTokenEstimateData {
  skipped?: boolean;
  skipReason?: string;
  total: number;
  breakdown: PromptTokenBreakdown;
  sessionsCount?: number;
  perSessionEstimates?: Array<{
    reviewType: string;
    tokens: number;
    breakdown: PromptTokenBreakdown;
  }>;
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
  enabled?: boolean;
}

export function PromptTokenEstimateView({
  projectId,
  epicId,
  userStoryId,
  dispatchType = "build",
  reviewTypes,
  comment,
  enabled = true,
}: PromptTokenEstimateViewProps) {
  const t = useTranslations("Shared");
  // The per-session table holds full dotted paths, so it resolves through the
  // namespace-less translator.
  const tKey = useTranslations();
  const [estimate, setEstimate] = useState<PromptTokenEstimateData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reviewTypesKey = reviewTypes ? reviewTypes.join(",") : "";

  useEffect(() => {
    if (!enabled || (!epicId && !userStoryId)) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      fetch(`/api/projects/${projectId}/prompt-estimate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epicId,
          storyId: userStoryId,
          dispatchType,
          reviewTypes: reviewTypesKey ? reviewTypesKey.split(",") : undefined,
          comment,
        }),
      })
        .then((res) => {
          if (!res.ok) {
            // Not copy: `error` is only ever read as a boolean below — the
            // failure branch draws its own sentence — so this string never
            // reaches the screen.
            throw new Error(`Estimate failed (${res.status})`);
          }
          return res.json();
        })
        .then((json) => {
          if (!cancelled && json?.data) {
            setEstimate(json.data);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            // Same as above: `error` is read as a flag, never printed.
            setError(err instanceof Error ? err.message : "Estimate unavailable");
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    projectId,
    epicId,
    userStoryId,
    dispatchType,
    reviewTypesKey,
    comment,
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
        {t("promptEstimate.loading")}
      </div>
    );
  }

  if (error && !estimate) {
    return (
      <div
        className="rounded-[8px] border border-border/50 bg-band/20 px-3 py-1.5 text-xs text-muted-foreground italic"
        data-testid="prompt-estimate-unavailable"
      >
        {t("promptEstimate.unavailable")}
      </div>
    );
  }

  if (!estimate) {
    return null;
  }

  if (estimate.skipped) {
    return (
      <div
        className="rounded-[8px] border border-border/50 bg-band/20 px-3 py-1.5 text-xs text-muted-foreground"
        data-testid="prompt-estimate-skipped"
      >
        {/* `skipReason` is the route's own words, not catalogue copy. */}
        {estimate.skipReason ?? t("promptEstimate.skipped")}
      </div>
    );
  }

  const { total, breakdown, budget, budgetExceeded, largestSection, sessionsCount = 1, perSessionEstimates } = estimate;

  return (
    <div
      className="space-y-2 rounded-[8px] border border-border bg-band/30 p-2.5 text-xs"
      data-testid="prompt-token-estimate"
    >
      {/* Header with Total */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
          <span>{t("promptEstimate.label")}</span>
          <span
            className="font-mono font-semibold"
            data-testid="prompt-estimate-total"
          >
            {t("promptEstimate.total", {
              tokens: formatTokens(total) ?? String(total),
            })}
            {sessionsCount > 1 && (
              <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                {t("promptEstimate.acrossSessions", { count: sessionsCount })}
              </span>
            )}
          </span>
        </div>
        {budget != null && (
          <span className="text-[11px] text-muted-foreground font-mono">
            {t("promptEstimate.budget", { tokens: formatTokens(budget) ?? "" })}
          </span>
        )}
      </div>
      {sessionsCount > 1 && perSessionEstimates && perSessionEstimates.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground"
          data-testid="prompt-estimate-per-session"
        >
          <span className="font-medium text-foreground">
            {t("promptEstimate.perSession")}
          </span>
          {perSessionEstimates.map((s) => (
            <span
              key={s.reviewType}
              className="inline-flex items-center gap-1 rounded bg-background/50 px-1.5 py-0.5 border border-border/40 font-mono"
            >
              <span>
                {PER_SESSION_LABEL_KEYS[s.reviewType]
                  ? tKey(PER_SESSION_LABEL_KEYS[s.reviewType])
                  : s.reviewType.replace("_", " ")}
                :
              </span>
              <span>~{formatTokens(s.tokens)}</span>
            </span>
          ))}
        </div>
      )}
      {/* Breakdown by context section */}
      <div
        className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1 text-[11px]"
        data-testid="prompt-estimate-breakdown"
      >
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">
            {t("promptEstimate.breakdown.spec")}
          </span>
          <span className="font-mono font-medium">{formatTokens(breakdown.spec) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">
            {t("promptEstimate.breakdown.memory")}
          </span>
          <span className="font-mono font-medium">{formatTokens(breakdown.memory) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">
            {t("promptEstimate.breakdown.ticket")}
          </span>
          <span className="font-mono font-medium">{formatTokens(breakdown.ticket) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">
            {t("promptEstimate.breakdown.comments")}
          </span>
          <span className="font-mono font-medium">{formatTokens(breakdown.comments) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">
            {t("promptEstimate.breakdown.findings")}
          </span>
          <span className="font-mono font-medium">{formatTokens(breakdown.findings) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">
            {t("promptEstimate.breakdown.documents")}
          </span>
          <span className="font-mono font-medium">{formatTokens(breakdown.documents) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">
            {t("promptEstimate.breakdown.system")}
          </span>
          <span className="font-mono font-medium">{formatTokens(breakdown.system) ?? 0}</span>
        </div>
        <div className="flex items-center justify-between rounded-[4px] bg-background/60 px-2 py-1 border border-border/50">
          <span className="text-muted-foreground">
            {t("promptEstimate.breakdown.other")}
          </span>
          <span className="font-mono font-medium">{formatTokens(breakdown.other) ?? 0}</span>
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
                {t("promptEstimate.budgetWarning.title")}
              </p>
              <p className="text-[11px] text-muted-foreground leading-tight">
                {t("promptEstimate.budgetWarning.body", {
                  total: formatTokens(total) ?? "",
                  budget: formatTokens(budget) ?? "",
                })}
                {largestSection && (
                  <>
                    {" "}
                    {/* `label` is the estimator's section name, not copy. */}
                    {t.rich("promptEstimate.budgetWarning.largest", {
                      label: largestSection.label,
                      tokens: formatTokens(largestSection.tokens) ?? "",
                      percentage: String(largestSection.percentage),
                      strong: (chunks) => (
                        <strong className="text-foreground">{chunks}</strong>
                      ),
                    })}
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
