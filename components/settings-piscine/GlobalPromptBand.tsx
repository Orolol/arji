"use client";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";

import { SettingTextarea } from "./SettingField";
import { SettingsSection } from "./SettingsSection";
import { GLOBAL_PROMPT_SETTING_KEY } from "./settings-fields";
import type { SettingsDraft } from "./useSettingsDraft";

/**
 * PROMPT GLOBAL — linden, because linden is the writing ground everywhere else
 * in this design (the composer, the spec, an agent's persona) and this is the
 * same kind of object: text a human writes that an agent reads.
 */
export interface GlobalPromptBandProps {
  draft: SettingsDraft;
}

export function GlobalPromptBand({ draft }: GlobalPromptBandProps) {
  return (
    <SettingsSection testId="global-prompt-settings" heading="Global prompt">
      <StrataBand stratum="feed">
        <BandHeader stratum="feed" label="Prompt global" standalone />
        <SettingTextarea
          id="global-prompt"
          data-testid="global-prompt"
          aria-label="Global Prompt"
          chrome="ground"
          rows={10}
          placeholder="Enter global instructions for Claude Code..."
          value={draft.text(GLOBAL_PROMPT_SETTING_KEY)}
          onChange={(event) =>
            draft.set(GLOBAL_PROMPT_SETTING_KEY, event.target.value)
          }
        />
        <Mono size={10.5} tone="feed-deep" as="div">
          injecté en tête de chaque session, tous projets confondus
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
