"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  EyeOff,
  Loader2,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { MessageList } from "@/components/chat/MessageList";
import { MessageInput } from "@/components/chat/MessageInput";
import { QuestionCards } from "@/components/chat/QuestionCards";
import { useConversations } from "@/hooks/useConversations";
import { useChat } from "@/hooks/useChat";
import { useEpicCreate } from "@/hooks/useEpicCreate";
import {
  isBrainstormConversationAgentType,
  isEpicCreationConversationAgentType,
} from "@/lib/chat/conversation-agent";
import {
  applyLegacyConversationFilter,
  isLegacyConversationGenerating,
  resolveLegacyConversationLabel,
  sortConversationsForLegacyParity,
} from "@/lib/chat/parity-contract";
import { cn } from "@/lib/utils";

const DEFAULT_PANEL_RATIO = 0.4;
const MIN_PANEL_WIDTH = 300;
const MIN_BOARD_WIDTH = 400;
const DIVIDER_WIDTH = 6;
const MOBILE_BREAKPOINT = 768;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function truncateLabel(label: string) {
  if (label.length <= 20) return label;
  return `${label.slice(0, 20)}...`;
}

export type UnifiedPanelState = "collapsed" | "expanded" | "hidden";

export interface UnifiedChatPanelHandle {
  openChat: () => void;
  openNewEpic: () => void;
  collapse: () => void;
  hide: () => void;
}

interface UnifiedChatPanelProps {
  projectId: string;
  children: ReactNode;
  onEpicCreated?: () => void;
}

export const UnifiedChatPanel = forwardRef<UnifiedChatPanelHandle, UnifiedChatPanelProps>(
  function UnifiedChatPanel({ projectId, children, onEpicCreated }, ref) {
    const router = useRouter();
    const containerRef = useRef<HTMLDivElement>(null);
    const [panelState, setPanelState] = useState<UnifiedPanelState>("collapsed");
    const [panelRatio, setPanelRatio] = useState(DEFAULT_PANEL_RATIO);
    const [isDragging, setIsDragging] = useState(false);
    const [generatingSpec, setGeneratingSpec] = useState(false);
    const [specError, setSpecError] = useState<string | null>(null);
    const [isMobile, setIsMobile] = useState(false);
    const [, forceConversationRefresh] = useState(0);

    const {
      conversations,
      activeId,
      setActiveId,
      createConversation,
      deleteConversation,
      updateConversation,
      refresh: refreshConversations,
    } = useConversations(projectId);

    const {
      messages,
      loading,
      sending,
      error: chatError,
      pendingQuestions,
      streamStatus,
      sendMessage: rawSendMessage,
      answerQuestions,
    } = useChat(projectId, activeId);

    const storageKey = useMemo(
      () => `arij.unified-chat-panel.ratio.${projectId}`,
      [projectId],
    );

    const stateStorageKey = useMemo(
      () => `arij.unified-chat-panel.state.${projectId}`,
      [projectId],
    );

    const activeStorageKey = useMemo(
      () => `arij.unified-chat-panel.active.${projectId}`,
      [projectId],
    );

    const activeConversation = useMemo(
      () => conversations.find((conversation) => conversation.id === activeId) || null,
      [conversations, activeId],
    );

    const tabConversations = useMemo(
      () =>
        applyLegacyConversationFilter(
          sortConversationsForLegacyParity(conversations),
          "all",
        ),
      [conversations],
    );

    const { createEpic, isLoading: epicCreating, error: epicError } = useEpicCreate({
      projectId,
      conversationId: activeId,
      sendMessage: rawSendMessage,
    });

    const activeProvider = activeConversation?.provider || "claude-code";
    const hasMessages = messages.length > 0;
    const isBrainstorm = isBrainstormConversationAgentType(activeConversation?.type);
    const isEpicCreation = isEpicCreationConversationAgentType(activeConversation?.type);
    const hasUserMessage = messages.some((message) => message.role === "user");
    const hasAssistantMessage = messages.some((message) => message.role === "assistant");
    const canCreateEpic = isEpicCreation && hasUserMessage && hasAssistantMessage;
    const hasActiveAgents = conversations.some(
      (conversation) => isLegacyConversationGenerating(conversation.status),
    );
    // The *current* conversation is busy when useChat is actively streaming
    // OR when the DB status says "generating" (e.g. the user switched away and back).
    const isCurrentConversationBusy =
      sending || isLegacyConversationGenerating(activeConversation?.status);

    const previousSending = useRef(sending);
    useEffect(() => {
      if (previousSending.current && !sending) {
        const timer = setTimeout(() => refreshConversations(), 3000);
        return () => clearTimeout(timer);
      }
      previousSending.current = sending;
    }, [sending, refreshConversations]);

    useEffect(() => {
      const interval = setInterval(() => {
        refreshConversations();
      }, 3000);

      return () => clearInterval(interval);
    }, [refreshConversations]);

    useEffect(() => {
      if (typeof window === "undefined") {
        return;
      }

      function updateIsMobile() {
        setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
      }

      updateIsMobile();
      window.addEventListener("resize", updateIsMobile);
      return () => window.removeEventListener("resize", updateIsMobile);
    }, []);

    useEffect(() => {
      if (!tabConversations.length) return;

      if (!activeId) {
        setActiveId(tabConversations[0].id);
        return;
      }

      if (!tabConversations.some((conversation) => conversation.id === activeId)) {
        setActiveId(tabConversations[0].id);
      }
    }, [activeId, setActiveId, tabConversations]);

    const getContainerWidth = useCallback(() => {
      if (typeof window === "undefined") {
        return 1200;
      }
      return containerRef.current?.clientWidth || window.innerWidth || 1200;
    }, []);

    const computePanelWidth = useCallback(
      (ratio: number) => {
        const totalWidth = getContainerWidth();
        const minRatio = MIN_PANEL_WIDTH / totalWidth;
        const maxRatio = (totalWidth - MIN_BOARD_WIDTH - DIVIDER_WIDTH) / totalWidth;
        const safeRatio = clamp(ratio, minRatio, maxRatio);
        return Math.round(totalWidth * safeRatio);
      },
      [getContainerWidth],
    );

    const panelWidthPx = computePanelWidth(panelRatio);

    const createNewConversationTab = useCallback(
      async (options?: { type?: string; label?: string; provider?: string }) => {
        const created = await createConversation({
          type: options?.type || "brainstorm",
          label: options?.label || "Brainstorm",
          provider: options?.provider || activeProvider,
        });

        if (created) {
          setActiveId(created.id);
          forceConversationRefresh((value) => value + 1);
        }

        return created;
      },
      [createConversation, setActiveId, activeProvider],
    );

    const openChatConversation = useCallback(async () => {
      setPanelState("expanded");

      if (activeId) {
        return;
      }

      if (tabConversations.length > 0) {
        const fallbackId = tabConversations[0].id;
        setActiveId(fallbackId);
        return;
      }

      await createNewConversationTab({ type: "brainstorm", label: "Brainstorm" });
    }, [activeId, tabConversations, setActiveId, createNewConversationTab]);

    useImperativeHandle(
      ref,
      () => ({
        openChat() {
          void openChatConversation();
        },
        openNewEpic() {
          setPanelState("expanded");
          void createNewConversationTab({ type: "epic_creation", label: "New Epic" });
        },
        collapse() {
          setPanelState("collapsed");
        },
        hide() {
          setPanelState("hidden");
        },
      }),
      [openChatConversation, createNewConversationTab],
    );

    useEffect(() => {
      if (typeof window === "undefined") {
        return;
      }
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        return;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        return;
      }
      setPanelRatio(parsed);
    }, [storageKey]);

    useEffect(() => {
      if (typeof window === "undefined") {
        return;
      }
      window.localStorage.setItem(storageKey, panelRatio.toFixed(4));
    }, [panelRatio, storageKey]);

    // Persist panelState — read on mount
    useEffect(() => {
      if (typeof window === "undefined") return;
      const raw = window.localStorage.getItem(stateStorageKey);
      if (raw === "expanded" || raw === "collapsed" || raw === "hidden") {
        setPanelState(raw);
      }
    }, [stateStorageKey]);

    // Persist panelState — write on change
    useEffect(() => {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(stateStorageKey, panelState);
    }, [panelState, stateStorageKey]);

    // Persist activeId — read on mount (with guard to avoid overriding user switches)
    const activeIdRestoredRef = useRef(false);
    useEffect(() => {
      if (typeof window === "undefined") return;
      if (activeIdRestoredRef.current) return;
      activeIdRestoredRef.current = true;
      const saved = window.localStorage.getItem(activeStorageKey);
      if (saved && conversations.some((c) => c.id === saved)) {
        setActiveId(saved);
      }
    }, [activeStorageKey, conversations, setActiveId]);

    // Persist activeId — write on change
    useEffect(() => {
      if (typeof window === "undefined") return;
      if (activeId) {
        window.localStorage.setItem(activeStorageKey, activeId);
      }
    }, [activeId, activeStorageKey]);

    useEffect(() => {
      if (!isDragging || panelState !== "expanded") {
        return;
      }

      function onMove(event: MouseEvent) {
        const totalWidth = getContainerWidth();
        const nextPanelWidth = clamp(
          totalWidth - event.clientX,
          MIN_PANEL_WIDTH,
          totalWidth - MIN_BOARD_WIDTH - DIVIDER_WIDTH,
        );
        setPanelRatio(nextPanelWidth / totalWidth);
      }

      function onUp() {
        setIsDragging(false);
      }

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);

      return () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
    }, [isDragging, panelState, getContainerWidth]);

    useEffect(() => {
      function onEscape(event: KeyboardEvent) {
        if (event.key === "Escape") {
          setPanelState((state) => (state === "expanded" ? "collapsed" : state));
        }
      }

      window.addEventListener("keydown", onEscape);
      return () => window.removeEventListener("keydown", onEscape);
    }, []);

    const sendMessage = useCallback(
      async (content: string, attachmentIds: string[]) => {
        if (!activeId) return;
        await rawSendMessage(content, attachmentIds);
      },
      [activeId, rawSendMessage],
    );

    async function handleAgentChange(namedAgentId: string) {
      if (!activeId || hasMessages) {
        return;
      }
      // For now, store the namedAgentId as provider — conversations track agent selection
      await updateConversation(activeId, { provider: namedAgentId });
    }

    async function handleGenerateSpec() {
      setGeneratingSpec(true);
      setSpecError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/generate-spec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: activeProvider }),
        });
        const json = await res.json();
        if (!res.ok || json.error) {
          setSpecError(json.error || `Spec generation failed (HTTP ${res.status})`);
        } else {
          router.refresh();
        }
      } catch (err) {
        setSpecError(err instanceof Error ? err.message : "Spec generation request failed");
      }
      setGeneratingSpec(false);
    }

    async function handleCreateEpic() {
      const epicId = await createEpic();
      if (epicId) {
        onEpicCreated?.();
        router.refresh();
      }
    }

    function handleResetDivider() {
      setPanelRatio(DEFAULT_PANEL_RATIO);
    }

    async function closeTab(conversationId: string) {
      if (tabConversations.length <= 1) {
        return;
      }
      await deleteConversation(conversationId);
      forceConversationRefresh((value) => value + 1);
    }

    const chatWorkspace = (
      <div className="flex h-full flex-col">
        <div
          className="border-b border-border flex items-center gap-0 overflow-x-auto"
          data-testid="chat-tab-bar"
        >
          {tabConversations.map((conversation) => {
            const isActive = conversation.id === activeId;
            return (
              <button
                key={conversation.id}
                type="button"
                data-testid={`conversation-tab-${conversation.id}`}
                data-agent-type={
                  isEpicCreationConversationAgentType(conversation.type)
                    ? "epic_creation"
                    : "brainstorm"
                }
                onClick={() => setActiveId(conversation.id)}
                className={cn(
                  "group flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {isEpicCreationConversationAgentType(conversation.type) ? (
                  <Sparkles className="h-3 w-3" />
                ) : (
                  <MessageSquare className="h-3 w-3" />
                )}
                <span>
                  {truncateLabel(
                    resolveLegacyConversationLabel(
                      conversation.type,
                      conversation.label,
                    ),
                  )}
                </span>
                {isLegacyConversationGenerating(conversation.status) && (
                  <Loader2
                    data-testid={`active-indicator-${conversation.id}`}
                    className="h-3 w-3 animate-spin text-primary"
                    aria-label="Agent active"
                  />
                )}
                {tabConversations.length > 1 && (
                  <span
                    role="button"
                    data-testid={`close-tab-${conversation.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeTab(conversation.id);
                    }}
                    className="ml-1 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </span>
                )}
              </button>
            );
          })}

          <button
            type="button"
            data-testid="new-conversation-tab"
            onClick={() =>
              void createNewConversationTab({ type: "brainstorm", label: "Brainstorm" })
            }
            className="flex items-center justify-center w-7 h-7 mx-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="New conversation"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="p-3 border-b border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm">
              {resolveLegacyConversationLabel(
                activeConversation?.type,
                activeConversation?.label,
              )}
            </h3>
            {activeConversation?.claudeSessionId && (
              <Badge variant="outline" className="text-[10px] text-blue-400 border-blue-400/30">
                session linked
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <NamedAgentSelect
              value={null}
              onChange={handleAgentChange}
              disabled={!activeConversation || hasMessages || isCurrentConversationBusy}
              className="w-44 h-7 text-xs"
            />
            {isBrainstorm && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleGenerateSpec}
                disabled={generatingSpec}
                className="text-xs"
              >
                {generatingSpec ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Sparkles className="h-3 w-3 mr-1" />
                )}
                Generate Spec & Plan
              </Button>
            )}
            {canCreateEpic && (
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={handleCreateEpic}
                disabled={epicCreating || isCurrentConversationBusy}
                className="text-xs"
              >
                {epicCreating ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Sparkles className="h-3 w-3 mr-1" />
                )}
                Create Epic & Generate Stories
              </Button>
            )}
          </div>
        </div>

        {(epicError || specError || chatError) && (
          <div className="mx-3 mt-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {epicError || specError || chatError}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {isEpicCreation && !hasMessages && !loading && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Describe your epic idea and I&apos;ll help you structure it with user stories and acceptance criteria.
            </div>
          )}
          <MessageList
            messages={messages}
            loading={loading}
            streamStatus={streamStatus}
          />
          {pendingQuestions && (
            <div className="px-3 pb-3">
              <QuestionCards
                questions={pendingQuestions}
                onSubmit={answerQuestions}
                disabled={isCurrentConversationBusy}
              />
            </div>
          )}
        </div>

        <MessageInput
          projectId={projectId}
          onSend={sendMessage}
          disabled={isCurrentConversationBusy || !activeConversation}
          placeholder={isEpicCreation ? "Describe your epic idea..." : "Ask a question..."}
        />
      </div>
    );

    if (panelState === "expanded") {
      if (isMobile) {
        return (
          <div ref={containerRef} className="relative h-full w-full overflow-hidden">
            <div className="h-full w-full">{children}</div>
            <Sheet
              open
              onOpenChange={(open) => {
                if (!open) {
                  setPanelState("collapsed");
                }
              }}
            >
              <SheetContent
                side="right"
                showCloseButton={false}
                className="w-full max-w-none p-0 sm:max-w-none"
                data-testid="unified-panel-mobile-sheet"
              >
                {chatWorkspace}
              </SheetContent>
            </Sheet>
          </div>
        );
      }

      return (
        <div ref={containerRef} className="flex h-full w-full overflow-hidden">
          <div
            className="h-full min-w-[400px] overflow-hidden"
            style={{ width: `calc(100% - ${panelWidthPx}px - ${DIVIDER_WIDTH}px)` }}
          >
            {children}
          </div>

          <button
            type="button"
            aria-label="Resize panel"
            data-testid="panel-divider"
            onMouseDown={() => setIsDragging(true)}
            onDoubleClick={handleResetDivider}
            className={cn(
              "h-full w-[6px] shrink-0 border-l border-r border-border/60 bg-muted/60 transition-colors",
              isDragging ? "bg-primary/30" : "hover:bg-primary/20",
            )}
          />

          <aside
            className="h-full shrink-0 border-l border-border bg-background/95 backdrop-blur transition-all duration-200"
            style={{ width: panelWidthPx }}
            data-testid="unified-panel-expanded"
          >
            <div className="flex h-10 items-center justify-end gap-1 border-b border-border px-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setPanelState("collapsed")}
                aria-label="Collapse panel"
              >
                <PanelRightClose className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setPanelState("hidden")}
                aria-label="Hide panel"
              >
                <EyeOff className="h-4 w-4" />
              </Button>
            </div>

            <div className="h-[calc(100%-2.5rem)]">{chatWorkspace}</div>
          </aside>
        </div>
      );
    }

    if (panelState === "collapsed") {
      return (
        <div ref={containerRef} className="flex h-full w-full overflow-hidden">
          <div className="h-full min-w-0 flex-1 overflow-hidden">{children}</div>

          <button
            type="button"
            onClick={() => void openChatConversation()}
            className={cn(
              "relative h-full w-14 shrink-0 flex items-center justify-center border-l border-border bg-muted/60 text-muted-foreground backdrop-blur transition-colors hover:bg-muted/80 hover:text-foreground",
              hasActiveAgents && "bg-primary/10 shadow-[-6px_0_24px_rgba(59,130,246,0.25)]",
            )}
            aria-label="Open chat panel"
            data-testid="collapsed-chat-strip"
          >
            <span className="flex flex-col items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em]">
              <MessageSquare className="h-4 w-4" />
              Chat
            </span>
            {hasActiveAgents && (
              <span
                data-testid="collapsed-active-badge"
                className="absolute top-2 right-2 h-2.5 w-2.5 rounded-full bg-primary animate-pulse"
              />
            )}
          </button>
        </div>
      );
    }

    return (
      <div ref={containerRef} className="relative h-full w-full overflow-hidden">
        <div className="h-full w-full">{children}</div>

        <button
          type="button"
          onClick={() => setPanelState("collapsed")}
          className="absolute right-2 top-2 z-30 rounded-full border border-border bg-background/95 p-1.5 text-muted-foreground shadow-sm hover:text-foreground"
          aria-label="Show chat strip"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </div>
    );
  },
);
