"use client";

/**
 * DEPENDENCIES on the pool ground (frame 6a, lines 298-308).
 *
 * Read-only: the frame draws rows, not an editor, and the dependency editor
 * is not imported here.
 *
 * This band deliberately does NOT collapse when both relations are empty.
 * The two relation keys ARE the information — "nothing blocks this, this
 * blocks nothing" — and the frame draws exactly that, an em-dash against
 * `WAITS ON`. Never a `0`, never "None".
 */

import {
  BandHeader,
  IdentityChip,
  Mono,
  StrataBand,
  type ProjectTone,
} from "@/components/piscine";
import type { DependencyRowItem } from "@/components/ticket/derive";

export interface DependenciesBandProps {
  blocks: DependencyRowItem[];
  waitsOn: DependencyRowItem[];
  tone: ProjectTone;
  onOpenTicket?: (epicId: string) => void;
}

export function DependenciesBand({
  blocks,
  waitsOn,
  tone,
  onOpenTicket,
}: DependenciesBandProps) {
  return (
    <StrataBand stratum="next" density="rail" gap={8} className="shrink-0">
      <BandHeader
        label="Dependencies"
        stratum="next"
        standalone
        className="gap-[10px]"
      />
      <DependencyRow
        relation="BLOCKS"
        items={blocks}
        tone={tone}
        onOpenTicket={onOpenTicket}
      />
      <DependencyRow
        relation="WAITS ON"
        items={waitsOn}
        tone={tone}
        onOpenTicket={onOpenTicket}
      />
    </StrataBand>
  );
}

function DependencyRow({
  relation,
  items,
  tone,
  onOpenTicket,
}: {
  relation: string;
  items: DependencyRowItem[];
  tone: ProjectTone;
  onOpenTicket?: (epicId: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-2"
      data-testid={`ticket-dependency-${relation.toLowerCase().replace(/\s+/g, "-")}`}
    >
      {/* The fixed 52px is what aligns BLOCKS with WAITS ON. */}
      <Mono size={10} tone="next-mid" className="w-[52px] shrink-0">
        {relation}
      </Mono>
      {items.length === 0 ? (
        <Mono size={11} tone="next-mid">
          —
        </Mono>
      ) : (
        items.map((item) => (
          <span key={item.id} className="flex min-w-0 items-center gap-2">
            <IdentityChip
              label={item.label}
              tone={tone}
              onGround
              onClick={onOpenTicket ? () => onOpenTicket(item.id) : undefined}
            />
            {item.title ? (
              <span className="min-w-0 line-clamp-1 text-[12px] text-strata-next-alt">
                {item.title}
              </span>
            ) : null}
          </span>
        ))
      )}
    </div>
  );
}
