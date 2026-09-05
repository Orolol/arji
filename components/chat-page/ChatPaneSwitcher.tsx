"use client";

import * as React from "react";

import { SegmentedControl } from "@/components/piscine";
import { cn } from "@/lib/utils";

/**
 * The chat page's one-pane control, and it exists ONLY below `lg` (B-arij-180).
 *
 * Frame 11a is three columns — the roster at 300px, the thread and its
 * composer, the context rail at 300px. That is 600px of fixed flanks before
 * the thread asks for a pixel, so on a 390px phone the roster took the screen
 * and the thread, the composer and the rail were all off it. Three columns do
 * not become one by shrinking; below `lg` the page shows ONE pane and this rail
 * is how you reach the other two.
 *
 * IT IS NOT A SECOND CONTROL ROW. `ChatPageView`'s header comment is right
 * that the frame draws exactly one per-screen control (the project pill in the
 * composer) — and it still does at every width the frame was drawn for. This
 * is `lg:hidden`: from 1024px up it is `display: none`, the three columns are
 * back, and the desktop screen is byte-for-byte what it was.
 *
 * The panes are HIDDEN, never unmounted. `display: none` keeps the roster's
 * scroll position, the rail's token reads and the composer's staged
 * attachments alive across a switch, and it takes the hidden pane's controls
 * out of the tab order for free — so the keyboard path is always the pane you
 * are actually looking at.
 */

export type ChatPane = "conversations" | "thread" | "context";

/** The default pane: the thread is what the page is FOR. */
export const DEFAULT_CHAT_PANE: ChatPane = "thread";

const OPTIONS: { value: ChatPane; label: string }[] = [
  { value: "conversations", label: "Conversations" },
  { value: "thread", label: "Fil" },
  { value: "context", label: "Contexte" },
];

/**
 * `display` for one pane: the chosen one below `lg`, all three from `lg`.
 *
 * Returned as a class rather than a boolean because the desktop layout must
 * not depend on React state at all — `lg:flex` restores the three columns
 * whatever `pane` happens to be, so resizing a window never strands a user on
 * a layout their viewport outgrew.
 */
export function chatPaneClass(pane: ChatPane, self: ChatPane): string {
  return pane === self ? "flex" : "hidden lg:flex";
}

export interface ChatPaneSwitcherProps {
  pane: ChatPane;
  onChange: (pane: ChatPane) => void;
  className?: string;
}

export function ChatPaneSwitcher({
  pane,
  onChange,
  className,
}: ChatPaneSwitcherProps) {
  return (
    <div
      data-testid="chat-pane-switcher"
      className={cn("shrink-0 lg:hidden", className)}
    >
      <SegmentedControl
        options={OPTIONS}
        value={pane}
        onChange={onChange}
        size="sm"
        aria-label="Panneau du chat"
      />
    </div>
  );
}
