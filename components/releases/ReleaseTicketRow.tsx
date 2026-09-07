"use client";

import { useTranslations } from "next-intl";

import {
  CheckMark,
  IdentityChip,
  Mono,
  SurfaceCard,
  type ProjectTone,
} from "@/components/piscine";

/** The identity a row needs. An id recorded by a release whose epic was since
 *  deleted still renders — with an em-dash title — rather than vanishing. */
export interface ReleaseTicketEpic {
  id: string;
  title: string;
  readableId?: string | null;
}

export interface ReleaseTicketRowProps {
  epic: ReleaseTicketEpic;
  /** Project identity colour. Never ticket state — that is rule (1). */
  tone: ProjectTone;
  checked: boolean;
  /** Why this ticket is not included, e.g. "2 stories left". */
  reason: string | null;
  /** Trailing text for an included ticket, e.g. "merged 2h ago". */
  meta: string | null;
  onToggle?: () => void;
  readOnly?: boolean;
}

/**
 * One candidate ticket in the NEXT RELEASE band (and one recorded ticket in
 * inspect mode).
 *
 * The row is NOT a button: only the check square toggles. Nothing on this
 * screen opens the ticket overlay — that belongs to the board.
 *
 * `display:contents` on the testid wrapper keeps SurfaceCard as the direct
 * flex child of the list, so the 7px list gap still applies to the card itself.
 * SurfaceCard takes no `data-*` props and must not be forked to gain one.
 */
export function ReleaseTicketRow({
  epic,
  tone,
  checked,
  reason,
  meta,
  onToggle,
  readOnly = false,
}: ReleaseTicketRowProps) {
  const t = useTranslations("Releases");

  return (
    <div className="contents" data-testid={`release-ticket-row-${epic.id}`}>
      <SurfaceCard
        radius={11}
        translucent={!checked}
        className="flex items-center gap-[11px] px-[13px] py-[10px]"
      >
        <span className="contents" data-testid={`release-ticket-check-${epic.id}`}>
          <CheckMark
            shape="square"
            tone="action"
            checked={checked}
            onToggle={readOnly ? undefined : onToggle}
          />
        </span>

        <IdentityChip
          size="sm"
          tone={tone}
          label={epic.readableId || epic.id.slice(0, 8)}
        />

        <span
          title={epic.title}
          className={`line-clamp-1 min-w-0 flex-1 text-[13px] font-medium ${
            checked ? "text-foreground" : "text-strata-land-mid"
          }`}
        >
          {epic.title}
        </span>

        {checked ? (
          meta ? (
            <Mono size={10.5} tone="muted" className="shrink-0">
              {meta}
            </Mono>
          ) : null
        ) : reason ? (
          // One of the screen's exactly two loud colours. --strata-you-deep and
          // --destructive resolve to the same value; the strata name is the
          // right one here because the row is printed on a strata ground.
          <Mono size={10.5} tone="you-deep" className="shrink-0">
            {reason}
          </Mono>
        ) : (
          <Mono size={10.5} tone="muted" className="shrink-0">
            {t("ticketRow.notIncluded")}
          </Mono>
        )}
      </SurfaceCard>
    </div>
  );
}
