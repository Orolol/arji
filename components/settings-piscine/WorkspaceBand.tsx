"use client";

import { useTranslations } from "next-intl";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";
import { PROJECTS_ROOT_SETTING_KEY } from "@/lib/projects/workspace-constants";

import { SettingField, SettingInput } from "./SettingField";
import { SettingsSection } from "./SettingsSection";
import type { SettingsDraft } from "./useSettingsDraft";

/**
 * WORKSPACE — the white card that opens frame 11c.
 *
 * The frame draws three controls here; two of them describe behaviour Arij
 * does not have, so they do not ship:
 * - CLONE STRATEGY is decided per project at import time (`projects.cloneSource`
 *   is "github" when Arij cloned the directory and NULL for a supplied path).
 *   There is no global default and no settings key.
 * - MAX WORKTREES / PROJET has no reader anywhere in the codebase.
 * A toggle that writes a key nothing reads is worse than no toggle, so the
 * band keeps PROJECTS ROOT and answers both questions in its helper line.
 */
export interface WorkspaceBandProps {
  draft: SettingsDraft;
}

export function WorkspaceBand({ draft }: WorkspaceBandProps) {
  const t = useTranslations("Settings");
  const fallbackRoot = draft.defaults[PROJECTS_ROOT_SETTING_KEY];

  return (
    <SettingsSection testId="workspace-settings">
      <StrataBand stratum="card">
        <BandHeader stratum="card" label={t("workspace.label")} standalone />
        <div className="flex flex-wrap items-end gap-[20px]">
          <SettingField
            kicker={t("workspace.projectsRoot")}
            stratum="card"
            htmlFor="projects-root"
            flex={1.4}
          >
            <SettingInput
              id="projects-root"
              data-testid="projects-root-setting"
              chrome="paper"
              value={draft.text(PROJECTS_ROOT_SETTING_KEY)}
              // The server-resolved default, never a hard-coded path: the
              // browser cannot compute process.cwd().
              placeholder={typeof fallbackRoot === "string" ? fallbackRoot : ""}
              onChange={(event) =>
                draft.set(PROJECTS_ROOT_SETTING_KEY, event.target.value)
              }
            />
          </SettingField>
        </div>
        <Mono size={10.5} tone="muted" as="div">
          {t("workspace.note")}
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
