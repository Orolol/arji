"use client";

import { useLocale } from "next-intl";
import { formatDateTime } from "@/lib/i18n/format";
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
} from "@/lib/providers/options-registry";
import { formatTokens } from "@/lib/utils/format-usage";

import { OUTCOME_LABELS } from "./labels";
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
 * The parenthesised section breakdown of the dispatch-time token estimate.
 * The eight labels and their order are pinned by tests; the parse is wrapped
 * so a malformed row degrades to no breakdown rather than a blank screen.
 */
function estimateBreakdown(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const b = JSON.parse(raw);
    const parts: string[] = [];
    if (b.spec) parts.push(`Spec ${formatTokens(b.spec)}`);
    if (b.memory) parts.push(`Mem ${formatTokens(b.memory)}`);
    if (b.ticket) parts.push(`Ticket ${formatTokens(b.ticket)}`);
    if (b.comments) parts.push(`Comments ${formatTokens(b.comments)}`);
    if (b.findings) parts.push(`Findings ${formatTokens(b.findings)}`);
    if (b.documents) parts.push(`Docs ${formatTokens(b.documents)}`);
    if (b.system) parts.push(`System ${formatTokens(b.system)}`);
    if (b.other) parts.push(`Other ${formatTokens(b.other)}`);
    return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  } catch {
    return "";
  }
}

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
  // "CLI default" is the registry's own semantic for an unset option — a real
  // answer, not a missing one, so it is not an em-dash.
  const otherOptions = cliOptions.filter(
    (option) => option !== effort && option !== permissions
  );

  const completedAt = session.endedAt || session.completedAt;
  const outcomeLabel = session.outcome
    ? OUTCOME_LABELS[session.outcome]
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
      <BandHeader label="Session" stratum="neutral" labelSize={12} standalone />

      <div className="flex flex-col gap-[5px] font-sans text-[12.5px]">
        <KeyValueRow label="Agent">
          <TextValue>{providerLabel}</TextValue>
        </KeyValueRow>

        <KeyValueRow label="Model">
          <Mono size={11.5}>{session.model ?? "—"}</Mono>
        </KeyValueRow>

        <KeyValueRow label="Effort">
          <TextValue>{effort?.value ?? "CLI default"}</TextValue>
        </KeyValueRow>

        <KeyValueRow label="Permissions">
          <TextValue>{permissions?.value ?? "CLI default"}</TextValue>
        </KeyValueRow>

        <KeyValueRow label="Started">
          <Mono size={11.5}>
            {session.startedAt
              ? formatDateTime(session.startedAt, { locale, style: "time" })
              : "—"}
          </Mono>
        </KeyValueRow>

        {/* Every other option in effect keeps its own row: "Thinking: High",
            "Advisor: on" and friends are part of the audit trail. */}
        {otherOptions.map((option) => (
          <KeyValueRow key={option.key} label={option.label}>
            <TextValue>{option.value}</TextValue>
          </KeyValueRow>
        ))}

        {outcomeLabel && (
          <KeyValueRow label="Outcome">
            <span
              className="font-semibold text-foreground"
              data-testid={`session-outcome-${session.outcome}`}
            >
              {outcomeLabel}
            </span>
          </KeyValueRow>
        )}

        <KeyValueRow label="Completed">
          <Mono size={11.5}>
            {completedAt
              ? formatDateTime(completedAt, { locale, style: "dateTimeSeconds" })
              : isRunning
                ? "In progress..."
                : "—"}
          </Mono>
        </KeyValueRow>

        <KeyValueRow label="Tokens">
          <div className="flex flex-col items-end gap-[2px]">
            <Mono size={11.5}>
              {hasTokens
                ? `${formatTokens(session.inputTokens) ?? "—"} in · ${
                    formatTokens(session.outputTokens) ?? "—"
                  } out`
                : "—"}
            </Mono>
            {session.estimatedPromptTokens != null && (
              <span data-testid="session-estimated-tokens">
                <Mono size={11.5} tone="muted">
                  Estimated input: ~
                  {formatTokens(session.estimatedPromptTokens)} tokens
                  {estimateBreakdown(session.estimatedPromptBreakdown)}
                </Mono>
              </span>
            )}
          </div>
        </KeyValueRow>

        {session.cliSessionId && (
          <KeyValueRow label="CLI session">
            <Mono size={11.5} className="block truncate">
              {session.cliSessionId}
            </Mono>
          </KeyValueRow>
        )}

        {session.cliCommand && (
          <KeyValueRow label="Command">
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
            pendingLabel="Distilling..."
            title="Merge this session's learnings into the project memory"
          >
            Distill learnings
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
            Export Logs
          </PillButton>
        )}
        <PillButton
          variant="outline"
          outlineTone="neutral"
          size="sm"
          icon={RefreshCw}
          onClick={onRefresh}
        >
          Refresh
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
