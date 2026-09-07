"use client";

import { useLayoutEffect, useRef } from "react";
import { useTranslations } from "next-intl";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";
import {
  DEFAULT_PERSONA_PROMPT,
  PERSONA_PROMPT_MAX_CHARS,
} from "@/lib/agent-config/constants";

/**
 * PERSONA — the linden band. The linden family means writing, and a persona is
 * writing.
 *
 * `maxLength` IS LOAD-BEARING. The server REJECTS an over-long persona rather
 * than truncating it (see normalizePersonaPrompt, whose own comment calls
 * truncation "the one silent alteration this feature could make to a
 * user-supplied value"), so the field has to stop the user at the same limit
 * instead of letting them paste text that can only fail to save. The limit is
 * read from the constant, never written here.
 *
 * The counter under the field appears only near the ceiling: a band with no
 * field chrome has nowhere else to make a hard cap visible, and showing
 * "12 / 2000" from the first keystroke would turn a paragraph into a form.
 *
 * The editor auto-grows between 64 and 180px and scrolls inside itself past
 * that, so a long persona can never push WHERE HE WORKS off the column.
 */
const MIN_HEIGHT = 64;
const MAX_HEIGHT = 180;
const COUNTER_THRESHOLD = 1800;

export interface PersonaBandProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

export function PersonaBand({ value, onChange, disabled }: PersonaBandProps) {
  const t = useTranslations("AgentsWorkshop");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // A DOM measurement, not state: nothing re-renders because of this.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(
      Math.max(node.scrollHeight, MIN_HEIGHT),
      MAX_HEIGHT,
    )}px`;
  }, [value]);

  return (
    <StrataBand stratum="feed" density="full" gap={8} className="pb-4">
      <BandHeader
        stratum="feed"
        labelSize={12}
        label={t("persona.label")}
        meta={t("persona.meta")}
      />
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={DEFAULT_PERSONA_PROMPT}
        // The server rejects anything longer rather than truncating, so
        // the field has to stop the user at the same limit instead of
        // letting them paste text that can only fail to save.
        maxLength={PERSONA_PROMPT_MAX_CHARS}
        aria-label={t("persona.aria")}
        disabled={disabled}
        style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
        // `outline-none` is only safe next to a replacement: without the ring
        // this borderless field would be the one control on the page a
        // keyboard user cannot locate.
        className="resize-none overflow-y-auto rounded-[10px] border-0 bg-card px-[14px] py-3 font-sans text-[13.5px] leading-[1.55] text-foreground shadow-none outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring placeholder:text-muted-foreground disabled:opacity-60"
      />
      {value.length > COUNTER_THRESHOLD ? (
        <Mono size={10} tone="muted">
          {t("persona.counter", {
            count: value.length,
            max: PERSONA_PROMPT_MAX_CHARS,
          })}
        </Mono>
      ) : null}
    </StrataBand>
  );
}
