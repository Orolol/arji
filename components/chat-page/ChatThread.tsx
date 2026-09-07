"use client";

import * as React from "react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { QuestionCards } from "@/components/chat/QuestionCards";
import { ImageLightbox, type LightboxImage } from "@/components/shared/ImageLightbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFeedAutoScroll } from "@/hooks/useFeedAutoScroll";
import type { ChatMessage } from "@/hooks/useChat";
import type { QuestionData } from "@/lib/claude/spawn";
import type { ProjectTone } from "@/lib/piscine/tokens";

import { AgentBubble } from "./AgentBubble";
import { DraftedEpicCard, type EpicCreateStatus } from "./DraftedEpicCard";
import type { ParsedEpic } from "./message-epics";
import { TypingBubble } from "./TypingBubble";
import { UserBubble } from "./UserBubble";

/**
 * The centre column's scrolling transcript.
 *
 * SCROLL ANCHORING IS FIXED HERE, NOT PRESERVED. `components/chat/MessageList`
 * calls `bottomRef.scrollIntoView({behavior:"smooth"})` on every `messages`
 * change, which yanks a reader out of history on every streamed token. The
 * correct behaviour already exists as `hooks/useFeedAutoScroll` (shipped on the
 * ticket comment thread): follow only while the reader is within 80px of the
 * bottom, re-pin through a ResizeObserver on both the content and the viewport
 * so late-settling markdown and images do not leave the feed short.
 *
 * THE RADIX SCROLLAREA IS LOAD-BEARING. `useFeedAutoScroll` walks up to
 * `[data-radix-scroll-area-viewport]` and is a NO-OP outside one: swap this for
 * a plain `overflow-auto` div and the feed silently opens on its oldest
 * message, with nothing failing anywhere.
 */
export interface ChatThreadResolvedTicket {
  readableId: string | null;
  placement: string | null;
}

export interface ChatThreadProps {
  projectId: string;
  messages: readonly ChatMessage[];
  loading: boolean;
  /** `useChat.sending` — a stream is open right now. */
  sending: boolean;
  /** Server-sent status line, when there is one. */
  streamStatus: string | null;
  /** Resolved agent name; the bubble kicker uppercases it. */
  agentLabel: string;
  /** ISO timestamp of the current send, for the typing chrono. */
  sendStartedAt: string | null;
  /** message id → the epic that message declares. Memoise upstream. */
  epicsByMessage: ReadonlyMap<string, ParsedEpic>;
  /** message id → the real epic it has been bound to. */
  epicIdByMessage: ReadonlyMap<string, string>;
  /** Desk lookup for a bound epic's readable id and placement note. */
  resolveTicket: (epicId: string) => ChatThreadResolvedTicket;
  tone: ProjectTone;
  namedAgentId: string | null;
  onEpicCreated: (
    messageId: string,
    created: {
      epicId: string;
      readableId: string | null;
      status: EpicCreateStatus;
    },
  ) => void;
  onOpenTicket: (epicId: string) => void;
  onToast: (tone: "success" | "error", message: string) => void;
  /** `epicError || specError || chatError`, already collapsed to one string. */
  error?: string | null;
  pendingQuestions: QuestionData[] | null;
  onAnswerQuestions: (formatted: string) => void;
  /** `sending || conversation.status === "generating"`. */
  busy: boolean;
  /** Copy for a conversation with no messages yet. */
  emptyMessage: string;
  /** The conversation's next-step chips, pinned under the last message. */
  footer?: React.ReactNode;
}

export function ChatThread({
  projectId,
  messages,
  loading,
  sending,
  streamStatus,
  agentLabel,
  sendStartedAt,
  epicsByMessage,
  epicIdByMessage,
  resolveTicket,
  tone,
  namedAgentId,
  onEpicCreated,
  onOpenTicket,
  onToast,
  error,
  pendingQuestions,
  onAnswerQuestions,
  busy,
  emptyMessage,
  footer,
}: ChatThreadProps) {
  const t = useTranslations("Chat");
  const scrollRef = useFeedAutoScroll(messages.length);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(
    null,
  );

  const typingLabel =
    streamStatus ||
    t("thread.typing", { agent: agentLabel || t("thread.typingAgentFallback") });

  return (
    <div
      data-testid="chat-thread"
      className="flex min-h-0 flex-1 flex-col gap-[10px]"
    >
      {error ? (
        // The ONE place coral appears on this screen.
        <div
          data-testid="chat-error"
          className="shrink-0 rounded-[10px] border-[1.5px] border-destructive/50 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
        >
          {error}
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-testid="chat-thread-content"
          className="flex flex-col gap-3 px-2 py-[6px]"
        >
          {messages.length === 0 && !loading ? (
            <span className="px-2 py-8 text-center text-[13.5px] text-muted-foreground">
              {emptyMessage}
            </span>
          ) : null}

          {messages.map((message) => {
            if (message.role === "user") {
              return (
                <UserBubble
                  key={message.id}
                  content={message.content}
                  attachments={message.attachments}
                  onOpenAttachment={(attachment) =>
                    setLightboxImage({
                      url: attachment.url,
                      alt: attachment.fileName,
                    })
                  }
                />
              );
            }

            if (!message.content.trim()) {
              // The empty assistant placeholder `useChat` pushes beside the
              // optimistic user message. It must STAY in the array — the
              // `delta` accumulator targets it — so it is rendered as the
              // typing bubble rather than as an empty white card.
              return sending ? (
                <TypingBubble
                  key={message.id}
                  label={typingLabel}
                  startedAt={sendStartedAt}
                />
              ) : null;
            }

            const parsed = epicsByMessage.get(message.id);
            const boundEpicId = epicIdByMessage.get(message.id) ?? null;
            const resolved = boundEpicId
              ? resolveTicket(boundEpicId)
              : { readableId: null, placement: null };

            return (
              <React.Fragment key={message.id}>
                <AgentBubble
                  agentLabel={agentLabel.toUpperCase()}
                  content={message.content}
                />
                {parsed ? (
                  <DraftedEpicCard
                    projectId={projectId}
                    epic={parsed}
                    tone={tone}
                    epicId={boundEpicId}
                    readableId={resolved.readableId}
                    placement={resolved.placement}
                    namedAgentId={namedAgentId}
                    onCreated={(created) => onEpicCreated(message.id, created)}
                    onOpenTicket={onOpenTicket}
                    onToast={onToast}
                  />
                ) : null}
              </React.Fragment>
            );
          })}

          {pendingQuestions ? (
            <div data-testid="chat-questions" className="self-stretch">
              <QuestionCards
                questions={pendingQuestions}
                onSubmit={onAnswerQuestions}
                disabled={busy}
              />
            </div>
          ) : null}

          {footer}
        </div>
      </ScrollArea>

      <ImageLightbox
        image={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />
    </div>
  );
}
