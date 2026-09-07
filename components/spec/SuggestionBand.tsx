"use client";

import { useTranslations } from "next-intl";

import { BandHeader, StrataBand } from "@/components/piscine";
import { SpecUpdateProgress } from "@/components/spec/SpecUpdateProgress";

interface SuggestionBandProps {
  projectId: string;
  sessionId: string | null;
  status: "running" | "done" | "failed" | null;
  stream: string | null;
  response: string | null;
  error: string | null;
  onDismiss: () => void;
  className?: string;
}

/**
 * SUGGESTION D'AGENT — the pool-blue rail band of frame 8b.
 *
 * WHAT THE FRAME DRAWS vs WHAT EXISTS. The frame shows a stored agent
 * proposal ("La review de ARJ-113 propose d'ajouter à la spec : …") with
 * `Appliquer` and `Voir le diff` buttons. There is NO store of proposed spec
 * edits in this codebase, no apply mutation and no diff view — building one
 * would mean a new table, which this packet may not add.
 *
 * SUBSTITUTION, deliberate and recorded here so it is auditable: the band
 * hosts the one real agent-proposal signal that does exist — the in-flight or
 * just-finished spec-update session — and the frame's two buttons are replaced
 * by the affordances `SpecUpdateProgress` already owns: its `view session`
 * link and its dismiss ✕. No disabled `Appliquer` is rendered: a disabled
 * control tells the user the feature exists.
 *
 * With no session, the band COLLAPSES TO ITS LABEL LINE (house rule 5). It
 * renders no placeholder sentence and never the frame's sample proposal.
 *
 * When a real proposal store eventually lands, its text is Instrument Sans
 * 12.5px/1.5 in `--foreground` — INK, not the stratum deep. Colour is the
 * stratum, never the content.
 */
export function SuggestionBand({
  projectId,
  sessionId,
  status,
  stream,
  response,
  error,
  onDismiss,
  className,
}: SuggestionBandProps) {
  const t = useTranslations("Spec");

  return (
    // `rail` gives the 16px horizontal padding; the frame's 14px vertical is
    // 1px off the preset, so it is overridden here rather than in the primitive.
    <StrataBand
      stratum="next"
      density="rail"
      gap={8}
      className={`py-[14px] ${className ?? ""}`}
    >
      <BandHeader
        stratum="next"
        label={t("suggestion.label")}
        labelSize={12}
        standalone
      />
      {sessionId && status ? (
        <SpecUpdateProgress
          projectId={projectId}
          sessionId={sessionId}
          status={status}
          stream={stream}
          response={response}
          error={error}
          onDismiss={onDismiss}
        />
      ) : null}
    </StrataBand>
  );
}
