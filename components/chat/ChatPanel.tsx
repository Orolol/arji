"use client";

import { useChat } from "@/hooks/useChat";
import { useConversations } from "@/hooks/useConversations";
import { useCodexAvailable } from "@/hooks/useCodexAvailable";
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";
import { QuestionCards } from "./QuestionCards";
import { ProviderSelect, type ProviderType } from "@/components/shared/ProviderSelect";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, Plus, MessageSquare, X } from "lucide-react";
import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

interface ChatPanelProps {
  projectId: string;
}

export function ChatPanel({ projectId }: ChatPanelProps) {
  const {
    conversations,
    activeId,
    setActiveId,
    createConversation,
    deleteConversation,
    updateConversation,
    refresh: refreshConversations,
  } = useConversations(projectId);

  const { messages, loading, sending, pendingQuestions, streamStatus, sendMessage: rawSendMessage, answerQuestions } = useChat(projectId, activeId);
  const { codexAvailable, codexInstalled } = useCodexAvailable();
  const [generating, setGenerating] = useState(false);
  const router = useRouter();

  // Refresh conversation labels after send completes (picks up AI-generated titles)
  const prevSending = useRef(sending);
  useEffect(() => {
    if (prevSending.current && !sending) {
      // Sending just finished — delay refresh to let title gen complete
      const timer = setTimeout(() => refreshConversations(), 3000);
      return () => clearTimeout(timer);
    }
    prevSending.current = sending;
  }, [sending, refreshConversations]);

  const sendMessage = useCallback(
    async (content: string, attachmentIds: string[]) => {
      await rawSendMessage(content, attachmentIds);
    },
    [rawSendMessage]
  );

  const activeConversation = conversations.find((c) => c.id === activeId);
  const isBrainstorm = activeConversation?.type === "brainstorm";

  // Provider is stored on the conversation. Locked after first message.
  const activeProvider = (activeConversation?.provider || "claude-code") as ProviderType;
  const hasMessages = messages.length > 0;

  async function handleProviderChange(newProvider: ProviderType) {
    if (!activeId || hasMessages) return;
    await updateConversation(activeId, { provider: newProvider });
  }

  async function handleGenerateSpec() {
    setGenerating(true);
    try {
      await fetch(`/api/projects/${projectId}/generate-spec`, {
        method: "POST",
      });
      router.refresh();
    } catch {
      // ignore
    }
    setGenerating(false);
  }

  async function handleNewConversation() {
    await createConversation({ type: "brainstorm", label: "Brainstorm" });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab strip */}
      <div className="border-b border-border flex items-center gap-0 overflow-x-auto">
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => setActiveId(conv.id)}
            className={`group flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
              conv.id === activeId
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <MessageSquare className="h-3 w-3" />
            {conv.label}
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                deleteConversation(conv.id);
              }}
              className="ml-1 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        ))}
        <button
          onClick={handleNewConversation}
          className="flex items-center justify-center w-7 h-7 mx-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="New conversation"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Header with actions */}
      <div className="p-3 border-b border-border flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">{activeConversation?.label || "Chat"}</h3>
        <div className="flex items-center gap-2">
          <ProviderSelect
            value={activeProvider}
            onChange={handleProviderChange}
            codexAvailable={codexAvailable}
            codexInstalled={codexInstalled}
            disabled={hasMessages || sending}
            className="w-36 h-7 text-xs"
          />
          {isBrainstorm && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleGenerateSpec}
              disabled={generating}
              className="text-xs"
            >
              {generating ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Sparkles className="h-3 w-3 mr-1" />
              )}
              Generate Spec & Plan
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <MessageList messages={messages} loading={loading} streamStatus={streamStatus} />
        {pendingQuestions && (
          <div className="px-3 pb-3">
            <QuestionCards
              questions={pendingQuestions}
              onSubmit={answerQuestions}
              disabled={sending}
            />
          </div>
        )}
      </div>
      <MessageInput projectId={projectId} onSend={sendMessage} disabled={sending} />
    </div>
  );
}
