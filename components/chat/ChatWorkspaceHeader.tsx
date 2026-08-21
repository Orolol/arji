"use client";

import { Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChatProviderSelect,
  type ChatAgentSelection,
} from "@/components/chat/ChatProviderSelect";
import type { Conversation } from "@/hooks/useConversations";
import { resolveLegacyConversationLabel } from "@/lib/chat/parity-contract";

interface ChatWorkspaceHeaderProps {
  activeConversation: Conversation | null;
  activeProvider: string;
  hasMessages: boolean;
  isBusy: boolean;
  onSelectAgentOrProvider: (selection: ChatAgentSelection) => void;
}

/**
 * Right-hand meta cluster of the conversation tab row: the provider marker
 * (read by tests) and the unified chat provider / named-agent picker.
 */
export function ChatWorkspaceHeader({
  activeConversation,
  activeProvider,
  hasMessages,
  isBusy,
  onSelectAgentOrProvider,
}: ChatWorkspaceHeaderProps) {
  return (
    <div className="flex items-center gap-2">
      <span data-testid="provider-select" className="sr-only">
        {activeProvider}
      </span>
      {activeConversation?.cliSessionId && (
        <Badge
          variant="outline"
          className="border-agent-border text-[10px] text-agent"
        >
          session linked
        </Badge>
      )}
      <ChatProviderSelect
        activeConversation={activeConversation}
        onSelect={onSelectAgentOrProvider}
        disabled={!activeConversation || hasMessages || isBusy}
      />
    </div>
  );
}

interface ChatProposalCardProps {
  activeConversation: Conversation | null;
  showGenerateSpec: boolean;
  generatingSpec: boolean;
  onGenerateSpec: () => void;
  showCreateEpic: boolean;
  epicCreating: boolean;
  onCreateEpic: () => void;
}

/**
 * The conversation's next step, rendered at the foot of the message flow:
 * a "Proposed epic" card for epic-creation conversations, and the spec
 * suggestion chip for brainstorms. Renders nothing when neither applies.
 */
export function ChatProposalCard({
  activeConversation,
  showGenerateSpec,
  generatingSpec,
  onGenerateSpec,
  showCreateEpic,
  epicCreating,
  onCreateEpic,
}: ChatProposalCardProps) {
  if (!showCreateEpic && !showGenerateSpec) return null;

  return (
    <div className="flex flex-col gap-[10px] px-[18px] pb-[14px]">
      {showCreateEpic && (
        <div
          className="flex max-w-[88%] flex-col gap-[10px] rounded-[11px] border border-border p-[14px]"
          data-testid="chat-proposed-epic"
        >
          <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
            Proposed epic
          </span>
          <span className="text-[13.5px] font-medium leading-[1.4]">
            {resolveLegacyConversationLabel(
              activeConversation?.type,
              activeConversation?.label,
            )}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={onCreateEpic}
              disabled={epicCreating}
              className="h-[31px] rounded-[8px] text-[13px]"
            >
              {epicCreating ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-3 w-3" />
              )}
              Create Epic & Generate Stories
            </Button>
          </div>
        </div>
      )}

      {showGenerateSpec && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onGenerateSpec}
            disabled={generatingSpec}
            className="h-[26px] rounded-full px-[11px] text-[12.5px] text-muted-foreground"
          >
            {generatingSpec ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3 w-3" />
            )}
            Generate Spec & Plan
          </Button>
        </div>
      )}
    </div>
  );
}
