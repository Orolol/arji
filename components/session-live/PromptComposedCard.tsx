"use client";

import { useTranslations } from "next-intl";
import { Check } from "lucide-react";

import {
  BandHeader,
  Mono,
  PillButton,
  QuietLink,
  StrataBand,
  SurfaceCard,
} from "@/components/piscine";
import { acceptsPersonaPrompt } from "@/lib/agent-config/constants";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import {
  isPromptElisionMarker,
  promptElisionMarkerSplitter,
} from "@/lib/agent-sessions/prompt-cap";

import type { SessionDetail } from "./types";

/**
 * COMPOSED PROMPT — what went INTO this run, and the door to the exact text.
 *
 * The chips are read from `estimated_prompt_breakdown`, the section token
 * counts written at dispatch time. They are token counts, not item counts, so
 * a chip says WHICH section was included and never how many of anything:
 * `epic + stories`, not `epic + 5 stories`; `cited docs`, not `2 cited docs`.
 * The frame draws the counted forms; the data cannot support them and a
 * fabricated numeral on an audit surface is worse than a missing one.
 *
 * THE PROMPT ITSELF IS LAZY. It reaches 1.8 MB per row on the live database
 * and the detail route omits the column entirely unless `?include=prompt` is
 * passed. `onOpenPrompt` fires exactly once, on the first open of the pane —
 * never on mount, never on the 3-second poll.
 *
 * A prompt over the write-path cap is stored head + marker + tail, and this
 * pane is where that marker has to READ — it is the one surface whose whole
 * job is showing what went in, so it must say plainly which part of it Arij
 * did not keep.
 */

export interface PromptComposedCardProps {
  session: SessionDetail;
  open: boolean;
  onToggle: () => void;
  prompt: string | null;
  promptState: "idle" | "loading" | "loaded" | "error";
  onRetry: () => void;
}

/**
 * Split the stored prompt around Arij's elision marker and give the marker
 * its own element, so it reads as a notice rather than as one more dim line
 * of the prompt it interrupts. Colour is the band's own stratum — `next` —
 * not a state.
 *
 * Split, not a line-by-line map: a stored prompt runs to 128 KiB, and one
 * element per line would be thousands of nodes where the flat block needs
 * one. `Mono` does not forward arbitrary props, so the test id rides a
 * wrapping span rather than the marker's own styling.
 */
function withPromptElisionMarker(prompt: string): React.ReactNode[] {
  return prompt.split(promptElisionMarkerSplitter()).map((part, index) =>
    isPromptElisionMarker(part) ? (
      <span
        key={`elision-${index}`}
        data-testid="prompt-elision-marker"
        className="text-strata-next-deep"
      >
        {part}
      </span>
    ) : (
      part
    )
  );
}

/** One included-section chip: a check glyph and a word on a white plate. */
function CheckChip({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-[5px] rounded-full bg-card px-[9px] py-[4px] font-sans text-[11.5px] font-semibold text-foreground">
      <Check
        width={11}
        height={11}
        className="text-strata-live-deep"
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

/**
 * The chip name per breakdown section, in the frame's order — a MODULE-SCOPE
 * COPY TABLE holding catalogue KEY REFERENCES (`lib/i18n/catalogue.ts`,
 * pattern 3). `system` and `other` get no chip: they are always present and
 * say nothing.
 */
const CHIP_KEYS: ReadonlyArray<{ field: string; labelKey: TranslationKey }> = [
  { field: "spec", labelKey: "SessionLive.prompt.chips.spec" },
  { field: "ticket", labelKey: "SessionLive.prompt.chips.ticket" },
  { field: "memory", labelKey: "SessionLive.prompt.chips.memory" },
  { field: "documents", labelKey: "SessionLive.prompt.chips.documents" },
  { field: "findings", labelKey: "SessionLive.prompt.chips.findings" },
  { field: "comments", labelKey: "SessionLive.prompt.chips.comments" },
];

/** The persona chip, which no breakdown key can produce (see below). */
const PERSONA_CHIP: { labelKey: TranslationKey } = {
  labelKey: "SessionLive.prompt.chips.persona",
};

/** Which sections the composed prompt carried, in the frame's order. */
function chipLabelKeys(session: SessionDetail): TranslationKey[] {
  const keys: TranslationKey[] = [];

  // The persona has NO breakdown key: it is prepended at spawn time, after
  // the estimate was computed. Derived from the session row instead — never
  // by loading the prompt to sniff for its heading.
  if (
    session.namedAgentName != null &&
    acceptsPersonaPrompt(session.agentType)
  ) {
    keys.push(PERSONA_CHIP.labelKey);
  }

  let breakdown: Record<string, unknown> | null = null;
  if (session.estimatedPromptBreakdown) {
    try {
      breakdown = JSON.parse(session.estimatedPromptBreakdown);
    } catch {
      breakdown = null;
    }
  }

  if (breakdown) {
    for (const { field, labelKey } of CHIP_KEYS) {
      if (Number(breakdown[field] ?? 0) > 0) keys.push(labelKey);
    }
  }

  return keys;
}

export function PromptComposedCard({
  session,
  open,
  onToggle,
  prompt,
  promptState,
  onRetry,
}: PromptComposedCardProps) {
  const t = useTranslations("SessionLive");
  // Namespace-less, for the chip table's KEY REFERENCES.
  const tKey = useTranslations();
  const chips = chipLabelKeys(session);

  return (
    <StrataBand stratum="next" density="rail" gap={8}>
      <BandHeader
        label={t("prompt.label")}
        stratum="next"
        labelSize={12}
        standalone
      />

      {/* No breakdown and no persona: the band collapses to its label line —
          but the link stays, because it does not depend on the estimate. */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-[6px]">
          {chips.map((labelKey) => (
            <CheckChip key={labelKey} label={tKey(labelKey)} />
          ))}
        </div>
      )}

      <QuietLink onClick={onToggle} tone="next" size={11.5} className="self-start">
        {t("prompt.seeExact")}
      </QuietLink>

      {/* Revealed in place, inside the same band — no dialog, no overlay, no
          shadow. */}
      {open && (
        <SurfaceCard
          radius={10}
          className="max-h-[320px] overflow-y-auto p-[12px]"
        >
          {prompt ? (
            <Mono
              as="div"
              size={11}
              tone="muted"
              className="whitespace-pre-wrap break-words"
            >
              {withPromptElisionMarker(prompt)}
            </Mono>
          ) : promptState === "loading" ? (
            <Mono size={11} tone="muted">
              {t("prompt.loading")}
            </Mono>
          ) : promptState === "error" ? (
            <div className="flex flex-col items-start gap-[8px]">
              <Mono size={11} tone="danger">
                {t("prompt.loadFailed")}
              </Mono>
              <PillButton
                variant="outline"
                outlineTone="neutral"
                size="sm"
                onClick={onRetry}
              >
                {t("prompt.retry")}
              </PillButton>
            </div>
          ) : (
            <Mono size={11} tone="muted">
              {t("prompt.empty")}
            </Mono>
          )}
        </SurfaceCard>
      )}
    </StrataBand>
  );
}
