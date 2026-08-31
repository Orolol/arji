"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BRAINSTORM_AGENT_TYPE,
  EPIC_CREATION_AGENT_TYPE,
} from "@/lib/chat/conversation-agent";

/**
 * The dashed "New conversation" affordance at the foot of the roster.
 *
 * `ChatTabBar`'s "+" carried TWO entries — Brainstorm and New Epic — and the
 * epic-creation type is what unlocks the finalisation fallback (§7.6). Losing
 * it would leave no way to start an epic conversation from this page, so the
 * card is a dropdown trigger rather than a plain button: one click, two
 * choices, same payloads as the tab bar's.
 *
 * NOT a `SelectPill`: this is a full-width dashed card, not a 30px pill, and
 * the pill primitive is a fixed-height inline trigger.
 */
export interface NewConversationCardProps {
  onCreate: (options: { type: string; label: string }) => void;
  disabled?: boolean;
}

export function NewConversationCard({
  onCreate,
  disabled = false,
}: NewConversationCardProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="chat-new-conversation"
          disabled={disabled}
          className={[
            "flex shrink-0 items-center gap-[7px] rounded-[14px]",
            "border-[1.5px] border-dashed border-border-strong",
            "px-[15px] py-[14px] text-[13px] font-semibold text-foreground",
            "outline-none transition-colors hover:border-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:pointer-events-none disabled:opacity-50",
            "motion-reduce:transition-none",
          ].join(" ")}
        >
          <Plus size={14} aria-hidden="true" />
          New conversation
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="rounded-[12px] border-[1.5px] border-border bg-card shadow-none"
      >
        <DropdownMenuItem
          data-testid="chat-new-conversation-brainstorm"
          onSelect={() =>
            onCreate({ type: BRAINSTORM_AGENT_TYPE, label: "Brainstorm" })
          }
        >
          Brainstorm
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="chat-new-conversation-epic"
          onSelect={() =>
            onCreate({ type: EPIC_CREATION_AGENT_TYPE, label: "New Epic" })
          }
        >
          New Epic
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
