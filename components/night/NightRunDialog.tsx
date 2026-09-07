"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Moon, TriangleAlert, X } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import { cn } from "@/lib/utils";
import {
  AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  formatMaxConcurrent,
  agentMaxConcurrentSettingKey,
  parseMaxConcurrentSetting,
} from "@/lib/agents/scheduler-constants";
import {
  DEFAULT_NIGHT_CIRCUIT_BREAKER,
  NIGHT_CIRCUIT_BREAKER_RANGE,
  NIGHT_CIRCUIT_BREAKER_SETTING_KEY,
  NIGHT_COST_CAP_SETTING_KEY,
  parseNightCircuitBreaker,
  parseNightCostCap,
} from "@/lib/night/constants";

interface ScopeEpic {
  id: string;
  title: string;
  status: string;
  readableId?: string | null;
}

export interface NightRunStartedResult {
  batchId: string;
  waves: number;
  totalEpics: number;
  message: string;
}

interface NightRunDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Named agent pre-selected from the board toolbar, if any. */
  defaultNamedAgentId?: string | null;
  onStarted?: (result: NightRunStartedResult) => void;
  onError?: (message: string) => void;
}

/**
 * Friendly copy for the guard codes the batch route can refuse with — a
 * module-scope copy table, so it holds catalogue KEY REFERENCES and the
 * dialog resolves them with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3). The codes are the SERVER's, so they
 * cannot be renamed into `…Key` fields.
 */
const CONFLICT_MESSAGE_KEYS: Record<string, TranslationKey> = {
  NIGHT_RUN_ACTIVE: "NightRuns.conflicts.nightRunActive",
  BATCH_ACTIVE: "NightRuns.conflicts.batchActive",
  PIPELINE_ACTIVE_ON_EPIC: "NightRuns.conflicts.pipelineActiveOnEpic",
};

/** How many scope ids the preview spells out before collapsing the rest. */
const SCOPE_ID_PREVIEW_LIMIT = 8;

/**
 * One key/value line of the options block: label left, live control right,
 * with an optional caveat underneath. Mirrors the ticket-panel grammar
 * (11px vertical rhythm on a soft hairline).
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
 * Confirm dialog for an unattended overnight run: picks the scope (To Do
 * epics, optionally Backlog too), previews the prerequisites the server will
 * pull in, collects the safety valves (failure policy, circuit breaker, cost
 * cap) and POSTs the batch build in `dag` + `pipeline` mode — the night
 * semantics of the existing batch route.
 */
export function NightRunDialog({
  projectId,
  open,
  onOpenChange,
  defaultNamedAgentId = null,
  onStarted,
  onError,
}: NightRunDialogProps) {
  const t = useTranslations("NightRuns");
  // The conflict-code table holds full dotted paths, so it resolves through
  // the namespace-less translator.
  const tKey = useTranslations();
  const [epics, setEpics] = useState<ScopeEpic[]>([]);
  const [loadingEpics, setLoadingEpics] = useState(false);
  const [includeBacklog, setIncludeBacklog] = useState(false);
  const [failurePolicy, setFailurePolicy] = useState<"halt" | "stop">("halt");
  const [circuitBreaker, setCircuitBreaker] = useState<string>(
    String(DEFAULT_NIGHT_CIRCUIT_BREAKER)
  );
  const [costCap, setCostCap] = useState<string>("");
  const [maxConcurrent, setMaxConcurrent] = useState<number>(
    DEFAULT_MAX_CONCURRENT_AGENTS
  );
  const [namedAgentId, setNamedAgentId] = useState<string | null>(
    defaultNamedAgentId
  );
  const [autoIncluded, setAutoIncluded] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Board epics: the scope is picked here rather than from the selection so
  // "Night run" works without selecting anything first.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingEpics(true);
    fetch(`/api/projects/${projectId}/epics`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setEpics(Array.isArray(d?.data) ? (d.data as ScopeEpic[]) : []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingEpics(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, open]);

  // Defaults for the two safety valves come from the global settings; the
  // parallelism budget is read (not set) here — it belongs to the scheduler.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const breaker = parseNightCircuitBreaker(
          d?.data?.[NIGHT_CIRCUIT_BREAKER_SETTING_KEY]
        );
        setCircuitBreaker(
          String(breaker ?? DEFAULT_NIGHT_CIRCUIT_BREAKER)
        );
        const cap = parseNightCostCap(d?.data?.[NIGHT_COST_CAP_SETTING_KEY]);
        setCostCap(cap == null ? "" : String(cap));
        const concurrency =
          parseMaxConcurrentSetting(
            d?.data?.[agentMaxConcurrentSettingKey(projectId)]
          ) ??
          parseMaxConcurrentSetting(
            d?.data?.[AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY]
          );
        setMaxConcurrent(concurrency ?? DEFAULT_MAX_CONCURRENT_AGENTS);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  useEffect(() => {
    if (open) setNamedAgentId(defaultNamedAgentId);
  }, [open, defaultNamedAgentId]);

  const scopeEpics = useMemo(() => {
    const wanted = includeBacklog
      ? new Set(["todo", "backlog"])
      : new Set(["todo"]);
    return epics.filter((e) => wanted.has(e.status));
  }, [epics, includeBacklog]);

  const scopeEpicIds = useMemo(
    () => scopeEpics.map((e) => e.id),
    [scopeEpics]
  );

  // Live preview of what the server will actually run: it re-expands the
  // scope with the transitive prerequisites (dropping done/released ones).
  const loadPreview = useCallback(async () => {
    if (scopeEpicIds.length === 0) {
      setAutoIncluded([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/projects/${projectId}/dependencies/transitive`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketIds: scopeEpicIds }),
        }
      );
      const json = await res.json();
      setAutoIncluded(
        Array.isArray(json?.data?.autoIncluded) ? json.data.autoIncluded : []
      );
    } catch {
      setAutoIncluded([]);
    }
  }, [projectId, scopeEpicIds]);

  useEffect(() => {
    if (!open) return;
    void loadPreview();
  }, [open, loadPreview]);

  async function handleConfirm() {
    if (scopeEpicIds.length === 0) return;
    setSubmitting(true);
    setError(null);

    const breaker = parseNightCircuitBreaker(circuitBreaker);
    const cap = parseNightCostCap(costCap);

    try {
      const res = await fetch(`/api/projects/${projectId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epicIds: scopeEpicIds,
          mode: "dag",
          pipeline: true,
          failurePolicy,
          namedAgentId,
          ...(breaker == null ? {} : { circuitBreaker: breaker }),
          ...(cap == null ? {} : { costCapUsd: cap }),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data?.error) {
        const conflictKey = data?.code
          ? CONFLICT_MESSAGE_KEYS[data.code as string]
          : undefined;
        const message =
          (conflictKey && tKey(conflictKey)) ||
          data?.error ||
          t("dialog.startFailed");
        setError(message);
        onError?.(message);
        return;
      }

      const waves = Number(data?.data?.waves ?? 0);
      const totalEpics = Number(
        data?.data?.totalEpics ?? scopeEpicIds.length
      );
      onStarted?.({
        batchId: String(data?.data?.batchId ?? ""),
        waves,
        totalEpics,
        message: t("dialog.started", { waves, count: totalEpics }),
      });
      onOpenChange(false);
    } catch {
      const message = t("dialog.startFailed");
      setError(message);
      onError?.(message);
    } finally {
      setSubmitting(false);
    }
  }

  const scopeLabel =
    scopeEpicIds.length === 0
      ? loadingEpics
        ? t("scope.loading")
        : includeBacklog
          ? t("scope.emptyWithBacklog")
          : t("scope.empty")
      : autoIncluded.length > 0
        ? t("scope.withPrerequisites", {
            count: scopeEpicIds.length,
            prerequisites: autoIncluded.length,
          })
        : t("scope.epics", { count: scopeEpicIds.length });

  // Mono id strip under the headline: what the run will actually pick up.
  const scopeIdList = useMemo(() => {
    if (scopeEpics.length === 0) return null;
    const ids = scopeEpics.map((e) => e.readableId || e.id);
    if (ids.length <= SCOPE_ID_PREVIEW_LIMIT) return ids.join(", ");
    const rest = ids.length - SCOPE_ID_PREVIEW_LIMIT;
    return t("scope.moreIds", {
      ids: ids.slice(0, SCOPE_ID_PREVIEW_LIMIT).join(", "),
      count: rest,
    });
  }, [scopeEpics, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden rounded-[14px] border bg-card p-0 shadow-[0_18px_40px_rgba(58,48,44,.14)] sm:max-w-[520px]"
      >
        <DialogHeader className="flex-row items-center gap-[10px] space-y-0 border-b border-border-soft px-[24px] py-[20px] text-left">
          <Moon className="h-[17px] w-[17px] shrink-0" />
          <DialogTitle className="text-[16px] font-semibold leading-none">
            {t("common.nightRun")}
          </DialogTitle>
          <DialogClose className="ml-auto rounded-[6px] text-meta transition-opacity hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <X className="h-4 w-4" />
            <span className="sr-only">{t("common.close")}</span>
          </DialogClose>
        </DialogHeader>

        <div className="flex flex-col gap-[20px] px-[24px] py-[22px]">
          <DialogDescription className="text-[13.5px] leading-[1.6] text-muted-foreground">
            {t("dialog.description")}
          </DialogDescription>

          <div className="flex flex-col gap-[8px] rounded-[11px] bg-band px-[16px] py-[14px]">
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              {t("scope.label")}
            </span>
            <span className="text-[13.5px]" data-testid="night-scope-preview">
              {scopeLabel}
            </span>
            {scopeIdList && (
              <span className="font-mono text-[11.5px] leading-[1.5] text-muted-foreground">
                {scopeIdList}
              </span>
            )}
            <p className="text-[11.5px] leading-[1.5] text-meta">
              {t("scope.note")}
            </p>
            <label className="mt-[2px] flex cursor-pointer items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                data-testid="night-include-backlog"
                checked={includeBacklog}
                onChange={(e) => setIncludeBacklog(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border"
              />
              {t("scope.includeBacklog")}
            </label>
          </div>

          <div className="flex flex-col">
            <OptionRow label={t("options.agent")}>
              <NamedAgentSelect
                value={namedAgentId}
                onChange={setNamedAgentId}
                className="h-[28px] w-[186px] text-[13px]"
                dispatchRole="build"
              />
            </OptionRow>

            {/* Night runs always schedule as dependency waves — shown so the
                order is legible, not because it is configurable here. */}
            <OptionRow label={t("options.order")}>
              <span className="text-[13px]">{t("options.waves")}</span>
            </OptionRow>

            <OptionRow label={t("options.onFailure")} htmlFor="night-failure-policy">
              <Select
                value={failurePolicy}
                onValueChange={(v) => setFailurePolicy(v as "halt" | "stop")}
              >
                <SelectTrigger
                  id="night-failure-policy"
                  className="h-[28px] w-[186px] rounded-[7px] text-[13px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="halt">
                    {t("options.failureHalt")}
                  </SelectItem>
                  <SelectItem value="stop">
                    {t("options.failureStop")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </OptionRow>

            {/* Read-only: the scheduler's budget, set in Agent
                Configuration → Advanced settings → Runtime → Max concurrent agents. */}
            <OptionRow label={t("options.parallelAgents")}>
              <span className="font-mono text-[13px]">
                {formatMaxConcurrent(maxConcurrent)}
              </span>
            </OptionRow>

            <OptionRow
              label={t("options.costCap")}
              htmlFor="night-cost-cap"
              hint={t("options.costCapHint")}
            >
              <Input
                id="night-cost-cap"
                data-testid="night-cost-cap"
                type="number"
                min={0}
                step="0.5"
                className="h-[28px] w-[118px] rounded-[7px] text-right text-[13px]"
                placeholder={t("options.costCapPlaceholder")}
                value={costCap}
                onChange={(e) => setCostCap(e.target.value)}
              />
            </OptionRow>

            <OptionRow
              label={t("options.circuitBreaker")}
              htmlFor="night-circuit-breaker"
              hint={t("options.circuitBreakerHint")}
              last
            >
              <Input
                id="night-circuit-breaker"
                data-testid="night-circuit-breaker"
                type="number"
                min={NIGHT_CIRCUIT_BREAKER_RANGE.min}
                max={NIGHT_CIRCUIT_BREAKER_RANGE.max}
                className="h-[28px] w-[118px] rounded-[7px] text-right text-[13px]"
                value={circuitBreaker}
                onChange={(e) => setCircuitBreaker(e.target.value)}
              />
            </OptionRow>
          </div>

          <div
            data-testid="night-run-warning"
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
              className="text-[12.5px] text-destructive"
              data-testid="night-run-error"
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
            onClick={handleConfirm}
            disabled={submitting || scopeEpicIds.length === 0}
            data-testid="night-run-confirm"
            className="h-[31px] rounded-[8px] px-[13px] text-[13px] font-medium"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Moon className="h-4 w-4 mr-1" />
            )}
            {t("dialog.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
