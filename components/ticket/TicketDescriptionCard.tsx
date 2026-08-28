"use client";

/**
 * The white description card at the top of the overlay's left column
 * (frame 6a, lines 217-220): markdown body + one mono meta line.
 *
 * Inline editing of the title and the description is deliberately dropped in
 * the redesign — the frame draws no affordance for either, and `updateEpic`
 * stays wired for status and priority only. The markdown renderer is the same
 * one `components/kanban/InlineEdit.tsx` used, so stored descriptions render
 * exactly as they did in the old panel.
 */

import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { Mono, SurfaceCard } from "@/components/piscine";

export interface TicketDescriptionCardProps {
  description: string | null;
  meta: string;
}

export function TicketDescriptionCard({
  description,
  meta,
}: TicketDescriptionCardProps) {
  const body = description?.trim() ? description : null;
  if (!body && !meta) return null;

  return (
    <SurfaceCard
      radius={12}
      className="shrink-0 px-4 py-[13px]"
      data-testid="ticket-description"
    >
      {body ? (
        <div className="text-[13.5px] leading-[1.55] text-foreground">
          <MarkdownContent content={body} />
        </div>
      ) : null}
      {meta ? (
        <Mono
          as="span"
          size={10.5}
          tone="muted"
          className={body ? "mt-2 block" : "block"}
        >
          {meta}
        </Mono>
      ) : null}
    </SurfaceCard>
  );
}
