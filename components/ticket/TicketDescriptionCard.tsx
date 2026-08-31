"use client";

/**
 * The white description card at the top of the overlay's left column
 * (frame 6a, lines 217-220): markdown body, the bug's screenshots, and one
 * mono meta line.
 *
 * Inline editing of the title and the description is deliberately dropped in
 * the redesign — the frame draws no affordance for either, and `updateEpic`
 * stays wired for status and priority only. The markdown renderer is the same
 * one `components/kanban/InlineEdit.tsx` used, so stored descriptions render
 * exactly as they did in the old panel.
 *
 * The card disappears entirely only when it would have nothing at all to
 * show: an image-only bug report (no prose, no meta) still gets its card.
 */

import * as React from "react";

import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { Mono, SurfaceCard } from "@/components/piscine";
import { TicketScreenshots } from "@/components/ticket/TicketScreenshots";
import { parseTicketImages } from "@/lib/uploads/ticket-images";

export interface TicketDescriptionCardProps {
  description: string | null;
  meta: string;
  /** Scopes the upload URLs; without it no image is servable, so none render. */
  projectId?: string;
  /** Raw `epics.images` JSON, exactly as the API hands it over. */
  images?: string | null;
}

export function TicketDescriptionCard({
  description,
  meta,
  projectId,
  images,
}: TicketDescriptionCardProps) {
  const body = description?.trim() ? description : null;

  const screenshots = React.useMemo(
    () => (projectId ? parseTicketImages(images, projectId) : []),
    [images, projectId],
  );

  if (!body && !meta && screenshots.length === 0) return null;

  return (
    <SurfaceCard
      radius={12}
      className="flex shrink-0 flex-col gap-[10px] px-4 py-[13px]"
      data-testid="ticket-description"
    >
      {body ? (
        <div className="text-[13.5px] leading-[1.55] text-foreground">
          <MarkdownContent content={body} />
        </div>
      ) : null}
      <TicketScreenshots images={screenshots} />
      {meta ? (
        <Mono as="span" size={10.5} tone="muted">
          {meta}
        </Mono>
      ) : null}
    </SurfaceCard>
  );
}
