"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Sparkles } from "lucide-react";

import { PillButton, SurfaceCard, projectTone } from "@/components/piscine";
import type { AgentSelection } from "@/components/shared/AgentSelectPill";
import { useTicketOverlay } from "@/components/ticket/TicketOverlayProvider";
import { useChat } from "@/hooks/useChat";
import { useControlDesk } from "@/hooks/useControlDesk";
import { useConversations } from "@/hooks/useConversations";
import { useEpicCreate } from "@/hooks/useEpicCreate";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import { usePolling } from "@/hooks/usePolling";
import { useSpecGeneration } from "@/hooks/useSpecGeneration";
import {
  OPENAI_COMPATIBLE_PROVIDER,
  PROVIDER_LABELS,
  type ChatModeProvider,
} from "@/lib/agent-config/constants";
import {
  isBrainstormConversationAgentType,
  isEpicCreationConversationAgentType,
} from "@/lib/chat/conversation-agent";
import { isLegacyConversationGenerating } from "@/lib/chat/parity-contract";
import type { ControlDeskPayload, DeskProject } from "@/lib/control-desk/types";

import {
  agentSelectionPatch,
  selectionForConversation,
} from "./agent-selection";
import { ChatComposer } from "./ChatComposer";
import { ChatThread, type ChatThreadResolvedTicket } from "./ChatThread";
import { ContextRail } from "./ContextRail";
import { ConversationRoster } from "./ConversationRoster";
import { CreatedHereCard, type CreatedHereEntry } from "./CreatedHereCard";
import { TowardSpecBand } from "./TowardSpecBand";
import { useChatContextTokens } from "./chat-context-tokens";
import { epicsByMessageId } from "./message-epics";
import { longPlacement, shortPlacement } from "./placement";

/**
 * Frame 11a — Chat as a full page.
 *
 * Three columns: the conversation roster, the thread + composer, and the
 * context rail. A conversation with a named agent produces TICKETS, and the
 * ticket it produces appears in the thread itself as an actionable card, with
 * no detour through the board.
 *
 * NO 60px HEADER: `components/piscine/TopBar` is mounted once by
 * `app/layout.tsx` and owns the logo, the project chips, ⌘K, the inbox, Auto
 * and "New". This page starts at its own three-column body. It also has no
 * second control row — the frame draws exactly one per-screen control, the
 * project pill inside the composer, and that pill IS the scope control.
 *
 * ESCAPE DOES NOTHING HERE. The panel this replaces collapsed itself on
 * Escape; there is no panel on a page, and `TicketOverlayProvider` owns Escape
 * while a ticket is open. No page-level handler is registered on purpose.
 */
export interface ChatPageViewProps {
  /** `?project=` — the top bar's chips link this way. */
  initialProjectId?: string;
  /** `?conversation=` — a deep link to one conversation. */
  initialConversationId?: string;
}

interface ToastRow {
  id: string;
  tone: "success" | "error";
  message: string;
}

/** Every desk collection that can tell us about a ticket, flattened. */
interface DeskTicket {
  epicId: string;
  readableId: string | null;
  title: string;
  status: string | null;
  rank: number | null;
}

const EPIC_MAP_STORAGE_PREFIX = "arij.chat.epic-by-message.";

function normalizeTitle(title: string | null | undefined): string {
  return (title ?? "").trim().toLowerCase();
}

/**
 * The in-thread cards' identity has to survive a reload, and the in-memory map
 * does not. Storage is best-effort in both directions: a corrupt or
 * unavailable store falls through to the title heuristics, and never throws.
 */
function readStoredEpicMap(conversationId: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = window.localStorage.getItem(
      `${EPIC_MAP_STORAGE_PREFIX}${conversationId}`,
    );
    if (!raw) return map;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
    for (const [messageId, epicId] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof epicId === "string" && epicId) map.set(messageId, epicId);
    }
  } catch {
    // Private mode, a quota error, a hand-edited value — all the same answer.
  }
  return map;
}

function writeStoredEpicMap(conversationId: string, map: Map<string, string>) {
  try {
    window.localStorage.setItem(
      `${EPIC_MAP_STORAGE_PREFIX}${conversationId}`,
      JSON.stringify(Object.fromEntries(map)),
    );
  } catch {
    // Storage is an optimisation here, never a requirement.
  }
}

function flattenDeskTickets(data: ControlDeskPayload | null): DeskTicket[] {
  if (!data) return [];
  const rows: DeskTicket[] = [];

  for (const project of data.upNext) {
    for (const ticket of project.tickets) {
      rows.push({
        epicId: ticket.epicId,
        readableId: ticket.readableId,
        title: ticket.title,
        status: ticket.status,
        rank: ticket.rank,
      });
    }
  }
  for (const row of data.readyToLand) {
    rows.push({
      epicId: row.epicId,
      readableId: row.readableId,
      title: row.title,
      status: null,
      rank: null,
    });
  }
  for (const row of data.working) {
    if (!row.epicId) continue;
    rows.push({
      epicId: row.epicId,
      readableId: row.readableId,
      title: row.title,
      status: null,
      rank: null,
    });
  }
  for (const row of data.queued) {
    if (!row.epicId) continue;
    rows.push({
      epicId: row.epicId,
      readableId: row.readableId,
      title: row.title,
      status: null,
      rank: null,
    });
  }
  for (const row of data.yourTurn.awaitingReply) {
    rows.push({
      epicId: row.epicId,
      readableId: row.readableId,
      title: row.title,
      status: null,
      rank: null,
    });
  }
  for (const row of data.yourTurn.failed) {
    rows.push({
      epicId: row.epicId,
      readableId: row.readableId,
      title: row.title,
      status: null,
      rank: null,
    });
  }
  for (const row of data.yourTurn.conflicts) {
    rows.push({
      epicId: row.epicId,
      readableId: row.readableId,
      title: row.title,
      status: null,
      rank: null,
    });
  }

  return rows;
}

export function ChatPageView({
  initialProjectId,
  initialConversationId,
}: ChatPageViewProps) {
  const router = useRouter();
  const { openTicket } = useTicketOverlay();

  /*
    ONE cross-project read, at 8s. The desk polls itself at 4s because it is a
    supervision screen; this one needs the project list, the readable ids and
    the queue ranks, none of which move that fast.
  */
  const { data: desk, refresh: refreshDesk } = useControlDesk(null, 8000);
  const projects: readonly DeskProject[] = React.useMemo(
    () => desk?.projects ?? [],
    [desk],
  );

  const [chosenProjectId, setChosenProjectId] = React.useState<string | null>(
    initialProjectId ?? null,
  );
  React.useEffect(() => {
    if (initialProjectId) setChosenProjectId(initialProjectId);
  }, [initialProjectId]);

  const activeProjectId =
    chosenProjectId && projects.some((row) => row.id === chosenProjectId)
      ? chosenProjectId
      : (chosenProjectId ?? projects[0]?.id ?? null);
  const project =
    projects.find((row) => row.id === activeProjectId) ?? null;
  const tone = projectTone(project?.colorIndex ?? 0);

  const [toasts, setToasts] = React.useState<ToastRow[]>([]);
  const raise = React.useCallback(
    (tone: "success" | "error", message: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((current) => [...current, { id, tone, message }]);
      setTimeout(
        () => setToasts((current) => current.filter((row) => row.id !== id)),
        5000,
      );
    },
    [],
  );

  return (
    <div
      data-testid="chat-page"
      className="flex h-full min-h-0 w-full flex-col bg-background font-sans text-foreground"
    >
      {activeProjectId ? (
        <ChatWorkspace
          // Remounting on a project switch is the point: conversations, the
          // thread, the staged attachments and the per-conversation epic map
          // all belong to ONE project and must not leak across a change.
          key={activeProjectId}
          projectId={activeProjectId}
          projects={projects}
          project={project}
          tone={tone}
          desk={desk}
          initialConversationId={initialConversationId}
          onSelectProject={setChosenProjectId}
          onToast={raise}
          onDeskChanged={refreshDesk}
          openTicket={openTicket}
          router={router}
        />
      ) : (
        <EmptyChatWorkspace />
      )}

      {toasts.length > 0 ? (
        <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
          {/*
            The body stays ink whatever the tone. A toast floats over the page
            and belongs to no stratum, so it has no deep to borrow — the
            failure is in the wording and in the icon beside it.
          */}
          {toasts.map((toast) => (
            <SurfaceCard
              key={toast.id}
              radius={11}
              data-testid="chat-toast"
              className="flex items-center gap-2 px-[14px] py-[10px] font-sans text-[13px] text-foreground"
            >
              {toast.tone === "success" ? null : (
                <AlertTriangle
                  size={13}
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground"
                />
              )}
              <span>{toast.message}</span>
            </SurfaceCard>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** No conversation to run: the pill names nothing rather than a default. */
const EMPTY_AGENT_SELECTION: AgentSelection = {
  namedAgentId: null,
  provider: null,
};

/**
 * The page with no project to scope to — while the desk read is in flight, or
 * because the database has none.
 *
 * Every band collapses to its label line and the composer is disabled with an
 * em-dash project pill. NO fake project, no spinner sentence: the empty state
 * is the screen's own shape with nothing in it.
 */
function EmptyChatWorkspace() {
  const emptyTokens = React.useMemo(
    () => ({ spec: null, memory: null, citedDocs: [] }),
    [],
  );
  return (
    <div className="flex min-h-0 flex-1 gap-3 px-[14px] pt-[14px] pb-[14px]">
      <ConversationRoster
        conversations={[]}
        activeId={null}
        project={null}
        agentLabels={new Map()}
        ticketCounts={new Map()}
        onSelect={() => {}}
        onCreate={() => {}}
        onRestartPersistentSession={() => {}}
        createDisabled
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[10px]">
        <div className="min-h-0 flex-1" />
        <ChatComposer
          projectId={null}
          projects={[]}
          project={null}
          onSelectProject={() => {}}
          agentSelection={EMPTY_AGENT_SELECTION}
          onSelectAgent={() => {}}
          agentLocked
          disabled
          onSend={() => {}}
        />
      </div>
      <div className="flex w-[300px] shrink-0 flex-col gap-[10px]">
        <ContextRail tokens={emptyTokens} />
        <CreatedHereCard entries={[]} tone={1} onOpenTicket={() => {}} />
        <TowardSpecBand available={false} pending={false} onPropose={() => {}} />
      </div>
    </div>
  );
}

interface ChatWorkspaceProps {
  projectId: string;
  projects: readonly DeskProject[];
  project: DeskProject | null;
  tone: ReturnType<typeof projectTone>;
  desk: ControlDeskPayload | null;
  initialConversationId?: string;
  onSelectProject: (projectId: string) => void;
  onToast: (tone: "success" | "error", message: string) => void;
  onDeskChanged: () => void;
  openTicket: (epicId: string, options?: { projectId?: string | null }) => void;
  router: ReturnType<typeof useRouter>;
}

function ChatWorkspace({
  projectId,
  projects,
  project,
  tone,
  desk,
  initialConversationId,
  onSelectProject,
  onToast,
  onDeskChanged,
  openTicket,
  router,
}: ChatWorkspaceProps) {
  const {
    conversations,
    activeId,
    setActiveId,
    createConversation,
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
    sendMessage,
    answerQuestions,
  } = useChat(projectId, activeId);

  const { agents } = useNamedAgentsList();

  const activeConversation = React.useMemo(
    () => conversations.find((row) => row.id === activeId) ?? null,
    [conversations, activeId],
  );

  const activeProvider = activeConversation?.provider || "claude-code";
  const {
    generateSpec,
    generating: generatingSpec,
    error: specError,
  } = useSpecGeneration(projectId, activeProvider);

  const {
    createEpic,
    isLoading: epicCreating,
    error: epicError,
  } = useEpicCreate({
    projectId,
    conversationId: activeId,
    sendMessage,
  });

  /* ---- conversation bookkeeping, lifted from UnifiedChatPanel ---------- */

  // The deep link only applies while the conversation it names still exists,
  // and only once: after that the user's own selection wins.
  const deepLinkApplied = React.useRef(false);
  React.useEffect(() => {
    if (deepLinkApplied.current || !initialConversationId) return;
    if (!conversations.some((row) => row.id === initialConversationId)) return;
    deepLinkApplied.current = true;
    setActiveId(initialConversationId);
  }, [conversations, initialConversationId, setActiveId]);

  // Deleting or losing the active conversation must not blank the thread.
  React.useEffect(() => {
    if (conversations.length === 0) return;
    if (!activeId || !conversations.some((row) => row.id === activeId)) {
      setActiveId(conversations[0].id);
    }
  }, [activeId, conversations, setActiveId]);

  // The conversation row's status flips to `generated` SERVER-side after the
  // stream closes; without this catch-up the roster keeps showing the busy
  // state for a turn that finished.
  const previousSending = React.useRef(sending);
  React.useEffect(() => {
    if (previousSending.current && !sending) {
      const timer = setTimeout(() => void refreshConversations(), 3000);
      previousSending.current = sending;
      return () => clearTimeout(timer);
    }
    previousSending.current = sending;
  }, [sending, refreshConversations]);

  usePolling(refreshConversations, 3000, true, { immediate: false });

  /* ---- who is talking -------------------------------------------------- */

  const agentLabelFor = React.useCallback(
    (conversation: { namedAgentId?: string | null; provider: string }) => {
      if (conversation.namedAgentId) {
        const named = agents?.find((row) => row.id === conversation.namedAgentId);
        if (named?.name) return named.name;
      }
      const provider = conversation.provider;
      return (
        PROVIDER_LABELS[provider as ChatModeProvider] ??
        provider ??
        "—"
      );
    },
    [agents],
  );

  const agentLabels = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const conversation of conversations) {
      map.set(conversation.id, agentLabelFor(conversation));
    }
    return map;
  }, [conversations, agentLabelFor]);

  const activeAgentLabel = activeConversation
    ? agentLabelFor(activeConversation)
    : "—";

  /**
   * What the composer's pill selects on. `agentLabelFor` stays: the thread and
   * the roster name the same agent, and only the pill derives its own label.
   */
  const activeAgentSelection: AgentSelection = React.useMemo(
    () => selectionForConversation(activeConversation),
    [activeConversation],
  );

  /* ---- per-message epics ----------------------------------------------- */

  // Memoised over `messages`: the JSON candidate scan is O(content) per
  // message, which is fine per change and NOT fine per render.
  const epicsByMessage = React.useMemo(
    () => epicsByMessageId(messages),
    [messages],
  );

  const [epicByMessage, setEpicByMessage] = React.useState<Map<string, string>>(
    () => new Map(),
  );
  /** Status seeded by the create response, so placement never starts at `—`. */
  const [createdMeta, setCreatedMeta] = React.useState<
    Map<string, { readableId: string | null; status: string }>
  >(() => new Map());

  // Reload restores the exact bindings; the heuristics below are the fallback.
  React.useEffect(() => {
    if (!activeId) {
      setEpicByMessage(new Map());
      return;
    }
    setEpicByMessage(readStoredEpicMap(activeId));
  }, [activeId]);

  const recordEpicBinding = React.useCallback(
    (
      messageId: string,
      created: { epicId: string; readableId: string | null; status: string },
    ) => {
      setEpicByMessage((current) => {
        const next = new Map(current);
        next.set(messageId, created.epicId);
        if (activeId) writeStoredEpicMap(activeId, next);
        return next;
      });
      setCreatedMeta((current) => {
        const next = new Map(current);
        next.set(created.epicId, {
          readableId: created.readableId,
          status: created.status,
        });
        return next;
      });
      onDeskChanged();
    },
    [activeId, onDeskChanged],
  );

  const deskTickets = React.useMemo(() => flattenDeskTickets(desk), [desk]);
  const ticketsById = React.useMemo(() => {
    const map = new Map<string, DeskTicket>();
    for (const row of deskTickets) {
      // The status-bearing row (upNext) is inserted first and must win.
      if (!map.has(row.epicId) || map.get(row.epicId)?.status === null) {
        map.set(row.epicId, row);
      }
    }
    return map;
  }, [deskTickets]);

  /**
   * §7.4(c): the map is gone after a reload with no storage. Recover the
   * binding from the conversation's own epic link when exactly one message
   * declares an epic with that title, then from the desk's tickets by title.
   * A card that resolves to nothing is still fully actionable — that is the
   * point — but it must never show a `readableId` it did not resolve.
   */
  const resolvedEpicByMessage = React.useMemo(() => {
    const map = new Map(epicByMessage);

    const linkedEpicId = activeConversation?.epicId ?? null;
    const linked = linkedEpicId ? ticketsById.get(linkedEpicId) : null;
    if (linked) {
      const matches = [...epicsByMessage.entries()].filter(
        ([, parsed]) => normalizeTitle(parsed.title) === normalizeTitle(linked.title),
      );
      if (matches.length === 1 && !map.has(matches[0][0])) {
        map.set(matches[0][0], linked.epicId);
      }
    }

    const byTitle = new Map<string, DeskTicket>();
    for (const row of deskTickets) {
      const key = normalizeTitle(row.title);
      if (key && !byTitle.has(key)) byTitle.set(key, row);
    }
    for (const [messageId, parsed] of epicsByMessage) {
      if (map.has(messageId)) continue;
      const hit = byTitle.get(normalizeTitle(parsed.title));
      if (hit) map.set(messageId, hit.epicId);
    }

    return map;
  }, [epicByMessage, epicsByMessage, activeConversation, ticketsById, deskTickets]);

  const resolveTicket = React.useCallback(
    (epicId: string): ChatThreadResolvedTicket => {
      const row = ticketsById.get(epicId);
      const seeded = createdMeta.get(epicId);
      const readableId = row?.readableId ?? seeded?.readableId ?? null;
      const placement =
        longPlacement(row?.status ?? null, row?.rank ?? null) ??
        longPlacement(seeded?.status ?? null, null);
      return { readableId, placement };
    },
    [ticketsById, createdMeta],
  );

  /* ---- "Créé dans ce chat" --------------------------------------------- */

  const createdHere: CreatedHereEntry[] = React.useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const push = (epicId: string | null | undefined) => {
      if (!epicId || seen.has(epicId)) return;
      seen.add(epicId);
      ids.push(epicId);
    };

    push(activeConversation?.epicId);
    for (const epicId of resolvedEpicByMessage.values()) push(epicId);

    return ids.map((epicId) => {
      const row = ticketsById.get(epicId);
      const seeded = createdMeta.get(epicId);
      const parsed = [...resolvedEpicByMessage.entries()].find(
        ([, id]) => id === epicId,
      );
      const parsedTitle = parsed ? epicsByMessage.get(parsed[0])?.title : null;
      return {
        epicId,
        readableId: row?.readableId ?? seeded?.readableId ?? null,
        title: row?.title ?? parsedTitle ?? null,
        placement:
          shortPlacement(row?.status ?? null, row?.rank ?? null) ??
          shortPlacement(seeded?.status ?? null, null),
      };
    });
  }, [
    activeConversation,
    resolvedEpicByMessage,
    ticketsById,
    createdMeta,
    epicsByMessage,
  ]);

  const ticketCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    // Only the ACTIVE conversation's messages are loaded, so it is the only
    // row whose count is knowable. The others simply omit the line rather than
    // printing a number this page did not measure.
    if (activeId) map.set(activeId, createdHere.length);
    return map;
  }, [activeId, createdHere.length]);

  /* ---- context rail ---------------------------------------------------- */

  const contextTokens = useChatContextTokens(projectId, messages);

  /* ---- sending --------------------------------------------------------- */

  const [sendStartedAt, setSendStartedAt] = React.useState<string | null>(null);

  const hasMessages = messages.length > 0;
  const hasUserMessage = messages.some((message) => message.role === "user");
  const hasAssistantMessage = messages.some(
    (message) => message.role === "assistant" && message.content.trim().length > 0,
  );
  // Busy also covers "the user switched away mid-generation and came back":
  // useChat has no live stream then, but the DB row still says `generating`.
  // Without it the composer re-enables and the user double-fires a turn.
  const busy =
    sending || isLegacyConversationGenerating(activeConversation?.status);

  const handleSend = React.useCallback(
    (content: string, attachmentIds: string[]) => {
      if (!activeId) return;
      setSendStartedAt(new Date().toISOString());
      void sendMessage(content, attachmentIds);
    },
    [activeId, sendMessage],
  );

  const handleCreateConversation = React.useCallback(
    (options: { type: string; label: string }) => {
      void createConversation(options);
    },
    [createConversation],
  );

  const handleSelectAgent = React.useCallback(
    (choice: AgentSelection) => {
      // The agent cannot change mid-conversation.
      if (!activeId || hasMessages) return;
      const patch = agentSelectionPatch(choice);
      if (!patch) return;
      void updateConversation(activeId, patch);
    },
    [activeId, hasMessages, updateConversation],
  );

  /* ---- "Proposer l'ajout" ---------------------------------------------- */

  const [proposing, setProposing] = React.useState(false);
  const [specHref, setSpecHref] = React.useState<string | null>(null);

  const proposeSpecAddition = React.useCallback(async () => {
    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.content.trim());
    if (!lastAssistant) return;

    setProposing(true);
    try {
      const instruction = `Intègre à la spec la décision prise dans cette conversation :\n${lastAssistant.content.slice(0, 4000)}`;
      const res = await fetch(`/api/projects/${projectId}/spec/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        // 409 SPEC_UPDATE_PENDING and 400 (stale named agent) both carry a
        // readable `error`. Neither is retried: a second rewrite would race
        // the first, last-write-wins.
        onToast("error", body.error || "Failed to propose the spec addition");
        return;
      }
      setSpecHref(`/projects/${projectId}/spec`);
      onToast("success", "Proposition envoyée à la spec");
    } catch {
      onToast("error", "Failed to propose the spec addition");
    } finally {
      setProposing(false);
    }
  }, [messages, projectId, onToast]);

  /* ---- the fallback epic path ------------------------------------------ */

  const isEpicCreation = isEpicCreationConversationAgentType(
    activeConversation?.type,
  );
  const isBrainstorm = isBrainstormConversationAgentType(
    activeConversation?.type,
  );
  // The moment ANY message parses to an epic, the in-thread cards take over.
  const showEpicFallback =
    isEpicCreation && hasUserMessage && epicsByMessage.size === 0;

  async function handleCreateEpicFallback() {
    const epicId = await createEpic();
    if (epicId) {
      onDeskChanged();
      router.refresh();
    }
  }

  const footer =
    showEpicFallback || isBrainstorm ? (
      <div className="flex flex-wrap gap-2 px-2 pt-1">
        {showEpicFallback ? (
          <PillButton
            variant="outline"
            size="sm"
            icon={Sparkles}
            pending={epicCreating}
            pendingLabel="Création…"
            onClick={() => void handleCreateEpicFallback()}
          >
            Create Epic &amp; Generate Stories
          </PillButton>
        ) : null}
        {isBrainstorm ? (
          <PillButton
            variant="outline"
            size="sm"
            icon={Sparkles}
            pending={generatingSpec}
            pendingLabel="Génération…"
            onClick={generateSpec}
          >
            Generate Spec &amp; Plan
          </PillButton>
        ) : null}
      </div>
    ) : null;

  const emptyMessage = isEpicCreation
    ? "Describe your epic idea and I'll help you structure it with user stories and acceptance criteria."
    : "Start a conversation to brainstorm your project with Claude";

  return (
    <div className="flex min-h-0 flex-1 gap-3 px-[14px] pt-[14px] pb-[14px]">
      <ConversationRoster
        conversations={conversations}
        activeId={activeId}
        project={project}
        agentLabels={agentLabels}
        ticketCounts={ticketCounts}
        onSelect={setActiveId}
        onCreate={handleCreateConversation}
        onRestartPersistentSession={(conversationId) =>
          void restartPersistentSession(conversationId)
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[10px]">
        <ChatThread
          projectId={projectId}
          messages={messages}
          loading={loading}
          sending={sending}
          streamStatus={streamStatus}
          agentLabel={activeAgentLabel}
          sendStartedAt={sendStartedAt}
          epicsByMessage={epicsByMessage}
          epicIdByMessage={resolvedEpicByMessage}
          resolveTicket={resolveTicket}
          tone={tone}
          namedAgentId={activeConversation?.namedAgentId ?? null}
          onEpicCreated={recordEpicBinding}
          onOpenTicket={(epicId) => openTicket(epicId, { projectId })}
          onToast={onToast}
          error={epicError || specError || chatError}
          pendingQuestions={pendingQuestions}
          onAnswerQuestions={answerQuestions}
          busy={busy}
          emptyMessage={emptyMessage}
          footer={footer}
        />

        <ChatComposer
          projectId={projectId}
          projects={projects}
          project={project}
          onSelectProject={onSelectProject}
          agentSelection={activeAgentSelection}
          onSelectAgent={handleSelectAgent}
          agentLocked={!activeId || hasMessages}
          attachmentsDisabled={activeProvider === OPENAI_COMPATIBLE_PROVIDER}
          disabled={busy || !activeConversation}
          onSend={handleSend}
        />
      </div>

      <div className="flex w-[300px] shrink-0 flex-col gap-[10px]">
        <ContextRail tokens={contextTokens} />
        <CreatedHereCard
          entries={createdHere}
          tone={tone}
          onOpenTicket={(epicId) => openTicket(epicId, { projectId })}
        />
        <TowardSpecBand
          available={hasAssistantMessage}
          pending={proposing}
          onPropose={() => void proposeSpecAddition()}
          specHref={specHref}
        />
      </div>
    </div>
  );
}
