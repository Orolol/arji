"use client";

/**
 * One comment in the CONVERSATION band (frame 6a, lines 264-267).
 *
 * The frame draws only the agent bubble. The user variant is defined here:
 * the SAME geometry on the sunken `--field` paper instead of the agent's
 * crisp `--card` white. The difference is a surface, never a colour — the
 * design's first rule reserves colour for stratum and identity — and both
 * bubbles stay full-width: this is a work log, not a chat app, so the user's
 * messages are not right-aligned.
 *
 * Long build logs and review dumps collapse behind a word-boundary preview
 * (`lib/kanban/activity-feed.ts`), expandable in place.
 */

import * as React from "react";

import { Mono } from "@/components/piscine";
import { cn } from "@/lib/utils";
import { commentPreview, isLongComment } from "@/lib/kanban/activity-feed";
import type { TicketComment } from "@/hooks/useTicketComments";
import { timeAgo } from "@/lib/utils/format-date";

export interface CommentBubbleProps {
  comment: TicketComment;
}

export function CommentBubble({ comment }: CommentBubbleProps) {
  const [expanded, setExpanded] = React.useState(false);
  const isUser = comment.author === "user";
  const long = isLongComment(comment.content);
  const body = long && !expanded ? commentPreview(comment.content) : comment.content;

  return (
    <div
      data-testid="ticket-comment"
      data-author={comment.author}
      className={cn(
        "rounded-[12px] px-[13px] py-[10px]",
        isUser ? "bg-field" : "bg-card",
      )}
    >
      <Mono as="span" size={10} tone="muted" className="mb-1 block">
        {`${isUser ? "you" : "agent"} · ${timeAgo(comment.createdAt)}`}
      </Mono>
      <p className="m-0 text-[13px] leading-[1.5] whitespace-pre-wrap text-foreground">
        {body}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 border-0 bg-transparent p-0 font-sans text-[11.5px] text-strata-you-deep outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {expanded ? "moins" : "voir tout"}
        </button>
      ) : null}
    </div>
  );
}
