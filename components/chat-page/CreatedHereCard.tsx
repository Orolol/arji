"use client";

import * as React from "react";

import { BandHeader, IdentityChip, Mono, StrataBand } from "@/components/piscine";
import type { ProjectTone } from "@/lib/piscine/tokens";

/**
 * "Créé dans ce chat" — what this conversation has produced (frame 11a, right rail).
 *
 * WHERE THE LIST COMES FROM. A conversation is linked to at most ONE epic
 * (`chat_conversations.epic_id`), and the frame shows two — so the list is the
 * union of that link and every epic this page created from this conversation
 * during the session. There is no `chat_message_epics` table and this packet
 * does not add one.
 *
 * An entry the desk payload has not caught up with (or has retired) renders
 * with an em-dash placement, never a fabricated one. With nothing created at
 * all the band folds to its label line — no placeholder row.
 */
export interface CreatedHereEntry {
  epicId: string;
  readableId: string | null;
  title: string | null;
  /** `draft`, `To Do #4`, `Backlog` — or null for an em-dash. */
  placement: string | null;
}

export interface CreatedHereCardProps {
  entries: readonly CreatedHereEntry[];
  tone: ProjectTone;
  onOpenTicket: (epicId: string) => void;
}

export function CreatedHereCard({
  entries,
  tone,
  onOpenTicket,
}: CreatedHereCardProps) {
  return (
    <StrataBand
      stratum="card"
      gap={8}
      className="rounded-[14px] px-[15px] py-[13px]"
    >
      <BandHeader
        stratum="card"
        label="Créé dans ce chat"
        labelSize={12}
        standalone
      />

      {entries.map((entry) => (
        <button
          key={entry.epicId}
          type="button"
          data-testid="chat-created-here-row"
          onClick={() => onOpenTicket(entry.epicId)}
          className="flex items-center gap-2 rounded-[8px] bg-transparent p-0 text-left outline-none transition-colors hover:brightness-[0.97] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
        >
          <IdentityChip label={entry.readableId ?? "—"} tone={tone} size="sm" />
          <span className="line-clamp-1 text-[12px] text-foreground">
            {entry.title ?? "—"}
          </span>
          <Mono size={10} tone="muted" className="ml-auto shrink-0">
            {entry.placement ?? "—"}
          </Mono>
        </button>
      ))}
    </StrataBand>
  );
}
