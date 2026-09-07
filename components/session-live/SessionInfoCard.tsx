"use client";

import { useLocale, useTranslations } from "next-intl";
import { formatDateTime } from "@/lib/i18n/format";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import type { ReactNode } from "react";
import { Brain, Download, RefreshCw } from "lucide-react";

import {
  BandHeader,
  Mono,
  PillButton,
  StrataBand,
} from "@/components/piscine";
import { MEMORY_WRITER_AGENT_TYPES } from "@/lib/workflow/dreaming-constants";
import {
  describeProviderOptions,
  parseStoredProviderOptions,
  type DescribedProviderOption,
} from "@/lib/providers/options-registry";
import { formatTokens } from "@/lib/utils/format-usage";

import { OUTCOME_LABEL_KEYS } from "./labels";
import type { SessionDetail } from "./types";

/**
 * SESSION — the audit trail of the run, and the home of every session-level
 * action the 60px header has no room for.
 *
 * The frame's five rows (Agent / Model / Effort / Permissions / Started) are
 * the top five; everything the old key-value block carried follows in the same
 * rhythm, because a rail card is natural-height and losing a field would lose
 * a fact about the run.
 */

export interface SessionInfoCardProps {
  session: SessionDetail;
  providerLabel: string;
  isRunning: boolean;
  onRefresh: () => void;
  onExportLogs: () => void;
  onDistill: () => void;
  distilling: boolean;
  distillError: string | null;
}

/** One `label ......... value` line. Label dim, value ink. */
function KeyValueRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-[10px]">
      <span className="shrink-0 font-normal text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

/** Text value: Instrument Sans 12.5px semibold, ink. */
function TextValue({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-foreground">{children}</span>;
}

/**
 * The eight breakdown sections in the order the tests pin — a MODULE-SCOPE
 * COPY TABLE holding catalogue KEY REFERENCES (`lib/i18n/catalogue.ts`,
 * pattern 3).
 */
const BREAKDOWN_KEYS: ReadonlyArray<{ field: string; labelKey: TranslationKey }> =
  [
    { field: "spec", labelKey: "SessionLive.info.breakdownLabels.spec" },
    { field: "memory", labelKey: "SessionLive.info.breakdownLabels.memory" },
    { field: "ticket", labelKey: "SessionLive.info.breakdownLabels.ticket" },
    { field: "comments", labelKey: "SessionLive.info.breakdownLabels.comments" },
    { field: "findings", labelKey: "SessionLive.info.breakdownLabels.findings" },
    {
      field: "documents",
      labelKey: "SessionLive.info.breakdownLabels.documents",
    },
    { field: "system", labelKey: "SessionLive.info.breakdownLabels.system" },
    { field: "other", labelKey: "SessionLive.info.breakdownLabels.other" },
  ];

export function SessionInfoCard({
  session,
  providerLabel,
  isRunning,
  onRefresh,
  onExportLogs,
  onDistill,
  distilling,
  distillError,
}: SessionInfoCardProps) {
  const locale = useLocale();
  const t = useTranslations("SessionLive");
  // Namespace-less, for the KEY REFERENCES `labels.ts` and the provider option
  // registry hold.
  const tKey = useTranslations();
  /**
   * The parenthesised section breakdown of the dispatch-time token estimate.
   * The eight labels and their order are pinned by tests; the parse is wrapped
   * so a malformed row degrades to no breakdown rather than a blank screen.
   *
   * A closure rather than a module function: it composes four catalogue
   * strings, and closing over the card's two translators is what keeps their
   * next-intl key types intact.
   */
  const estimateBreakdown = (raw: string | null | undefined): string => {
    if (!raw) return "";
    try {
      const b = JSON.parse(raw);
      const parts = BREAKDOWN_KEYS.filter(({ field }) => b[field]).map(
        ({ field, labelKey }) =>
          t("info.breakdownPart", {
            label: tKey(labelKey),
            tokens: formatTokens(b[field]) ?? "",
          }),
      );
      return parts.length > 0
        ? t("info.breakdown", { parts: parts.join(t("info.breakdownSeparator")) })
        : "";
    } catch {
      return "";
    }
  };

  /**
   * One option's value: the catalogue word when the registry still names it,
   * the stored value otherwise, and "CLI default" when the option is unset.
   * "CLI default" is the registry's own semantic for an unset option — a real
   * answer, not a missing one, so it is not an em-dash.
   */
  const optionValue = (option: DescribedProviderOption | undefined): string => {
    if (!option) return t("info.cliDefault");
    return option.valueKey ? tKey(option.valueKey) : option.fallbackValue;
  };

  // Read from the SESSION ROW, never from the named agent: the agent can be
  // edited or deleted after the run and the trace has to stay true.
  const cliOptions = describeProviderOptions(
    session.provider,
    parseStoredProviderOptions(session.provider, session.cliOptions)
  );

  const effort = cliOptions.find(
    (option) => option.key === "effort" || option.key === "reasoning_effort"
  );
  const permissions = cliOptions.find(
    (option) => option.key === "permission_mode"
  );
  const otherOptions = cliOptions.filter(
    (option) => option !== effort && option !== permissions
  );

  const completedAt = session.endedAt || session.completedAt;
  const outcomeLabelKey = session.outcome
    ? OUTCOME_LABEL_KEYS[session.outcome]
    : undefined;

  const hasTokens =
    session.inputTokens != null || session.outputTokens != null;

  /* Mirrors evaluateDistillSourceEligibility, which the endpoint enforces:
     never a session that WROTE the memory (a distill of a distill has no
     source learnings), and never one that stopped to ask a question — those
     are `completed` too, but the agent is still waiting for a reply, so there
     is nothing settled to fold into a document every future prompt reads. */
  const canDistill =
    session.status === "completed" &&
    session.outcome !== "asked_question" &&
    !MEMORY_WRITER_AGENT_TYPES.includes(session.agentType ?? "");

  return (
    <StrataBand stratum="card" density="rail" gap={7}>
      <BandHeader
        label={t("info.label")}
        stratum="neutral"
        labelSize={12}
        standalone
      />

      <div className="flex flex-col gap-[5px] font-sans text-[12.5px]">
        <KeyValueRow label={t("info.rows.agent")}>
          <TextValue>{providerLabel}</TextValue>
        </KeyValueRow>

        {/* Only when a composite dispatched. A row reading "—" on every
            simple-agent run would add a permanent blank to the card for the
            sake of a fact that has no value there. */}
        {session.compositeAgentName ? (
          <KeyValueRow label={t("info.rows.composite")}>
            <TextValue>{session.compositeAgentName}</TextValue>
          </KeyValueRow>
        ) : null}

        <KeyValueRow label={t("info.rows.model")}>
          <Mono size={11.5}>{session.model ?? "—"}</Mono>
        </KeyValueRow>

        <KeyValueRow label={t("info.rows.effort")}>
          <TextValue>{optionValue(effort)}</TextValue>
        </KeyValueRow>

        <KeyValueRow label={t("info.rows.permissions")}>
          <TextValue>{optionValue(permissions)}</TextValue>
        </KeyValueRow>

        <KeyValueRow label={t("info.rows.started")}>
          <Mono size={11.5}>
            {session.startedAt
              ? formatDateTime(session.startedAt, { locale, style: "time" })
              : "—"}
          </Mono>
        </KeyValueRow>

        {/* Every other option in effect keeps its own row: "Thinking: High",
            "Advisor: on" and friends are part of the audit trail. */}
        {otherOptions.map((option) => (
          <KeyValueRow
            key={option.key}
            label={
              option.labelKey ? tKey(option.labelKey) : option.fallbackLabel
            }
          >
            <TextValue>{optionValue(option)}</TextValue>
          </KeyValueRow>
        ))}

        {outcomeLabelKey && (
          <KeyValueRow label={t("info.rows.outcome")}>
            <span
              className="font-semibold text-foreground"
              data-testid={`session-outcome-${session.outcome}`}
            >
              {tKey(outcomeLabelKey)}
            </span>
          </KeyValueRow>
        )}

        <KeyValueRow label={t("info.rows.completed")}>
          <Mono size={11.5}>
            {completedAt
              ? formatDateTime(completedAt, { locale, style: "dateTimeSeconds" })
              : isRunning
                ? t("info.inProgress")
                : "—"}
          </Mono>
        </KeyValueRow>

        <KeyValueRow label={t("info.rows.tokens")}>
          <div className="flex flex-col items-end gap-[2px]">
            <Mono size={11.5}>
              {hasTokens
                ? t("info.tokens", {
                    input: formatTokens(session.inputTokens) ?? "—",
                    output: formatTokens(session.outputTokens) ?? "—",
                  })
                : "—"}
            </Mono>
            {session.estimatedPromptTokens != null && (
              <span data-testid="session-estimated-tokens">
                <Mono size={11.5} tone="muted">
                  {t("info.estimatedInput", {
                    tokens: formatTokens(session.estimatedPromptTokens) ?? "",
                    breakdown: estimateBreakdown(
                      session.estimatedPromptBreakdown,
                    ),
                  })}
                </Mono>
              </span>
            )}
          </div>
        </KeyValueRow>

        {session.cliSessionId && (
          <KeyValueRow label={t("info.rows.cliSession")}>
            <Mono size={11.5} className="block truncate">
              {session.cliSessionId}
            </Mono>
          </KeyValueRow>
        )}

        {session.cliCommand && (
          <KeyValueRow label={t("info.rows.command")}>
            <Mono
              as="div"
              size={12}
              tone="muted"
              className="max-h-[80px] overflow-y-auto break-all whitespace-pre-wrap text-left"
            >
              {session.cliCommand}
            </Mono>
          </KeyValueRow>
        )}
      </div>

      <div className="flex flex-wrap gap-[8px]">
        {canDistill && (
          <PillButton
            variant="outline"
            outlineTone="neutral"
            size="sm"
            icon={Brain}
            onClick={onDistill}
            pending={distilling}
            pendingLabel={t("info.distilling")}
            title={t("info.distillTitle")}
          >
            {t("info.distill")}
          </PillButton>
        )}
        {session.logs && (
          <PillButton
            variant="outline"
            outlineTone="neutral"
            size="sm"
            icon={Download}
            onClick={onExportLogs}
          >
            {t("info.exportLogs")}
          </PillButton>
        )}
        <PillButton
          variant="outline"
          outlineTone="neutral"
          size="sm"
          icon={RefreshCw}
          onClick={onRefresh}
        >
          {t("info.refresh")}
        </PillButton>
      </div>

      {distillError && (
        <Mono size={11} tone="danger">
          {distillError}
        </Mono>
      )}
    </StrataBand>
  );
}
