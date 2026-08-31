"use client";

import * as React from "react";

import { BreathingDot, Chrono } from "@/components/piscine";

/**
 * The white bubble that stands in for an assistant message still being written.
 *
 * `useChat` pushes an EMPTY assistant placeholder next to the optimistic user
 * message and accumulates `delta` into it — so the placeholder must stay in the
 * array. This renders in its place: the empty bubble the old `MessageList` drew
 * (an `animate-pulse` "...") said nothing about who was writing or for how long.
 *
 * State here is icon + word + motion, never colour: a breathing dot, a sentence,
 * and a ticking chrono. `BreathingDot` and `.stratum-live` are already
 * neutralised under `prefers-reduced-motion` in `app/globals.css`; `Chrono`
 * owns its own 1s interval, so elapsed is never formatted in a parent render.
 */
export interface TypingBubbleProps {
  /** `streamStatus` when the server sent one, else "<agent> rédige…". */
  label: string;
  /** ISO timestamp the send started at. Omitted before the first send. */
  startedAt?: string | null;
}

export function TypingBubble({ label, startedAt }: TypingBubbleProps) {
  return (
    <div
      data-testid="chat-typing"
      data-role="assistant"
      className="stratum-live flex items-center gap-2 self-start rounded-[14px] rounded-bl-[4px] bg-card px-[15px] py-[10px]"
    >
      <BreathingDot size={7} tone="live" />
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      {startedAt ? (
        // The frame's `4s` is 10px and dim, not the 21px live numeral Chrono
        // defaults to — hence the tone and the weight override.
        <Chrono
          startedAt={startedAt}
          size={10}
          tone="ink"
          className="font-normal text-muted-foreground"
        />
      ) : null}
    </div>
  );
}
