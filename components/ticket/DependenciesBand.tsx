"use client";

/**
 * DEPENDENCIES on the pool ground (frame 6a, lines 298-308).
 *
 * The frame draws rows, not an editor — but a dependency the UI can read and
 * never write is a capability the redesign dropped, so the smallest honest
 * affordance sits in the band header: ONE `SelectPill` whose menu lists the
 * project's other tickets with a check against the ones this ticket waits on.
 * Ticking toggles and saves immediately. No new band, no second control, and
 * the rows below stay exactly what the frame draws.
 *
 * ONLY `WAITS ON` IS EDITABLE, and that is the data model, not a shortcut:
 * `PUT …/dependencies` replaces THIS ticket's predecessor list, so a BLOCKS
 * edge belongs to the ticket on the other end and is edited from there. The
 * route re-checks for cycles; its refusal lands under the rows.
 *
 * This band deliberately does NOT collapse when both relations are empty.
 * The two relation keys ARE the information — "nothing blocks this, this
 * blocks nothing" — and the frame draws exactly that, an em-dash against
 * `WAITS ON`. Never a `0`, never "None".
 */

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  BandHeader,
  IdentityChip,
  Mono,
  SelectPill,
  StrataBand,
  type ProjectTone,
} from "@/components/piscine";
import type {
  DependencyOption,
  DependencyRowItem,
} from "@/components/ticket/derive";

export interface DependenciesBandProps {
  blocks: DependencyRowItem[];
  waitsOn: DependencyRowItem[];
  tone: ProjectTone;
  onOpenTicket?: (epicId: string) => void;
  /** The project's other tickets, each carrying its current selection. */
  options?: DependencyOption[];
  /** Add or drop one WAITS ON edge. Omit to render the band read-only. */
  onToggleWaitsOn?: (epicId: string) => void;
  saving?: boolean;
  /** The route's refusal — a cycle, most often. */
  error?: string | null;
}

export function DependenciesBand({
  blocks,
  waitsOn,
  tone,
  onOpenTicket,
  options,
  onToggleWaitsOn,
  saving = false,
  error = null,
}: DependenciesBandProps) {
  const t = useTranslations("Ticket");
  const editable = Boolean(onToggleWaitsOn);

  return (
    <StrataBand stratum="next" density="rail" gap={8} className="shrink-0">
      <BandHeader
        label={t("dependencies.label")}
        stratum="next"
        // `standalone` hugs the underline to the word, which only works while
        // the header has nothing on its right. With the editor it must span
        // the band so `ml-auto` has something to push against.
        standalone={!editable}
        className="gap-[10px]"
        right={
          editable ? (
            <span data-testid="ticket-dependency-editor">
              <SelectPill
                label={t("dependencies.edit")}
                tone="ink"
                fill="card"
                // No other ticket in the project = nothing to depend on. The
                // pill stays, disabled: "there is nothing to pick" is itself
                // information, and hiding it would read as a missing feature.
                disabled={!options || options.length === 0 || saving}
              >
                {(options ?? []).map((option) => (
                  <DropdownMenuItem
                    key={option.id}
                    onSelect={() => onToggleWaitsOn?.(option.id)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {/* Fixed 12px gutter so ticked and unticked rows align. */}
                      <span className="inline-flex w-3 shrink-0 justify-center">
                        {option.selected ? (
                          <Check size={12} aria-hidden="true" />
                        ) : null}
                      </span>
                      <Mono size={11} weight={700} tone="ink">
                        {option.label}
                      </Mono>
                      {option.title ? (
                        <span className="min-w-0 line-clamp-1 text-[12px]">
                          {option.title}
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                ))}
              </SelectPill>
            </span>
          ) : undefined
        }
      />
      <DependencyRow
        slug="blocks"
        relation={t("dependencies.blocks")}
        items={blocks}
        tone={tone}
        onOpenTicket={onOpenTicket}
      />
      <DependencyRow
        slug="waits-on"
        relation={t("dependencies.waitsOn")}
        items={waitsOn}
        tone={tone}
        onOpenTicket={onOpenTicket}
      />
      {error ? (
        <p
          data-testid="ticket-dependency-error"
          className="m-0 text-[12px] leading-[1.5] text-destructive"
        >
          {error}
        </p>
      ) : null}
    </StrataBand>
  );
}

function DependencyRow({
  slug,
  relation,
  items,
  tone,
  onOpenTicket,
}: {
  /**
   * The relation's stable identity, for the test hook. Separate from the
   * printed `relation` on purpose: the label is catalogue copy now, so
   * deriving the testid from it would rename the hook in every language.
   */
  slug: string;
  relation: string;
  items: DependencyRowItem[];
  tone: ProjectTone;
  onOpenTicket?: (epicId: string) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`ticket-dependency-${slug}`}
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
