"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Mono, PillButton, SurfaceCard } from "@/components/piscine";
import type { Conversation } from "@/hooks/useConversations";
import { isPersistentChatProvider } from "@/lib/agent-config/constants";
import { resolveLegacyConversationLabel } from "@/lib/chat/parity-contract";
import type { DeskProject } from "@/lib/control-desk/types";
import { formatRelative } from "@/lib/i18n/format";

/**
 * One row of the 300px conversation roster (frame 11a, left column).
 *
 * `SurfaceCard radius={14}` is not on offer — `SurfaceRadius` is 10 | 11 | 12 —
 * so the card takes `radius={12}` and the frame's 14 lands through `className`,
 * where twMerge keeps the later value. `selected` supplies the frame's 2px ink
 * border (the ONE 2px border on this screen) with no reflow.
 */
export interface ConversationRosterCardProps {
  conversation: Conversation;
  project: DeskProject | null;
  /** Resolved named agent / provider label. Never a raw id. */
  agentLabel: string;
  active: boolean;
  /** Epics this conversation has produced. The line is omitted at 0. */
  ticketCount: number;
  onSelect: () => void;
  /** Kill and re-warm the embedded CLI. Only for persistent providers. */
  onRestartPersistentSession?: () => void;
  /** Injected in tests so the age does not depend on the wall clock. */
  now?: number;
}

export function ConversationRosterCard({
  conversation,
  project,
  agentLabel,
  active,
  ticketCount,
  onSelect,
  onRestartPersistentSession,
  now,
}: ConversationRosterCardProps) {
  const title = resolveLegacyConversationLabel(
    conversation.type,
    conversation.label,
  );
  const shortName = project?.shortName?.toUpperCase() ?? "—";
  const locale = useLocale();
  const t = useTranslations("Chat");
  // An unreadable timestamp is an em dash upstream of the join, never a guess.
  const age = formatRelative(conversation.createdAt, { locale, now }) || "—";
  const meta = `${shortName} · ${agentLabel} · ${age}`;

  const persistent = isPersistentChatProvider(conversation.provider);
  const hot = conversation.persistentSessionState === "hot";

  return (
    <SurfaceCard
      radius={12}
      interactive
      selected={active}
      data-testid="chat-roster-card"
      data-active={active ? "" : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
      className="flex flex-col gap-[5px] rounded-[14px] px-[15px] py-[13px]"
    >
      <span className="line-clamp-1 text-[13.5px] font-semibold">{title}</span>
      <Mono size={10} tone="muted" clamp={1}>
        {meta}
      </Mono>

      {active && ticketCount > 0 ? (
        // Never "0 tickets": an empty count is a line that does not exist.
        <span className="line-clamp-1 text-[12px] text-muted-foreground">
          {t("roster.ticketsCreated", { count: ticketCount })}
        </span>
      ) : null}

      {active && (persistent || conversation.cliSessionId) ? (
        <div
          className="flex items-center gap-2 pt-[2px]"
          // The card itself is the select target; the restart button inside it
          // must not also re-select the row it already belongs to.
          onClick={(event) => event.stopPropagation()}
        >
          {persistent ? (
            // Testid + wording carried over from ChatWorkspaceHeader: the state
            // is the WORD, never a colour.
            <span data-testid="persistent-session-state">
              <Mono size={10} tone="muted">
                {hot ? t("roster.sessionWarm") : t("roster.sessionCold")}
              </Mono>
            </span>
          ) : (
            <span data-testid="linked-session-state">
              <Mono size={10} tone="muted">
                {t("roster.sessionLinked")}
              </Mono>
            </span>
          )}
          {persistent && onRestartPersistentSession ? (
            // Deliberately NOT disabled while the conversation is busy: killing
            // the embedded CLI is the recovery for a wedged turn, and a wedged
            // turn is exactly when the row stays "generating".
            <PillButton
              variant="outline"
              outlineTone="neutral"
              iconOnly
              icon={RotateCcw}
              aria-label={t("roster.restartSession")}
              className="ml-auto h-[24px] w-[24px]"
              onClick={onRestartPersistentSession}
            >
              {t("roster.restartSession")}
            </PillButton>
          ) : null}
        </div>
      ) : null}
    </SurfaceCard>
  );
}
