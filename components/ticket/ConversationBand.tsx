"use client";

/**
 * CONVERSATION on the coral ground (frame 6a, lines 260-273).
 *
 * The comment list scrolls; the reply row is pinned and never collapses —
 * the reply IS the point of the band, so it survives an empty thread while
 * the counter simply disappears (`meta={undefined}`: BandHeader skips it).
 *
 * The reply pill takes the documented `fill="card"` exception: on the coral
 * ground the white card reads as a field, where the desk's `--field` fill
 * would disappear into the paper.
 *
 * The `@` in the placeholder is COPY, not a feature — there is no mention
 * autocomplete in this overlay and the frame shows no menu.
 */

import * as React from "react";
import { useTranslations } from "next-intl";
import { Send } from "lucide-react";

import {
  BandHeader,
  GhostInputPill,
  PillButton,
  StrataBand,
} from "@/components/piscine";
import type { TicketComment } from "@/hooks/useTicketComments";
import { CommentBubble } from "@/components/ticket/CommentBubble";

export interface ConversationBandProps {
  comments: TicketComment[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
}

export function ConversationBand({
  comments,
  draft,
  onDraftChange,
  onSend,
  sending,
  error,
}: ConversationBandProps) {
  const t = useTranslations("Ticket");

  return (
    <StrataBand
      stratum="you"
      density="rail"
      gap={9}
      className="shrink-0 pb-[14px]"
    >
      <BandHeader
        label={t("conversation.label")}
        stratum="you"
        className="gap-[10px]"
        meta={comments.length > 0 ? String(comments.length) : undefined}
      />

      {comments.length > 0 ? (
        <div className="flex max-h-[220px] min-h-0 flex-col gap-[9px] overflow-y-auto">
          {comments.map((comment) => (
            <CommentBubble key={comment.id} comment={comment} />
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="m-0 text-[12px] leading-[1.5] text-strata-you-deep">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-[10px]">
        <GhostInputPill
          fill="card"
          width="flex"
          value={draft}
          onChange={onDraftChange}
          onSubmit={onSend}
          disabled={sending}
          placeholder={t("conversation.placeholder")}
          aria-label={t("conversation.replyLabel")}
          data-testid="ticket-reply-input"
        />
        <PillButton
          variant="filled"
          size="lg"
          icon={Send}
          onClick={onSend}
          pending={sending}
          pendingLabel={t("conversation.sending")}
          data-testid="ticket-reply-send"
        >
          {t("conversation.send")}
        </PillButton>
      </div>
    </StrataBand>
  );
}
