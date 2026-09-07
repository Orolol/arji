"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Loader2, MessageCircle, MessageSquare, Plus, Sparkles, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Conversation } from "@/hooks/useConversations";
import {
  CHAT_AGENT_TYPE,
  isEpicCreationConversationAgentType,
} from "@/lib/chat/conversation-agent";
import {
  isLegacyConversationGenerating,
  resolveLegacyConversationLabel,
} from "@/lib/chat/parity-contract";
import { cn } from "@/lib/utils";

function truncateLabel(label: string) {
  if (label.length <= 20) return label;
  return `${label.slice(0, 20)}...`;
}

interface ChatTabBarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelectTab: (conversationId: string) => void;
  onCloseTab: (conversationId: string) => void;
  onCreateTab: (options: { type: string; label: string }) => void;
  /** Right-aligned slot (provider / named-agent picker). */
  trailing?: ReactNode;
}

/**
 * Conversation sub-tabs: underlined in the accent color, with the `+` menu
 * and an optional right-aligned trailing slot on the same row.
 */
export function ChatTabBar({
  conversations,
  activeId,
  onSelectTab,
  onCloseTab,
  onCreateTab,
  trailing,
}: ChatTabBarProps) {
  const t = useTranslations("ChatLegacy");

  return (
    <div
      className="flex items-center gap-[14px] overflow-x-auto border-b border-border px-[18px] py-[12px]"
      data-testid="chat-tab-bar"
    >
      {conversations.map((conversation) => {
        const isActive = conversation.id === activeId;
        const fullLabel = resolveLegacyConversationLabel(
          conversation.type,
          conversation.label,
        );
        return (
          <button
            key={conversation.id}
            type="button"
            title={fullLabel}
            data-testid={`conversation-tab-${conversation.id}`}
            data-agent-type={
              isEpicCreationConversationAgentType(conversation.type)
                ? "epic_creation"
                : conversation.type === CHAT_AGENT_TYPE
                  ? "chat"
                  : "brainstorm"
            }
            onClick={() => onSelectTab(conversation.id)}
            className={cn(
              "group flex shrink-0 items-center gap-1.5 whitespace-nowrap pb-[6px] text-[13px] transition-colors",
              isActive
                ? "font-medium text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
                : "text-meta hover:text-foreground",
            )}
          >
            <span>{truncateLabel(fullLabel)}</span>
            {isLegacyConversationGenerating(conversation.status) && (
              <Loader2
                data-testid={`active-indicator-${conversation.id}`}
                className="h-3 w-3 animate-spin text-agent"
                aria-label={t("tabs.agentActive")}
              />
            )}
            {conversations.length > 1 && (
              <span
                role="button"
                data-testid={`close-tab-${conversation.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(conversation.id);
                }}
                className="ml-1 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </button>
        );
      })}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="new-conversation-tab"
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-meta transition-colors hover:bg-band hover:text-foreground"
            title={t("tabs.newConversation")}
          >
            <Plus className="h-[13px] w-[13px]" />
          </button>
        </DropdownMenuTrigger>
        {/*
          The `label` each item creates with is NOT copy and stays inline: it
          is written to the conversation row and read back on every later
          render (and by `resolveLegacyConversationLabel`), so translating it
          would persist one locale's word into the database. Only the menu
          item's own text resolves from the catalogue.
        */}
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            data-testid="new-tab-chat"
            onClick={() => onCreateTab({ type: "chat", label: "Chat" })}
          >
            <MessageCircle className="mr-2 h-4 w-4" />
            {t("tabs.new.chat")}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="new-tab-brainstorm"
            onClick={() => onCreateTab({ type: "brainstorm", label: "Brainstorm" })}
          >
            <MessageSquare className="mr-2 h-4 w-4" />
            {t("tabs.new.brainstorm")}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="new-tab-epic"
            onClick={() => onCreateTab({ type: "epic_creation", label: "New Epic" })}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {t("tabs.new.epic")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {trailing && <div className="ml-auto shrink-0">{trailing}</div>}
    </div>
  );
}
