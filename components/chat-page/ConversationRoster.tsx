"use client";

import * as React from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { Conversation } from "@/hooks/useConversations";
import type { DeskProject } from "@/lib/control-desk/types";

import { ChatKnowsCard } from "./ChatKnowsCard";
import { ConversationRosterCard } from "./ConversationRosterCard";
import { NewConversationCard } from "./NewConversationCard";

/**
 * The 300px left column: conversations, the dashed "New conversation" card,
 * and the sunken "LE CHAT SAIT" note pinned to the bottom.
 *
 * THE ROSTER IS SCOPED TO THE ACTIVE PROJECT, AND THAT IS NOT AN OVERSIGHT.
 * Frame 11a samples three rows across three projects. Listing conversations
 * cross-project means calling `GET /api/projects/:id/conversations` once per
 * project — and that route AUTO-CREATES a default "Brainstorm" conversation
 * when a project has none, and runs `runUnifiedChatCutoverMigrationOnce` as a
 * side effect. Fanning it out would write a row into every project in the
 * database as the consequence of *looking at a page*, and a client-side filter
 * afterwards does not help: the write has already happened. Each row still
 * prints the mono `PROJECT · agent · when` line, so the shape matches the
 * frame; the project pill in the composer is what changes the scope.
 */
export interface ConversationRosterProps {
  conversations: readonly Conversation[];
  activeId: string | null;
  project: DeskProject | null;
  /** conversation id → resolved agent label. */
  agentLabels: ReadonlyMap<string, string>;
  /** conversation id → epics produced by it. */
  ticketCounts: ReadonlyMap<string, number>;
  onSelect: (conversationId: string) => void;
  onCreate: (options: { type: string; label: string }) => void;
  onRestartPersistentSession: (conversationId: string) => void;
  createDisabled?: boolean;
  now?: number;
}

export function ConversationRoster({
  conversations,
  activeId,
  project,
  agentLabels,
  ticketCounts,
  onSelect,
  onCreate,
  onRestartPersistentSession,
  createDisabled = false,
  now,
}: ConversationRosterProps) {
  return (
    <div
      data-testid="chat-roster"
      className="flex w-[300px] min-h-0 shrink-0 flex-col gap-[10px]"
    >
      {/*
        The list AND the create card scroll together — the frame draws the
        dashed card immediately under the last conversation, not pinned to the
        foot of the column. Only "LE CHAT SAIT" is pushed down, by its own
        `mt-auto`, which is why the scroll area is the growing child.
      */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-[10px] pr-[6px]">
          {conversations.map((conversation) => (
            <ConversationRosterCard
              key={conversation.id}
              conversation={conversation}
              project={project}
              agentLabel={agentLabels.get(conversation.id) ?? "—"}
              active={conversation.id === activeId}
              ticketCount={ticketCounts.get(conversation.id) ?? 0}
              onSelect={() => onSelect(conversation.id)}
              onRestartPersistentSession={() =>
                onRestartPersistentSession(conversation.id)
              }
              now={now}
            />
          ))}
          <NewConversationCard onCreate={onCreate} disabled={createDisabled} />
        </div>
      </ScrollArea>

      <ChatKnowsCard />
    </div>
  );
}
