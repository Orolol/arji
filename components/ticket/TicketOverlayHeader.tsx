"use client";

/**
 * The overlay's pinned header row (frame 6a, lines 206-214).
 *
 * Left → right: project chip · ticket-id chip · LIVE stamp · title · chrono ·
 * Stop · `esc` keycap · ✕. Every child but the title is `shrink-0`; the title
 * is the only flexible one and clamps to a single line.
 *
 * NON-LIVE STATE: with no running session the stamp, the chrono and the Stop
 * pill are omitted entirely. No grey placeholder stamp, no `0s` chrono — a
 * ticket that is not running says so by having nothing to say.
 */

import * as React from "react";
import { StopCircle, X } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  Chrono,
  IdentityChip,
  KbdHint,
  PillButton,
  Stamp,
  type ProjectTone,
} from "@/components/piscine";
import { liveStampLabel } from "@/components/ticket/derive";

export interface TicketOverlayHeaderProps {
  projectLabel: string;
  ticketLabel: string;
  tone: ProjectTone;
  title: string;
  /** The active session's agent action, e.g. "build". Null when idle. */
  agentType: string | null;
  isRunning: boolean;
  startedAt: string | null;
  /** `UnifiedActivity.cancellable` — Stop only exists for a killable session. */
  cancellable: boolean;
  stopping?: boolean;
  onStop: () => void;
  onClose: () => void;
  titleId: string;
}

export function TicketOverlayHeader({
  projectLabel,
  ticketLabel,
  tone,
  title,
  agentType,
  isRunning,
  startedAt,
  cancellable,
  stopping = false,
  onStop,
  onClose,
  titleId,
}: TicketOverlayHeaderProps) {
  const t = useTranslations("Ticket");

  return (
    <div
      data-testid="ticket-overlay-header"
      className="flex shrink-0 items-center gap-[11px] px-5 pt-4 pb-[13px]"
    >
      <IdentityChip label={projectLabel} tone={tone} />
      <IdentityChip label={ticketLabel} tone={tone} />

      {isRunning ? (
        <Stamp tone="live" dot className="shrink-0">
          {liveStampLabel(agentType)}
        </Stamp>
      ) : null}

      <h2
        id={titleId}
        className="min-w-0 flex-1 line-clamp-1 font-display text-[19px] font-bold tracking-[-0.01em] text-foreground"
      >
        {title}
      </h2>

      {isRunning && startedAt ? (
        <Chrono startedAt={startedAt} size={19} tone="live" />
      ) : null}

      {isRunning && cancellable ? (
        <PillButton
          variant="outline"
          outlineTone="action"
          size="md"
          icon={StopCircle}
          onClick={onStop}
          pending={stopping}
          pendingLabel={t("header.stopping")}
          data-testid="ticket-overlay-stop"
        >
          {t("header.stop")}
        </PillButton>
      ) : null}

      <KbdHint>{t("header.escHint")}</KbdHint>

      <PillButton
        variant="filled"
        iconOnly
        icon={X}
        onClick={onClose}
        data-testid="ticket-overlay-close"
      >
        {t("header.close")}
      </PillButton>
    </div>
  );
}
