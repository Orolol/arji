"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { BandHeader, PillButton, QuietLink, StrataBand } from "@/components/piscine";

/**
 * "Vers la spec" — the bridge from a chat decision into the project spec
 * (frame 11a, right rail).
 *
 * COPY DEVIATION, RECORDED — the only one in this packet. The frame's sentence
 * is `Cette décision (snapshot + garde-fou) mérite d'entrer dans la spec.` The
 * parenthetical is GENERATED SAMPLE CONTENT: nothing in the data model
 * summarises what a conversation decided, and inventing a summary here would
 * be fabricating data. The parenthetical is dropped rather than faked.
 *
 * The button dispatches the EXISTING spec-update session
 * (`POST /api/projects/:id/spec/update`); it does not persist a "proposal".
 * `components/spec/SuggestionBand.tsx` already records that no proposal store
 * exists, and `/projects/:id/spec` is where the running session shows up —
 * which is why success offers a link there rather than a second surface.
 *
 * With no assistant message yet the band collapses to its label line:
 * `StrataBand` has no min-height and no padding floor, so it folds on its own.
 */
export interface TowardSpecBandProps {
  /** False until the conversation has an assistant message to propose. */
  available: boolean;
  pending: boolean;
  onPropose: () => void;
  /** Shown after a successful dispatch. */
  specHref?: string | null;
}

export function TowardSpecBand({
  available,
  pending,
  onPropose,
  specHref,
}: TowardSpecBandProps) {
  return (
    <StrataBand
      stratum="feed"
      gap={7}
      className="rounded-[14px] px-[15px] py-[13px]"
    >
      <BandHeader stratum="feed" label="Vers la spec" labelSize={12} standalone />

      {available ? (
        <>
          <span className="text-[12px] leading-[1.55] text-strata-feed-deep">
            Cette décision mérite d&apos;entrer dans la spec.
          </span>
          <PillButton
            variant="filled"
            size="sm"
            icon={Plus}
            className="h-[28px] self-start px-3"
            pending={pending}
            pendingLabel="Envoi…"
            onClick={onPropose}
          >
            Proposer l&apos;ajout
          </PillButton>
          {specHref ? (
            /* `QuietLinkTone` has no `feed` member (next | live | land |
               muted) and the primitive set is frozen, so the linden band's
               link is the quiet muted variant rather than a fifth tone. */
            <QuietLink href={specHref} tone="muted" size={11.5}>
              voir la spec →
            </QuietLink>
          ) : null}
        </>
      ) : null}
    </StrataBand>
  );
}
