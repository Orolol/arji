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
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ChatTabBar } from "@/components/chat/ChatTabBar";
import {
  ChatProposalCard,
  ChatWorkspaceHeader,
} from "@/components/chat/ChatWorkspaceHeader";
import type { ChatAgentSelection } from "@/components/chat/ChatProviderSelect";
import { MessageList } from "@/components/chat/MessageList";
import { MessageInput } from "@/components/chat/MessageInput";
import { QuestionCards } from "@/components/chat/QuestionCards";
import { OPENAI_COMPATIBLE_PROVIDER } from "@/lib/agent-config/constants";
import { useConversations } from "@/hooks/useConversations";
import { usePanelLayout, DIVIDER_WIDTH, type UnifiedPanelState } from "@/hooks/usePanelLayout";
import { usePolling } from "@/hooks/usePolling";
import { useChat } from "@/hooks/useChat";
import { useEpicCreate } from "@/hooks/useEpicCreate";
import { useSpecGeneration } from "@/hooks/useSpecGeneration";
import {
  isBrainstormConversationAgentType,
  isEpicCreationConversationAgentType,
} from "@/lib/chat/conversation-agent";
import {
  isLegacyConversationGenerating,
  sortConversationsForLegacyParity,
} from "@/lib/chat/parity-contract";
import { cn } from "@/lib/utils";

export type { UnifiedPanelState };

export interface UnifiedChatPanelHandle {
  openChat: () => void;
  openNewEpic: () => void;
  collapse: () => void;
  hide: () => void;
}

interface UnifiedSharedPanelView {
  panelId: string;
  label: string;
  content: ReactNode;
  onClose?: () => void;
}

interface UnifiedChatPanelProps {
  projectId: string;
  children: ReactNode;
  onEpicCreated?: () => void;
  sharedPanelView?: UnifiedSharedPanelView | null;
  /**
   * Fires whenever the panel occupies board width (expanded on desktop).
   * The board uses it to hide the Released digest and reclaim the space.
   */
  onExpandedChange?: (expanded: boolean) => void;
}

export const UnifiedChatPanel = forwardRef<UnifiedChatPanelHandle, UnifiedChatPanelProps>(
  function UnifiedChatPanel(
    { projectId, children, onEpicCreated, sharedPanelView, onExpandedChange },
    ref,
  ) {
    const router = useRouter();
    const [activePanelContent, setActivePanelContent] = useState<"chat" | "shared">("chat");
    const [, forceConversationRefresh] = useState(0);
    const previousSharedPanelIdRef = useRef<string | null>(null);

    const {
      conversations,
      activeId,
      setActiveId,
      createConversation,
      deleteConversation,
      updateConversation,
      restartPersistentSession,
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

    const hasSharedPanelView = Boolean(sharedPanelView);
    const isSharedPanelActive = hasSharedPanelView && activePanelContent === "shared";
    const panelContentMode = isSharedPanelActive ? "shared" : "chat";

    const {
      containerRef,
      panelState,
      setPanelState,
      isMobile,
      isDragging,
      startDrag,
      resetPanelRatio,
      panelWidthPx,
    } = usePanelLayout({
      projectId,
      conversations,
      activeId,
      setActiveId,
    });

    const activeConversation = useMemo(
      () => conversations.find((conversation) => conversation.id === activeId) || null,
      [conversations, activeId],
    );

    const tabConversations = useMemo(
      () => sortConversationsForLegacyParity(conversations),
      [conversations],
    );

    const { createEpic, isLoading: epicCreating, error: epicError } = useEpicCreate({
      projectId,
      conversationId: activeId,
      sendMessage: rawSendMessage,
    });

    const activeProvider = activeConversation?.provider || "claude-code";

    const {
      generateSpec,
      generating: generatingSpec,
      error: specError,
    } = useSpecGeneration(projectId, activeProvider);

    const hasMessages = messages.length > 0;
    const isBrainstorm = isBrainstormConversationAgentType(activeConversation?.type);
    const isEpicCreation = isEpicCreationConversationAgentType(activeConversation?.type);
    const hasUserMessage = messages.some((message) => message.role === "user");
    const canCreateEpic = isEpicCreation && hasUserMessage;
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

    // Only poll conversation status while the panel is visible.
    usePolling(refreshConversations, 3000, panelState !== "hidden", { immediate: false });

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

    const createNewConversationTab = useCallback(
      async (options?: { type?: string; label?: string }) => {
        const created = await createConversation({
          type: options?.type || "brainstorm",
          label: options?.label || "Brainstorm",
        });

        if (created) {
          setActiveId(created.id);
          forceConversationRefresh((value) => value + 1);
        }

        return created;
      },
      [createConversation, setActiveId],
    );

    const openChatConversation = useCallback(async () => {
      setActivePanelContent("chat");
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
    }, [activeId, tabConversations, setActiveId, setPanelState, createNewConversationTab]);

    useImperativeHandle(
      ref,
      () => ({
        openChat() {
          void openChatConversation();
        },
        openNewEpic() {
          setActivePanelContent("chat");
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
      [openChatConversation, createNewConversationTab, setPanelState],
    );

    useEffect(() => {
      const nextSharedPanelId = sharedPanelView?.panelId ?? null;
      const previousSharedPanelId = previousSharedPanelIdRef.current;

      if (!nextSharedPanelId) {
        if (previousSharedPanelId && activePanelContent === "shared") {
          setActivePanelContent("chat");
          setPanelState("collapsed");
        }
        previousSharedPanelIdRef.current = null;
        return;
      }

      if (previousSharedPanelId !== nextSharedPanelId) {
        setActivePanelContent("shared");
        setPanelState("expanded");
      }

      previousSharedPanelIdRef.current = nextSharedPanelId;
    }, [activePanelContent, sharedPanelView, setPanelState]);

    useEffect(() => {
      function onEscape(event: KeyboardEvent) {
        if (event.key !== "Escape") return;
        if (panelState !== "expanded") return;

        if (panelContentMode === "shared") {
          sharedPanelView?.onClose?.();
          return;
        }

        setPanelState("collapsed");
      }

      window.addEventListener("keydown", onEscape);
      return () => window.removeEventListener("keydown", onEscape);
    }, [panelContentMode, panelState, setPanelState, sharedPanelView]);

    // Board seam: the Released digest hides while the panel eats board width.
    useEffect(() => {
      onExpandedChange?.(panelState === "expanded" && !isMobile);
    }, [panelState, isMobile, onExpandedChange]);

    const sendMessage = useCallback(
      async (content: string, attachmentIds: string[]) => {
        if (!activeId) return;
        await rawSendMessage(content, attachmentIds);
      },
      [activeId, rawSendMessage],
    );


    async function handleSelectAgentOrProvider({
      namedAgentId,
      provider,
    }: ChatAgentSelection) {
      if (!activeId || hasMessages) {
        return;
      }
      // A named agent owns its provider: the PATCH route re-derives it from
      // the agent row, so sending one here would be silently ignored. Direct
      // API and raw CLI providers both travel as a provider with the
      // named-agent link explicitly cleared.
      await updateConversation(
        activeId,
        namedAgentId ? { namedAgentId } : { provider, namedAgentId: null },
      );
    }

    async function handleCreateEpic() {
      const epicId = await createEpic();
      if (epicId) {
        onEpicCreated?.();
        router.refresh();
      }
    }

    async function closeTab(conversationId: string) {
      if (tabConversations.length <= 1) {
        return;
      }
      await deleteConversation(conversationId);
      forceConversationRefresh((value) => value + 1);
    }

    const chatWorkspace = (
      <div className="flex h-full min-h-0 flex-col">
        <ChatTabBar
          conversations={tabConversations}
          activeId={activeId}
          onSelectTab={setActiveId}
          onCloseTab={(conversationId) => void closeTab(conversationId)}
          onCreateTab={(options) => void createNewConversationTab(options)}
          trailing={
            <ChatWorkspaceHeader
              activeConversation={activeConversation}
              activeProvider={activeProvider}
              hasMessages={hasMessages}
              isBusy={isCurrentConversationBusy}
              onSelectAgentOrProvider={handleSelectAgentOrProvider}
              onRestartPersistentSession={() => {
                if (activeId) void restartPersistentSession(activeId);
              }}
            />
          }
        />

        {(epicError || specError || chatError) && (
          <div className="mx-[18px] mt-2 rounded-[8px] border border-destructive/50 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {epicError || specError || chatError}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {isEpicCreation && !hasMessages && !loading && (
            <div className="px-[18px] py-8 text-center text-[13.5px] text-muted-foreground">
              Describe your epic idea and I&apos;ll help you structure it with user stories and acceptance criteria.
            </div>
          )}
          <MessageList
            messages={messages}
            loading={loading}
            streamStatus={streamStatus}
          />
          {pendingQuestions && (
            <div className="px-[18px] pb-[14px]">
              <QuestionCards
                questions={pendingQuestions}
                onSubmit={answerQuestions}
                disabled={isCurrentConversationBusy}
              />
            </div>
          )}
          <ChatProposalCard
            activeConversation={activeConversation}
            showGenerateSpec={isBrainstorm}
            generatingSpec={generatingSpec}
            onGenerateSpec={generateSpec}
            showCreateEpic={canCreateEpic}
            epicCreating={epicCreating}
            onCreateEpic={handleCreateEpic}
          />
        </div>

        <MessageInput
          projectId={projectId}
          onSend={sendMessage}
          disabled={isCurrentConversationBusy || !activeConversation}
          placeholder={isEpicCreation ? "Describe your epic idea..." : "Ask a question..."}
          attachmentsDisabled={activeProvider === OPENAI_COMPATIBLE_PROVIDER}
        />
      </div>
    );

    if (panelState === "expanded") {
      // On mobile the panel becomes a full-width Sheet in BOTH views (chat
      // and shared ticket). The shared view must not fall through to the
      // desktop split below the breakpoint: its width clamps assume a
      // container of ~706px+ and would compute an unusable panel width
      // (or a negative one), pushing the ticket out of the board row.
      if (isMobile) {
        return (
          <div ref={containerRef} className="relative h-full w-full overflow-hidden">
            <div className="h-full w-full">{children}</div>
            <Sheet
              open
              onOpenChange={(open) => {
                if (open) return;
                // Mirror the desktop Escape handling: dismissing the shared
                // view closes the ticket (the parent syncs back to chat and
                // collapses the panel); dismissing chat collapses the panel.
                if (panelContentMode === "shared") {
                  sharedPanelView?.onClose?.();
                } else {
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
                {panelContentMode === "shared"
                  ? sharedPanelView?.content
                  : chatWorkspace}
              </SheetContent>
            </Sheet>
          </div>
        );
      }

      // Chat and shared ticket views are the same container: one width for
      // both, so back-and-forth switching never changes the layout.
      const panelWidth = panelWidthPx;
      const boardWidthStyle = {
        width: `calc(100% - ${panelWidth}px - ${DIVIDER_WIDTH}px)`,
      };

      return (
        <div ref={containerRef} className="flex h-full w-full overflow-hidden">
          <div
            className="h-full min-w-[400px] overflow-hidden"
            style={boardWidthStyle}
          >
            {children}
          </div>

          <button
            type="button"
            aria-label="Resize panel"
            data-testid="panel-divider"
            onMouseDown={startDrag}
            onDoubleClick={resetPanelRatio}
            className={cn(
              "h-full w-[6px] shrink-0 border-l border-r border-border bg-band transition-colors",
              isDragging ? "bg-primary/30" : "hover:bg-primary/20",
            )}
          />

          <aside
            className="h-full min-h-0 shrink-0 border-l border-border bg-card transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: panelWidth }}
            data-testid={
              panelContentMode === "shared"
                ? "unified-panel-shared"
                : "unified-panel-expanded"
            }
          >
            <div className="flex h-full min-h-0 flex-col">
              {hasSharedPanelView && (
                <div className="flex shrink-0 items-center gap-[8px] border-b border-border px-[18px] py-[14px]">
                  <button
                    type="button"
                    onClick={() => setActivePanelContent("chat")}
                    className={cn(
                      "rounded-[7px] px-[10px] py-[4px] text-[13px] transition-colors",
                      panelContentMode === "chat"
                        ? "bg-band font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivePanelContent("shared")}
                    className={cn(
                      "rounded-[7px] px-[10px] py-[4px] text-[13px] transition-colors",
                      panelContentMode === "shared"
                        ? "bg-band font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {sharedPanelView?.label ?? "Details"}
                  </button>

                  <div className="ml-auto flex items-center gap-[2px]">
                    {panelContentMode === "shared" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-meta"
                        onClick={() => sharedPanelView?.onClose?.()}
                        aria-label="Close detail panel"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-meta"
                          onClick={() => setPanelState("collapsed")}
                          aria-label="Collapse panel"
                        >
                          <PanelRightClose className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-meta"
                          onClick={() => setPanelState("hidden")}
                          aria-label="Hide panel"
                        >
                          <EyeOff className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {!hasSharedPanelView && (
                <div className="flex shrink-0 items-center justify-end gap-[2px] border-b border-border px-[18px] py-[10px]">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-meta"
                    onClick={() => setPanelState("collapsed")}
                    aria-label="Collapse panel"
                  >
                    <PanelRightClose className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-meta"
                    onClick={() => setPanelState("hidden")}
                    aria-label="Hide panel"
                  >
                    <EyeOff className="h-4 w-4" />
                  </Button>
                </div>
              )}

              <div className="min-h-0 flex-1">
                {panelContentMode === "shared" ? sharedPanelView?.content : chatWorkspace}
              </div>
            </div>
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
              "relative flex h-full w-[44px] shrink-0 items-center justify-center border-l border-border bg-card text-meta transition-colors hover:bg-band hover:text-foreground",
              hasActiveAgents && "bg-agent-bg text-agent",
            )}
            aria-label="Open chat panel"
            data-testid="collapsed-chat-strip"
          >
            <span className="flex flex-col items-center gap-2 text-[11.5px] font-medium uppercase tracking-[0.14em] [writing-mode:vertical-rl]">
              <MessageSquare className="h-4 w-4 [writing-mode:horizontal-tb]" />
              Chat
            </span>
            {hasActiveAgents && (
              <span
                data-testid="collapsed-active-badge"
                className="breathing-dot absolute top-[8px] right-[8px] h-2 w-2"
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
          className="absolute right-2 top-2 z-30 rounded-full border border-border bg-card p-1.5 text-meta shadow-[0_1px_2px_rgba(36,33,29,.04)] hover:text-foreground"
          aria-label="Show chat strip"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </div>
    );
  },
);
