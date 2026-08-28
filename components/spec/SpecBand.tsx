"use client";

import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import {
  BandHeader,
  Mono,
  PillButton,
  SegmentedControl,
  StrataBand,
  SurfaceCard,
} from "@/components/piscine";
import { SpecEditor } from "@/components/spec/SpecEditor";
import { SpecPreview } from "@/components/spec/SpecPreview";
import {
  EM_DASH,
  countWords,
  formatCount,
  formatSaveState,
} from "@/components/spec/spec-format";

interface SpecBandProps {
  projectId: string;
  spec: string;
  onSpecChange: (value: string) => void;
  tab: "edit" | "preview";
  onTabChange: (tab: "edit" | "preview") => void;
  /** False until the first `GET /api/projects/[id]` resolves. */
  loaded: boolean;
  savedSpec: string;
  savedAt: string | null;
  saving: boolean;
  /** An agent is rewriting the spec: the editor and the save pill are frozen. */
  updateRunning: boolean;
  onSave: () => void | Promise<void>;
  /** The "Régénérer par chat" pill, wrapped in its HeaderActionSlot. */
  headerAction?: ReactNode;
  className?: string;
}

/** The mono footer must not go stale while the page sits open. */
const RELATIVE_TIME_TICK_MS = 10_000;

/**
 * SPEC — the big linden band of frame 8b, 7/10 of the width.
 *
 * The project specification: one white editor card on the linden ground, with
 * the shared Écrire / Prévisualiser segmented control in the band header.
 *
 * FRAME AMBIGUITY, RESOLVED: the frame highlights `Écrire` while showing
 * rendered markdown with literal `#`/`##` characters. That is a mock artefact.
 * `Écrire` is the plain-text mention textarea; `Prévisualiser` is SpecPreview.
 * There is no hybrid.
 *
 * SAVE AFFORDANCE, and why the frame has none: the frame's footer stops at the
 * mono line, which implies autosave. Autosave is exactly wrong here — a
 * background PATCH while an agent may be rewriting the spec is the race the
 * 409 / pending-writer machinery exists to prevent — so an `Enregistrer` pill
 * closes the footer row instead, plus ⌘S / Ctrl+S.
 */
export function SpecBand({
  projectId,
  spec,
  onSpecChange,
  tab,
  onTabChange,
  loaded,
  savedSpec,
  savedAt,
  saving,
  updateRunning,
  onSave,
  headerAction,
  className,
}: SpecBandProps) {
  const dirty = spec !== savedSpec;

  // Re-render the relative save time on a slow tick rather than binding it to
  // keystrokes: "il y a 12 s" must age even when nothing else changes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const words = loaded ? formatCount(countWords(spec)) : EM_DASH;
  const saveState = formatSaveState({ dirty, savedAt }, now);

  function handleCardKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!saving && !updateRunning) void onSave();
    }
  }

  return (
    <StrataBand
      stratum="feed"
      gap={11}
      className={`px-[20px] py-[16px] ${className ?? ""}`}
    >
      {/* The band label reads SPEC; the document still needs a real heading. */}
      <h3 className="sr-only">Specification</h3>

      <div className="flex flex-none items-center gap-[12px]">
        <BandHeader stratum="feed" label="Spec" labelSize={12} align="center" />
        {/*
          The helper is a sibling rather than BandHeader's `meta` slot: `meta`
          renders Space Mono, and the frame draws this line in Instrument Sans
          11.5 on the linden deep.
        */}
        <span className="min-w-0 truncate text-[11.5px] text-strata-feed-deep">
          injectée dans chaque prompt d&apos;agent
        </span>
        {/*
          Two --action fills share this row when the header portal is absent:
          the active segment and the "Régénérer par chat" pill. Documented and
          accepted — the segment is a MODE INDICATOR, not a button, and the
          "one filled button per row" rule counts buttons. Do not demote the
          segment to an outline to "fix" it.
        */}
        <div className="ml-auto flex flex-none items-center gap-[8px]">
          <SegmentedControl
            size="sm"
            chrome="filled"
            value={tab}
            onChange={onTabChange}
            options={[
              { value: "edit", label: "Écrire" },
              { value: "preview", label: "Prévisualiser" },
            ]}
            // Inactive labels take the host stratum's deep tone on a coloured
            // ground, not --muted-foreground.
            className="[--segment-inactive:var(--strata-feed-deep)]"
          />
          {headerAction}
        </div>
      </div>

      <div
        data-testid="spec-card"
        onKeyDown={handleCardKeyDown}
        className="flex min-h-0 flex-1 flex-col"
      >
        <SurfaceCard
          radius={12}
          className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-hidden px-[24px] py-[20px] text-[13.5px] leading-[1.6] text-foreground"
        >
          {tab === "edit" ? (
            <SpecEditor
              projectId={projectId}
              value={spec}
              onChange={onSpecChange}
              disabled={updateRunning}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SpecPreview markdown={spec} />
            </div>
          )}

          <div className="mt-auto flex flex-none items-center gap-[10px]">
            <Mono size={10.5} tone="muted">
              {`markdown · ${words} mots · ${saveState}`}
            </Mono>
            <PillButton
              variant="filled"
              size="sm"
              className="ml-auto"
              onClick={() => void onSave()}
              disabled={saving || updateRunning}
              pending={saving}
              pendingLabel="Enregistrement…"
            >
              Enregistrer
            </PillButton>
          </div>
        </SurfaceCard>
      </div>
    </StrataBand>
  );
}
