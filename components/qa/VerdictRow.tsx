"use client";

import { Check, ShieldAlert } from "lucide-react";

import { IdentityChip, Mono, SurfaceCard, projectTone } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaVerdict } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

/**
 * One line of VERDICTS RÉCENTS: what the last review on this ticket concluded,
 * and where the ticket went.
 *
 * THE ONE PLACE ON THIS SCREEN A COLOUR LEANS ON STATE, and it is allowed
 * because the arrow names a DESTINATION STRATUM rather than a status: "→ your
 * turn" is drawn in the coral deep because coral is where the ticket went. The
 * other two arrows are muted; the verdict itself is told by an icon and a word,
 * never by a colour.
 */
export interface VerdictRowProps {
  verdict: QaVerdict;
  project: DeskProject | undefined;
  onOpenTicket?: (epicId: string) => void;
  className?: string;
}

export function VerdictRow({
  verdict,
  project,
  onOpenTicket,
  className,
}: VerdictRowProps) {
  const Icon = verdict.kind === "clean" ? Check : ShieldAlert;

  return (
    <SurfaceCard
      radius={10}
      interactive={Boolean(onOpenTicket)}
      onClick={() => onOpenTicket?.(verdict.epicId)}
      data-testid="qa-verdict-row"
      data-kind={verdict.kind}
      className={cn(
        "flex items-center gap-[10px] px-[12px] py-[8px]",
        className,
      )}
    >
      <Icon
        size={13}
        aria-hidden="true"
        className={cn(
          "shrink-0",
          verdict.kind === "clean"
            ? "text-strata-live-deep"
            : "text-strata-you-deep",
        )}
      />
      <IdentityChip
        label={verdict.readableId ?? project?.shortName ?? "—"}
        tone={projectTone(project?.colorIndex ?? 0)}
        size="sm"
      />
      <span className="line-clamp-1 min-w-0 flex-1 font-sans text-[12.5px] text-foreground">
        {verdict.verdictText}
      </span>
      <Mono
        size={10}
        tone={verdict.outcome === "→ your turn" ? "you-deep" : "muted"}
        className="shrink-0"
      >
        {verdict.outcome}
      </Mono>
    </SurfaceCard>
  );
}
