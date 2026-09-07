"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { FieldBoxInput } from "@/components/agents-workshop/FieldBox";
import { ScopeSwitcher } from "@/components/agents-workshop/ScopeSwitcher";
import {
  BandHeader,
  CheckMark,
  FieldKicker,
  Mono,
  PillButton,
  StrataBand,
  SurfaceCard,
} from "@/components/piscine";
import { REVIEW_PROVIDER_SEGREGATION_SETTING_KEY } from "@/lib/agent-config/review-segregation-constants";
import {
  AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  agentMaxConcurrentSettingKey,
  formatMaxConcurrent,
  parseMaxConcurrentSetting,
} from "@/lib/agents/scheduler-constants";
import { formatReliabilityPercent } from "@/lib/agent-config/dispatch-reliability-constants";

/**
 * Runtime limits, and the review-bounce readout.
 *
 * Frame 7a has no picture of this page; the workshop's tab bar names it and
 * the deleted sheet owned the behaviour, so this is a functional port in the
 * band grammar.
 *
 * REVIEW BOUNCE LIVES HERE BECAUSE THERE IS NOWHERE ELSE. It came from the
 * sheet's Stats tab; /usage (frame 8d) has no such section and belongs to
 * another packet, so dropping it would silently delete a working readout. It
 * reads the untouched /api/agent-config/stats payload.
 */
export function LimitsView({ projectId }: { projectId?: string }) {
  const [scope, setScope] = useState<"global" | "project">(
    projectId ? "project" : "global",
  );
  const scopedProjectId = scope === "project" ? projectId : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[10px] overflow-y-auto px-[14px] pb-[14px]">
      <ScopeSwitcher
        projectId={projectId}
        scope={scope}
        onScopeChange={setScope}
      />
      <RuntimeBand scope={scope} projectId={projectId} />
      <ReviewBounceCard projectId={scopedProjectId} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

function RuntimeBand({
  scope,
  projectId,
}: {
  scope: "global" | "project";
  projectId?: string;
}) {
  const t = useTranslations("AgentsWorkshop");
  // null = not loaded yet, which is why the checkbox is disabled until it
  // resolves rather than showing an unchecked box that means nothing.
  const [segregation, setSegregation] = useState<boolean | null>(null);
  const [savingSegregation, setSavingSegregation] = useState(false);

  // Explicit values stored per settings key (null = key unset / inherits).
  const [maxConcurrent, setMaxConcurrent] = useState<{
    global: number | null;
    project: number | null;
  } | null>(null);
  const [savingMaxConcurrent, setSavingMaxConcurrent] = useState(false);

  const projectScoped = scope === "project" && !!projectId;
  const maxConcurrentKey = projectScoped
    ? agentMaxConcurrentSettingKey(projectId!)
    : AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY;

  /**
   * The typed value and the "saved / error" feedback are BOTH stamped with the
   * settings key they belong to, and read back only when the key still
   * matches. That is what re-seeds the field and clears the feedback when the
   * scope changes — the sheet did it with two `setState`-in-effect hooks, and
   * deriving is both the same behaviour and the reason this file needs no lint
   * suppression.
   */
  const [typed, setTyped] = useState<{ key: string; value: string } | null>(
    null,
  );
  const [feedback, setFeedback] = useState<{
    key: string;
    state: "saved" | "error";
  } | null>(null);

  const savedMaxConcurrent = maxConcurrent
    ? projectScoped
      ? maxConcurrent.project
      : maxConcurrent.global
    : null;
  const inheritedMaxConcurrent = projectScoped
    ? (maxConcurrent?.global ?? DEFAULT_MAX_CONCURRENT_AGENTS)
    : DEFAULT_MAX_CONCURRENT_AGENTS;
  /** What the scheduler will actually enforce for this scope right now. */
  const effectiveMaxConcurrent = savedMaxConcurrent ?? inheritedMaxConcurrent;

  // Unlimited round-trips as 0 — Infinity is neither a number-input value nor
  // valid JSON.
  const savedInputValue =
    savedMaxConcurrent === null
      ? ""
      : Number.isFinite(savedMaxConcurrent)
        ? String(savedMaxConcurrent)
        : "0";
  const maxConcurrentInput =
    typed && typed.key === maxConcurrentKey ? typed.value : savedInputValue;
  const status =
    feedback && feedback.key === maxConcurrentKey ? feedback.state : "idle";

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const value = json?.data?.[REVIEW_PROVIDER_SEGREGATION_SETTING_KEY];
        setSegregation(value === true || value === "true");

        const global = parseMaxConcurrentSetting(
          json?.data?.[AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY],
        );
        const project = projectId
          ? parseMaxConcurrentSetting(
              json?.data?.[agentMaxConcurrentSettingKey(projectId)],
            )
          : null;
        setMaxConcurrent({ global, project });
      })
      .catch(() => {
        if (cancelled) return;
        setSegregation(false);
        setMaxConcurrent({ global: null, project: null });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function toggleSegregation(next: boolean) {
    // Optimistic with rollback: the toggle answers instantly and restores the
    // previous value if the write is refused.
    const previous = segregation;
    setSegregation(next);
    setSavingSegregation(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [REVIEW_PROVIDER_SEGREGATION_SETTING_KEY]: next ? "true" : "false",
        }),
      });
      if (!res.ok) setSegregation(previous);
    } catch {
      setSegregation(previous);
    }
    setSavingSegregation(false);
  }

  const trimmedInput = maxConcurrentInput.trim();
  const parsedInput =
    trimmedInput === "" ? null : parseMaxConcurrentSetting(trimmedInput);
  const inputValid = trimmedInput === "" || parsedInput !== null;
  const maxConcurrentDirty =
    maxConcurrent !== null && parsedInput !== savedMaxConcurrent;

  /**
   * Persists the field. Called by the Save button, by Enter, AND on blur — a
   * number typed and left there is a change the user made, and losing it
   * silently is what made this setting look like it did nothing.
   */
  async function saveMaxConcurrent() {
    if (
      !maxConcurrent ||
      !inputValid ||
      !maxConcurrentDirty ||
      savingMaxConcurrent
    ) {
      return;
    }
    const nextValue = parsedInput;
    setSavingMaxConcurrent(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // null clears the key so the scope falls back to its inherited value.
        // Infinity is not valid JSON, so unlimited is stored as 0.
        body: JSON.stringify({
          [maxConcurrentKey]:
            nextValue === null
              ? null
              : Number.isFinite(nextValue)
                ? nextValue
                : 0,
        }),
      });
      if (res.ok) {
        setMaxConcurrent((prev) =>
          prev
            ? { ...prev, [projectScoped ? "project" : "global"]: nextValue }
            : prev,
        );
        setTyped(null);
        setFeedback({ key: maxConcurrentKey, state: "saved" });
      } else {
        setFeedback({ key: maxConcurrentKey, state: "error" });
      }
    } catch {
      // Keep the dirty input; the user can retry.
      setFeedback({ key: maxConcurrentKey, state: "error" });
    }
    setSavingMaxConcurrent(false);
  }

  return (
    <StrataBand stratum="land" density="full" gap={10}>
      <BandHeader
        stratum="land"
        labelSize={12}
        label={t("limits.runtimeLabel")}
        meta={t("limits.runtimeMeta")}
      />

      <SurfaceCard radius={12} className="flex items-start gap-3 px-4 py-3">
        <CheckMark
          shape="square"
          tone="action"
          checked={segregation === true}
          disabled={segregation === null || savingSegregation}
          onToggle={() => toggleSegregation(segregation !== true)}
        />
        <div className="flex flex-col gap-1">
          <span className="font-sans text-[13px] font-semibold text-foreground">
            {t("limits.segregationTitle")}
          </span>
          <p className="font-sans text-[12px] text-muted-foreground">
            {t("limits.segregationBody")}
          </p>
        </div>
      </SurfaceCard>

      <SurfaceCard radius={12} className="flex items-start gap-3 px-4 py-3">
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="agent-max-concurrent"
            className="cursor-pointer font-sans text-[13px] font-semibold text-foreground"
          >
            {t("limits.maxConcurrentTitle")}
          </label>
          <p className="font-sans text-[12px] text-muted-foreground">
            {projectScoped
              ? t("limits.maxConcurrentProjectBody", {
                  fallback: formatMaxConcurrent(inheritedMaxConcurrent),
                })
              : t("limits.maxConcurrentGlobalBody", {
                  fallback: formatMaxConcurrent(DEFAULT_MAX_CONCURRENT_AGENTS),
                })}
          </p>
          <p
            className="font-sans text-[12px] text-muted-foreground"
            data-testid="agent-max-concurrent-effective"
          >
            {maxConcurrent === null
              ? t("common.loading")
              : status === "error"
                ? t("limits.saveFailed")
                : t("limits.inEffect", {
                    value: formatMaxConcurrent(effectiveMaxConcurrent),
                    origin:
                      savedMaxConcurrent !== null
                        ? "explicit"
                        : projectScoped
                          ? "inherited"
                          : "builtin",
                    saved: status === "saved" ? "yes" : "no",
                  })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <FieldBoxInput
            mono
            id="agent-max-concurrent"
            type="number"
            min={0}
            step={1}
            value={maxConcurrentInput}
            onChange={(event) =>
              setTyped({ key: maxConcurrentKey, value: event.target.value })
            }
            // Enter and blur commit too: the Save button alone meant a typed
            // value could be lost without a word.
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveMaxConcurrent();
              }
            }}
            onBlur={() => void saveMaxConcurrent()}
            placeholder={formatMaxConcurrent(inheritedMaxConcurrent)}
            disabled={maxConcurrent === null || savingMaxConcurrent}
            className="w-24"
          />
          <PillButton
            variant="filled"
            size="sm"
            onClick={saveMaxConcurrent}
            disabled={!maxConcurrentDirty || !inputValid}
            pending={savingMaxConcurrent}
            pendingLabel={t("common.saving")}
          >
            {t("common.save")}
          </PillButton>
        </div>
      </SurfaceCard>
    </StrataBand>
  );
}

/* ------------------------------------------------------------------ */
/* Review bounce                                                       */
/* ------------------------------------------------------------------ */

interface ProjectReviewBounceRow {
  projectId: string;
  projectName: string | null;
  reviewedEpics: number;
  bounceTransitions: number;
  bounceRate: number | null;
}

function ReviewBounceCard({ projectId }: { projectId?: string }) {
  const t = useTranslations("AgentsWorkshop");
  // Stamped with the scope it was fetched for, so switching scope shows the
  // loading state again without the effect having to clear state synchronously
  // on the way in — and a slow response for the previous scope can never paint
  // over the current one.
  const [result, setResult] = useState<{
    key: string;
    rows: ProjectReviewBounceRow[];
    error: string | null;
  } | null>(null);
  const scopeKey = projectId ?? "";

  // Read into a plain string so the effect depends on the message rather than
  // on the translator identity, which changes on every render.
  const statsFailed = t("limits.statsFailed");

  useEffect(() => {
    let cancelled = false;
    const key = projectId ?? "";
    const query = projectId
      ? `?projectId=${encodeURIComponent(projectId)}`
      : "";
    fetch(`/api/agent-config/stats${query}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) {
          setResult({
            key,
            rows: [],
            error:
              typeof json.error === "string" ? json.error : statsFailed,
          });
        } else {
          setResult({
            key,
            rows: json.data?.reviewBounce ?? [],
            error: null,
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setResult({ key, rows: [], error: statsFailed });
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, statsFailed]);

  const current = result && result.key === scopeKey ? result : null;
  const rows = current ? current.rows : null;
  const error = current?.error ?? null;

  return (
    <SurfaceCard radius={12} className="flex flex-col gap-[10px] px-[18px] py-[14px]">
      <BandHeader
        stratum="neutral"
        labelSize={12}
        standalone
        label={t("limits.reviewBounceLabel")}
      />
      <p className="font-sans text-[12px] text-muted-foreground">
        {t("limits.reviewBounceBody")}
      </p>

      {error ? (
        <p role="alert" className="font-sans text-[12px] text-destructive">
          {error}
        </p>
      ) : null}

      {rows === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
      ) : rows.length === 0 ? (
        <p className="font-sans text-[12px] text-muted-foreground">
          {t("limits.reviewBounceEmpty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="pb-1 text-left">
                  <FieldKicker stratum="card" size={9.5}>
                    {t("limits.columns.project")}
                  </FieldKicker>
                </th>
                <th className="pb-1 text-right">
                  <FieldKicker stratum="card" size={9.5}>
                    {t("limits.columns.epicsReviewed")}
                  </FieldKicker>
                </th>
                <th className="pb-1 text-right">
                  <FieldKicker stratum="card" size={9.5}>
                    {t("limits.columns.bounces")}
                  </FieldKicker>
                </th>
                <th className="pb-1 text-right">
                  <FieldKicker stratum="card" size={9.5}>
                    {t("limits.columns.rate")}
                  </FieldKicker>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.projectId}>
                  <td className="py-1 text-left">
                    <span className="font-sans text-[12.5px] text-foreground">
                      {row.projectName ?? row.projectId}
                    </span>
                  </td>
                  <td className="py-1 text-right">
                    <Mono size={11}>{row.reviewedEpics}</Mono>
                  </td>
                  <td className="py-1 text-right">
                    <Mono size={11}>{row.bounceTransitions}</Mono>
                  </td>
                  <td className="py-1 text-right">
                    {/* An em-dash, never 0%, when nothing reached review. */}
                    <Mono size={11}>
                      {formatReliabilityPercent(row.bounceRate)}
                    </Mono>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SurfaceCard>
  );
}
