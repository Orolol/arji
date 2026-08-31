"use client";

import * as React from "react";

import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { Mono } from "@/components/piscine";

/**
 * What the agent said — a white card on the left, with the mono kicker naming
 * WHICH agent (frame 11a draws `OPUS PLANNER`).
 *
 * The frame's kicker is 9.5px; `Mono size={10}` is the system-normalised value
 * and 9.5 is the absolute floor for uppercase tracked labels, so 10 ships.
 */
export interface AgentBubbleProps {
  agentLabel: string;
  content: string;
}

export function AgentBubble({ agentLabel, content }: AgentBubbleProps) {
  return (
    <div
      data-role="assistant"
      className="flex max-w-[76%] flex-col gap-2 self-start rounded-[14px] rounded-bl-[4px] bg-card px-4 py-[13px]"
    >
      <Mono size={10} weight={700} uppercase tracking={0.08} tone="muted">
        {agentLabel}
      </Mono>
      <div className="text-[13.5px] leading-[1.6] text-foreground">
        <MarkdownContent content={content} />
      </div>
    </div>
  );
}
