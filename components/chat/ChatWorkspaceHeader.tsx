"use client";

import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AgentSelectPill,
  type AgentSelection,
} from "@/components/shared/AgentSelectPill";
import { selectionForConversation } from "@/components/chat-page/agent-selection";
import type { Conversation } from "@/hooks/useConversations";
import { resolveLegacyConversationLabel } from "@/lib/chat/parity-contract";
import { isPersistentChatProvider } from "@/lib/agent-config/constants";

interface ChatWorkspaceHeaderProps {
  activeConversation: Conversation | null;
  activeProvider: string;
  hasMessages: boolean;
  isBusy: boolean;
  onSelectAgentOrProvider: (selection: AgentSelection) => void;
  onRestartPersistentSession?: () => void;
}

/**
 * Right-hand meta cluster of the conversation tab row: the provider marker
 * (read by tests) and the shared agent picker in `chat` mode — the same
 * component the desk and the chat page mount, so the three menus can no longer
 * drift. The trigger is the Piscine `SelectPill`; the shadcn `Select` this
 * surface used to draw is gone.
 */
export function ChatWorkspaceHeader({
  activeConversation,
  activeProvider,
  hasMessages,
  isBusy,
  onSelectAgentOrProvider,
  onRestartPersistentSession = () => {},
}: ChatWorkspaceHeaderProps) {
  const isPersistent = isPersistentChatProvider(activeConversation?.provider);
  // Shared with the chat page: `provider` is a free-form column, and a
  // conversation stored before a provider cleanup (`gemini-cli`, `pi`) has no
  // item in the menu — the pill labels it with the raw string rather than
  // blanking the trigger.
  const selection: AgentSelection = selectionForConversation(activeConversation);
  const isHot = activeConversation?.persistentSessionState === "hot";
  return (
    <div className="flex items-center gap-2">
      <span data-testid="provider-select" className="sr-only">
        {activeProvider}
      </span>
      {isPersistent ? (
        <Badge
          variant="outline"
          className={
            isHot
              ? "border-agent-border text-[10px] text-agent"
              : "text-[10px] text-muted-foreground"
          }
          data-testid="persistent-session-state"
        >
          {isHot ? "session warm" : "session cold"}
        </Badge>
      ) : (
        // Non-persistent CLI conversations still resume from a stored session
        // id; warm/cold replaces this indicator only where it applies.
        activeConversation?.cliSessionId && (
          <Badge
            variant="outline"
            className="border-agent-border text-[10px] text-agent"
            data-testid="linked-session-state"
          >
            session linked
          </Badge>
        )
      )}
      {isPersistent && (
        // Deliberately enabled while the conversation is busy: killing the
        // embedded CLI is the recovery for a turn that has wedged, and a
        // wedged turn is exactly when the conversation stays "generating".
        // Disabling it here would leave a page reload as the only escape.
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title={isBusy ? "Stop and restart session" : "Restart session"}
          aria-label="Restart persistent chat session"
          onClick={onRestartPersistentSession}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
      <AgentSelectPill
        mode="chat"
        selection={selection}
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
