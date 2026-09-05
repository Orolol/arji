"use client";

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
import {
  isPromptElisionMarker,
  promptElisionMarkerSplitter,
} from "@/lib/agent-sessions/prompt-cap";

import type { SessionDetail } from "./types";

/**
 * PROMPT COMPOSÉ — what went INTO this run, and the door to the exact text.
 *
 * The chips are read from `estimated_prompt_breakdown`, the section token
 * counts written at dispatch time. They are token counts, not item counts, so
 * a chip says WHICH section was included and never how many of anything:
 * `epic + stories`, not `epic + 5 stories`; `docs cités`, not `2 docs cités`.
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
 * Which sections the composed prompt carried, in the frame's order.
 * `system` and `other` get no chip: they are always present and say nothing.
 */
function chipLabels(session: SessionDetail): string[] {
  const labels: string[] = [];

  // The persona has NO breakdown key: it is prepended at spawn time, after
  // the estimate was computed. Derived from the session row instead — never
  // by loading the prompt to sniff for its heading.
  if (
    session.namedAgentName != null &&
    acceptsPersonaPrompt(session.agentType)
  ) {
    labels.push("persona");
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
    const has = (key: string) => Number(breakdown?.[key] ?? 0) > 0;
    if (has("spec")) labels.push("spec projet");
    if (has("ticket")) labels.push("epic + stories");
    if (has("memory")) labels.push("mémoire");
    if (has("documents")) labels.push("docs cités");
    if (has("findings")) labels.push("findings");
    if (has("comments")) labels.push("commentaires");
  }

  return labels;
}

export function PromptComposedCard({
  session,
  open,
  onToggle,
  prompt,
  promptState,
  onRetry,
}: PromptComposedCardProps) {
  const chips = chipLabels(session);

  return (
    <StrataBand stratum="next" density="rail" gap={8}>
      <BandHeader
        label="Prompt composé"
        stratum="next"
        labelSize={12}
        standalone
      />

      {/* No breakdown and no persona: the band collapses to its label line —
          but the link stays, because it does not depend on the estimate. */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-[6px]">
          {chips.map((label) => (
            <CheckChip key={label} label={label} />
          ))}
        </div>
      )}

      <QuietLink onClick={onToggle} tone="next" size={11.5} className="self-start">
        voir le prompt exact →
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
              Loading prompt...
            </Mono>
          ) : promptState === "error" ? (
            <div className="flex flex-col items-start gap-[8px]">
              <Mono size={11} tone="danger">
                Could not load the prompt.
              </Mono>
              <PillButton
                variant="outline"
                outlineTone="neutral"
                size="sm"
                onClick={onRetry}
              >
                Retry
              </PillButton>
            </div>
          ) : (
            <Mono size={11} tone="muted">
              No prompt available
            </Mono>
          )}
        </SurfaceCard>
      )}
    </StrataBand>
  );
}
