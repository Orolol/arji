"use client";

import { useCallback, useEffect, useState } from "react";

import { BandHeader, Mono, PROMPT_SEGMENT, StrataBand } from "@/components/piscine";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { PromptBarRow } from "@/components/spec/PromptBarRow";
import type { PromptAnatomyRow } from "@/components/spec/spec-format";
import type { PromptAnatomySegment } from "@/lib/tokens/estimator";

interface PromptAnatomyBandProps {
  projectId: string;
  /** Injected by the tests; production fetches on mount. */
  rows?: PromptAnatomyRow[];
  className?: string;
}

/**
 * The legend is a legend of the VOCABULARY, not of the current rows: PERSONA
 * stays listed even when no agent on screen has one.
 */
const LEGEND: { key: PromptAnatomySegment; label: string }[] = [
  { key: "system", label: "SYSTEM" },
  { key: "persona", label: "PERSONA" },
  { key: "spec", label: "SPEC" },
  { key: "memory", label: "MEMORY" },
  { key: "ticket", label: "TICKET / DIFF" },
  { key: "docs", label: "DOCS" },
];

/**
 * ANATOMIE DU PROMPT — the full-width sun band across the bottom of frame 8b.
 *
 * One stacked token bar per (named agent × role), showing what that agent
 * actually received at the start of its most recent session. It makes "the
 * spec and the memory are paid for in every session of every agent" visible
 * instead of asserted.
 *
 * Data comes from `GET /api/projects/[projectId]/prompt-anatomy`, fetched once
 * on mount and re-fetched on the SSE `session:completed` event — a completed
 * dispatch is exactly when a new breakdown lands. NEVER on a timer.
 */
export function PromptAnatomyBand({
  projectId,
  rows: rowsProp,
  className,
}: PromptAnatomyBandProps) {
  const [fetched, setFetched] = useState<PromptAnatomyRow[]>([]);
  const controlled = rowsProp !== undefined;
  const rows = controlled ? rowsProp : fetched;

  const load = useCallback(() => {
    if (!projectId || controlled) return;
    fetch(`/api/projects/${projectId}/prompt-anatomy`)
      .then(async (res) => (res.ok ? await res.json().catch(() => null) : null))
      .then((json) => {
        if (json?.data && Array.isArray(json.data.rows)) {
          setFetched(json.data.rows as PromptAnatomyRow[]);
        }
      })
      .catch(() => {});
  }, [projectId, controlled]);

  useEffect(() => {
    load();
  }, [load]);

  useProjectEvents(projectId, {
    "session:completed": () => load(),
  });

  const max = rows.reduce((biggest, row) => Math.max(biggest, row.total), 0);

  return (
    <StrataBand
      stratum="land"
      gap={10}
      className={`px-[18px] pt-[14px] pb-[15px] ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-baseline gap-[12px]">
        <BandHeader stratum="land" label="Anatomie du prompt" labelSize={12} />
        <span className="text-[11.5px] text-strata-land-mid max-[1199px]:hidden">
          ce que chaque agent reçoit au départ de session, en tokens
        </span>
        <div
          data-testid="prompt-anatomy-legend"
          className="ml-auto flex items-center gap-[14px] max-[1199px]:ml-0 max-[1199px]:w-full"
        >
          {LEGEND.map((item) => (
            <span key={item.key} className="flex items-center gap-[5px]">
              <span
                aria-hidden="true"
                className="h-[9px] w-[9px] rounded-[3px]"
                style={{ background: PROMPT_SEGMENT[item.key] }}
              />
              <Mono size={9.5} tone="land-mid">
                {item.label}
              </Mono>
            </span>
          ))}
        </div>
      </div>

      {rows.length > 0 ? (
        <>
          <div className="flex flex-col gap-[8px]">
            {rows.map((row) => (
              <PromptBarRow
                key={`${row.agentId ?? row.agentName}-${row.role}`}
                row={row}
                max={max}
              />
            ))}
          </div>
          {/*
            The frame writes «La spec (jaune) et la mémoire (vert) …», but the
            legend paints SPEC linden-green (--strata-feed-under #c8d283) and
            MEMORY turquoise (--strata-live-under #7ccbb8): neither is yellow,
            and calling the linden spec "jaune" while the turquoise memory is
            "vert" actively misdirects. Corrected wording below; nothing else
            in the sentence changes.
          */}
          <span className="text-[11.5px] text-strata-land-mid">
            La spec (vert tilleul) et la mémoire (turquoise) pèsent dans{" "}
            <em>chaque</em> session de <em>chaque</em> agent — élaguer ici paie
            partout. Le blanc en fin de barre : ce que l&apos;agent n&apos;a pas
            reçu (pas de docs cités).
          </span>
        </>
      ) : (
        // No session in this project has stored a prompt breakdown yet. The
        // band collapses to its label line plus one honest sentence — no fake
        // bars, no zero totals.
        <span
          data-testid="prompt-anatomy-empty"
          className="text-[11.5px] text-strata-land-mid"
        >
          Aucune session n&apos;a encore enregistré son prompt — la première
          dispatche remplira ce tableau.
        </span>
      )}
    </StrataBand>
  );
}
