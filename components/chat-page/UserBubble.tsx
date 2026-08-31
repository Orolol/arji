"use client";

import * as React from "react";

import { MarkdownContent } from "@/components/chat/MarkdownContent";
import type { ChatAttachment } from "@/hooks/useChat";

/**
 * What you said — pool blue, right-aligned, with the frame's 4px tail corner.
 *
 * DEVIATION, RECORDED: the frame paints the user text `#16324e`. There is no
 * token for that value, the house rule forbids coloured text except stratum
 * deeps, and inventing a `--strata-next-ink` is outside this packet. The bubble
 * uses `text-foreground` (ink `#2e2d28`) on the pool ground, which passes AA
 * comfortably in both themes and keeps the "text is ink or dim" rule intact.
 */
export interface UserBubbleProps {
  content: string;
  attachments?: ChatAttachment[];
  onOpenAttachment?: (attachment: ChatAttachment) => void;
}

export function UserBubble({
  content,
  attachments,
  onOpenAttachment,
}: UserBubbleProps) {
  return (
    <div
      data-role="user"
      className="flex max-w-[64%] flex-col gap-2 self-end rounded-[14px] rounded-br-[4px] bg-strata-next px-[15px] py-3 text-[13.5px] leading-[1.55] text-foreground"
    >
      {content ? <MarkdownContent content={content} /> : null}

      {attachments && attachments.length > 0 ? (
        // Lifted verbatim from `components/chat/MessageList.tsx` rather than
        // re-invented, so the two transcripts keep the same thumbnail shape.
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              onClick={() => onOpenAttachment?.(attachment)}
              className="block overflow-hidden rounded-[8px] border border-border transition-colors hover:border-border-strong motion-reduce:transition-none"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachment.url}
                alt={attachment.fileName}
                loading="lazy"
                className="max-h-48 max-w-64 bg-muted object-contain"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
