"use client";

import { useTranslations } from "next-intl";

import { BandHeader, StrataBand } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaVerdict } from "@/lib/qa/types";

import { VerdictRow } from "./VerdictRow";

/**
 * VERDICTS RÉCENTS — the sun stratum, left half of the bottom split.
 *
 * `shrink-0`: it sizes to its rows, and the route caps them (the band has no
 * "show more" — a seventh row would push the split off the screen).
 *
 * "7 jours" is a literal, not a computed figure: it names the window the route
 * queries, and `QA_VERDICT_DAYS` is that window.
 */
export interface VerdictsBandProps {
  verdicts: readonly QaVerdict[];
  projectsById: ReadonlyMap<string, DeskProject>;
  onOpenTicket?: (epicId: string) => void;
  className?: string;
}

export function VerdictsBand({
  verdicts,
  projectsById,
  onOpenTicket,
  className,
}: VerdictsBandProps) {
  const t = useTranslations("Qa");

  return (
    <StrataBand stratum="land" density="full" gap={9} className={className}>
      <BandHeader
        label={t("verdicts.label")}
        stratum="land"
        labelSize={13}
        meta={t("verdicts.meta")}
      />
      {verdicts.map((verdict) => (
        <VerdictRow
          key={verdict.epicId}
          verdict={verdict}
          project={projectsById.get(verdict.projectId)}
          onOpenTicket={onOpenTicket}
        />
      ))}
    </StrataBand>
  );
}
