import * as React from "react";

import { Mono } from "@/components/piscine";

/**
 * "LE CHAT SAIT" — the sunken card at the foot of the roster (frame 11a).
 *
 * `bg-muted` is the frame's `#f0ecda`: a card that sits BELOW the paper rather
 * than above it, which is what marks it as a note about the screen instead of
 * one more conversation you could click. `mt-auto` is what pins it to the
 * bottom of the column.
 */
export function ChatKnowsCard() {
  return (
    <div
      data-testid="chat-knows-card"
      className="mt-auto flex shrink-0 flex-col gap-[5px] rounded-[14px] bg-muted px-[15px] py-[12px]"
    >
      <Mono size={10} weight={700} uppercase tracking={0.08} tone="muted">
        LE CHAT SAIT
      </Mono>
      <span className="text-[12px] leading-[1.5] text-muted-foreground">
        spec du projet, mémoire, tickets ouverts — cite un doc avec{" "}
        <Mono size={11} tone="muted">
          @
        </Mono>
      </span>
    </div>
  );
}
