"use client";

import { useTranslations } from "next-intl";

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
  const t = useTranslations("Settings");

  return (
    <SettingsSection
      testId="global-prompt-settings"
      heading={t("globalPrompt.heading")}
    >
      <StrataBand stratum="feed">
        <BandHeader
          stratum="feed"
          label={t("globalPrompt.label")}
          standalone
        />
        <SettingTextarea
          id="global-prompt"
          data-testid="global-prompt"
          aria-label={t("globalPrompt.ariaLabel")}
          chrome="ground"
          rows={10}
          placeholder={t("globalPrompt.placeholder")}
          value={draft.text(GLOBAL_PROMPT_SETTING_KEY)}
          onChange={(event) =>
            draft.set(GLOBAL_PROMPT_SETTING_KEY, event.target.value)
          }
        />
        <Mono size={10.5} tone="feed-deep" as="div">
          {t("globalPrompt.note")}
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
