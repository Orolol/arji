"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Infinity as InfinityIcon, Loader2, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { cn } from "@/lib/utils";
import {
  AUTO_MODE_CONCURRENCY_RANGE,
  DEFAULT_AUTO_BUILD_CONCURRENCY,
  DEFAULT_AUTO_REVIEW_CONCURRENCY,
  parseAutoModeConcurrency,
} from "@/lib/auto-mode/constants";
import type { AutoModeStatus } from "@/lib/auto-mode/status";

interface AutoModeDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Named agent pre-selected from the board toolbar, if any. */
  defaultNamedAgentId?: string | null;
  onSaved?: (status: AutoModeStatus) => void;
  onError?: (message: string) => void;
}

/**
 * One key/value line of the options block — the NightRunDialog grammar
 * (11px vertical rhythm on a soft hairline), reused verbatim so the two
 * unattended-mode dialogs read as one family.
 */
function OptionRow({
  label,
  htmlFor,
  hint,
  last = false,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-t border-border-soft py-[11px]",
        last && "border-b"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="text-[12.5px] text-muted-foreground"
          >
            {label}
          </label>
        ) : (
          <span className="text-[12.5px] text-muted-foreground">{label}</span>
        )}
        <div className="flex shrink-0 items-center gap-[6px] text-[13px]">
          {children}
        </div>
      </div>
      {hint && <p className="text-[11.5px] text-meta">{hint}</p>}
    </div>
  );
}

/**
 * Configuration dialog for Full Auto Mode: an enable switch, a build agent +
 * build concurrency row, a review agent + review concurrency row, and a live
 * count of what the supervisor would pick up right now.
 *
 * The one piece of judgement it encodes: when build + review concurrency
 * exceeds the scheduler's `agent_max_concurrent` budget, it WARNS and does
 * nothing else. Silently raising the scheduler budget would let an unattended
 * mode rewrite a global safety setting the user chose.
 */
export function AutoModeDialog({
  projectId,
  open,
  onOpenChange,
  defaultNamedAgentId = null,
  onSaved,
  onError,
}: AutoModeDialogProps) {
  const t = useTranslations("AutoMode");
  const [status, setStatus] = useState<AutoModeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [buildAgent, setBuildAgent] = useState<string | null>(null);
  const [reviewAgent, setReviewAgent] = useState<string | null>(null);
  const [buildConcurrency, setBuildConcurrency] = useState<string>(
    String(DEFAULT_AUTO_BUILD_CONCURRENCY)
  );
  const [reviewConcurrency, setReviewConcurrency] = useState<string>(
    String(DEFAULT_AUTO_REVIEW_CONCURRENCY)
  );
  const [smartDispatch, setSmartDispatch] = useState(false);
  const [secondOpinion, setSecondOpinion] = useState(false);

  const applyStatus = useCallback(
    (next: AutoModeStatus, fallbackAgent: string | null) => {
      setStatus(next);
      setEnabled(next.enabled);
      setBuildAgent(next.buildAgent ?? fallbackAgent);
      setReviewAgent(next.reviewAgent);
      setBuildConcurrency(String(next.buildConcurrency));
      setReviewConcurrency(String(next.reviewConcurrency));
      setSmartDispatch(next.smartDispatch);
      setSecondOpinion(next.secondOpinion);
    },
    []
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);
    fetch(`/api/projects/${projectId}/auto-mode`)
      .then(async (r) => {
        // A 404/500 still carries a JSON body, so status has to be checked
        // explicitly — otherwise the dialog would sit on its defaults and let
        // Save write them over the real configuration.
        const body = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok || !body?.data) {
          setError(body?.error || t("errors.load"));
          return;
        }
        applyStatus(body.data as AutoModeStatus, defaultNamedAgentId);
      })
      .catch(() => {
        if (!cancelled) setError(t("errors.load"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, open, applyStatus, defaultNamedAgentId, t]);

  const buildBudget =
    parseAutoModeConcurrency(buildConcurrency) ?? DEFAULT_AUTO_BUILD_CONCURRENCY;
  const reviewBudget =
    parseAutoModeConcurrency(reviewConcurrency) ??
    DEFAULT_AUTO_REVIEW_CONCURRENCY;
  const schedulerBudget = status?.effectiveSchedulerBudget ?? null;
  const overBudget =
    schedulerBudget !== null && buildBudget + reviewBudget > schedulerBudget;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/auto-mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          buildAgent,
          reviewAgent,
          buildConcurrency: buildBudget,
          reviewConcurrency: reviewBudget,
          smartDispatch,
          secondOpinion,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        const message = data?.error || t("errors.save");
        setError(message);
        onError?.(message);
        return;
      }
      applyStatus(data.data as AutoModeStatus, defaultNamedAgentId);
      onSaved?.(data.data as AutoModeStatus);
      onOpenChange(false);
    } catch {
      const message = t("errors.save");
      setError(message);
      onError?.(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden rounded-[14px] border bg-card p-0 shadow-[0_18px_40px_rgba(58,48,44,.14)] sm:max-w-[520px]"
      >
        <DialogHeader className="flex-row items-center gap-[10px] space-y-0 border-b border-border-soft px-[24px] py-[20px] text-left">
          <InfinityIcon className="h-[17px] w-[17px] shrink-0" />
          <DialogTitle className="text-[16px] font-semibold leading-none">
            {t("dialog.title")}
          </DialogTitle>
          <DialogClose className="ml-auto rounded-[6px] text-meta transition-opacity hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <X className="h-4 w-4" />
            <span className="sr-only">{t("dialog.close")}</span>
          </DialogClose>
        </DialogHeader>

        <div className="flex flex-col gap-[20px] px-[24px] py-[22px]">
          <DialogDescription className="text-[13.5px] leading-[1.6] text-muted-foreground">
            {t("dialog.description")}
          </DialogDescription>

          <div className="flex flex-col gap-[8px] rounded-[11px] bg-band px-[16px] py-[14px]">
            <label className="flex cursor-pointer items-center gap-2 text-[13.5px] font-medium">
              <input
                type="checkbox"
                role="switch"
                data-testid="auto-mode-enabled"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border"
              />
              {t("dialog.runContinuously")}
            </label>
            <span
              className="text-[12.5px] text-muted-foreground"
              data-testid="auto-mode-candidates"
            >
              {loading
                ? t("dialog.loading")
                : status
                  ? t("dialog.candidates", {
                      build: status.candidates.build,
                      review: status.candidates.review,
                      merge: status.candidates.merge,
                    })
                  : "—"}
            </span>
            {status && (status.inFlight.build > 0 || status.inFlight.review > 0) && (
              <span className="text-[11.5px] text-meta">
                {t("dialog.inFlight", {
                  build: status.inFlight.build,
                  review: status.inFlight.review,
                })}
              </span>
            )}
          </div>

          <div className="flex flex-col">
            <OptionRow label={t("options.buildAgent")}>
              <NamedAgentSelect
                value={buildAgent}
                onChange={setBuildAgent}
                aria-label={t("options.buildAgent")}
                className="h-[28px] w-[186px] text-[13px]"
                dispatchRole="build"
              />
            </OptionRow>

            <OptionRow
              label={t("options.parallelBuilds")}
              htmlFor="auto-mode-build-concurrency"
              hint={t("options.parallelBuildsHint")}
            >
              <Input
                id="auto-mode-build-concurrency"
                data-testid="auto-mode-build-concurrency"
                type="number"
                min={AUTO_MODE_CONCURRENCY_RANGE.min}
                max={AUTO_MODE_CONCURRENCY_RANGE.max}
                className="h-[28px] w-[118px] rounded-[7px] text-right text-[13px]"
                value={buildConcurrency}
                onChange={(e) => setBuildConcurrency(e.target.value)}
              />
            </OptionRow>

            <OptionRow label={t("options.reviewAgent")}>
              <NamedAgentSelect
                value={reviewAgent}
                onChange={setReviewAgent}
                aria-label={t("options.reviewAgent")}
                className="h-[28px] w-[186px] text-[13px]"
                dispatchRole="review"
              />
            </OptionRow>

            <OptionRow
              label={t("options.parallelReviews")}
              htmlFor="auto-mode-review-concurrency"
              hint={t("options.parallelReviewsHint")}
            >
              <Input
                id="auto-mode-review-concurrency"
                data-testid="auto-mode-review-concurrency"
                type="number"
                min={AUTO_MODE_CONCURRENCY_RANGE.min}
                max={AUTO_MODE_CONCURRENCY_RANGE.max}
                className="h-[28px] w-[118px] rounded-[7px] text-right text-[13px]"
                value={reviewConcurrency}
                onChange={(e) => setReviewConcurrency(e.target.value)}
              />
            </OptionRow>

            <OptionRow
              label={t("options.smartDispatch")}
              hint={t("options.smartDispatchHint")}
            >
              <input
                type="checkbox"
                role="switch"
                data-testid="auto-mode-smart-dispatch"
                aria-label={t("options.smartDispatch")}
                checked={smartDispatch}
                onChange={(e) => setSmartDispatch(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border"
              />
            </OptionRow>

            <OptionRow
              label={t("options.secondOpinion")}
              hint={t("options.secondOpinionHint")}
              last
            >
              <input
                type="checkbox"
                role="switch"
                data-testid="auto-mode-second-opinion"
                aria-label={t("options.secondOpinion")}
                checked={secondOpinion}
                onChange={(e) => setSecondOpinion(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border"
              />
            </OptionRow>
          </div>

          {overBudget && (
            <div
              data-testid="auto-mode-budget-warning"
              role="status"
              aria-live="polite"
              className="flex gap-2 rounded-[11px] border border-border-soft bg-band p-[14px] text-[12px] leading-[1.55] text-muted-foreground"
            >
              <TriangleAlert className="h-4 w-4 shrink-0 text-priority-yellow" />
              <span>
                {t.rich("warning.budget", {
                  builds: buildBudget,
                  reviews: reviewBudget,
                  budget: schedulerBudget,
                  strong: (chunks) => <strong>{chunks}</strong>,
                  em: (chunks) => <em>{chunks}</em>,
                })}
              </span>
            </div>
          )}

          <div
            data-testid="auto-mode-warning"
            className="flex gap-2 rounded-[11px] border border-border-soft bg-band p-[14px] text-[12px] leading-[1.55] text-muted-foreground"
          >
            <TriangleAlert className="h-4 w-4 shrink-0 text-priority-yellow" />
            <span>
              {t.rich("warning.unattended", {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </span>
          </div>

          {error && (
            <p
              // Announced, not just coloured: the load/save failure is the one
              // thing a user must not miss before walking away from the board.
              role="alert"
              aria-live="assertive"
              className="text-[12.5px] text-destructive"
              data-testid="auto-mode-error"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-[10px] px-[24px] pb-[22px] sm:justify-end">
          <Button
            variant="outline"
            className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
            onClick={() => onOpenChange(false)}
          >
            {t("dialog.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            // No loaded status = nothing trustworthy to save over.
            disabled={saving || loading || !status}
            data-testid="auto-mode-save"
            className="h-[31px] rounded-[8px] px-[13px] text-[13px] font-medium"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <InfinityIcon className="h-4 w-4 mr-1" />
            )}
            {enabled ? t("dialog.start") : t("dialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
