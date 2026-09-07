"use client";

import { useTranslations } from "next-intl";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";
import {
  PIPELINE_ENABLED_SETTING_KEY,
  PIPELINE_GRADER_ENABLED_SETTING_KEY,
  PIPELINE_MAX_ATTEMPTS_RANGE,
  PIPELINE_MAX_ATTEMPTS_SETTING_KEY,
  PIPELINE_MAX_FIX_CYCLES_RANGE,
  PIPELINE_MAX_FIX_CYCLES_SETTING_KEY,
} from "@/lib/pipeline/constants";

import { SettingField, SettingInput } from "./SettingField";
import { SettingRow } from "./SettingRow";
import { SettingToggle } from "./SettingToggle";
import { SettingsSection } from "./SettingsSection";
import type { SettingsDraft } from "./useSettingsDraft";

/**
 * PIPELINE — the sun stratum of the Pipeline tab: what a single-ticket build
 * chains onto itself, and how hard it tries.
 *
 * The frame draws no home for these; the tab exists so nine live settings the
 * agents actually read at dispatch time do not disappear in the rebuild.
 */
export interface PipelineBandProps {
  draft: SettingsDraft;
}

export function PipelineBand({ draft }: PipelineBandProps) {
  const t = useTranslations("Settings");

  return (
    <SettingsSection testId="pipeline-settings" heading={t("pipeline.heading")}>
      <StrataBand stratum="land">
        <BandHeader
          stratum="land"
          label={t("pipeline.label")}
          meta={
            <span className="font-sans text-[11.5px] leading-normal">
              {t("pipeline.meta")}
            </span>
          }
        />

        <SettingRow
          toggle={
            <SettingToggle
              on={draft.flag(PIPELINE_ENABLED_SETTING_KEY)}
              onChange={(next) => draft.set(PIPELINE_ENABLED_SETTING_KEY, next)}
              label={t("pipeline.enabled")}
              testId="pipeline-enabled-toggle"
            />
          }
          off={!draft.flag(PIPELINE_ENABLED_SETTING_KEY)}
          label={t("pipeline.enabled")}
          suffix={t("pipeline.enabledSuffix")}
          suffixTone="land-mid"
        />
        <SettingRow
          toggle={
            <SettingToggle
              on={draft.flag(PIPELINE_GRADER_ENABLED_SETTING_KEY)}
              onChange={(next) =>
                draft.set(PIPELINE_GRADER_ENABLED_SETTING_KEY, next)
              }
              label={t("pipeline.grader")}
              testId="pipeline-grader-toggle"
            />
          }
          off={!draft.flag(PIPELINE_GRADER_ENABLED_SETTING_KEY)}
          label={t("pipeline.grader")}
          suffix={t("pipeline.graderSuffix")}
          suffixTone="land-mid"
        />

        <div className="flex flex-wrap items-end gap-[20px]">
          <SettingField
            kicker={t("pipeline.maxAttempts")}
            stratum="land"
            htmlFor="pipeline-max-attempts"
            width={170}
          >
            <SettingInput
              id="pipeline-max-attempts"
              data-testid="pipeline-max-attempts"
              chrome="paper"
              type="number"
              min={PIPELINE_MAX_ATTEMPTS_RANGE.min}
              max={PIPELINE_MAX_ATTEMPTS_RANGE.max}
              value={draft.text(PIPELINE_MAX_ATTEMPTS_SETTING_KEY)}
              onChange={(event) =>
                draft.set(PIPELINE_MAX_ATTEMPTS_SETTING_KEY, event.target.value)
              }
            />
          </SettingField>
          <SettingField
            kicker={t("pipeline.maxFixCycles")}
            stratum="land"
            htmlFor="pipeline-max-fix-cycles"
            width={170}
          >
            <SettingInput
              id="pipeline-max-fix-cycles"
              data-testid="pipeline-max-fix-cycles"
              chrome="paper"
              type="number"
              min={PIPELINE_MAX_FIX_CYCLES_RANGE.min}
              max={PIPELINE_MAX_FIX_CYCLES_RANGE.max}
              value={draft.text(PIPELINE_MAX_FIX_CYCLES_SETTING_KEY)}
              onChange={(event) =>
                draft.set(PIPELINE_MAX_FIX_CYCLES_SETTING_KEY, event.target.value)
              }
            />
          </SettingField>
        </div>

        <Mono size={10.5} tone="land-mid" as="div">
          {t("pipeline.maxAttemptsNote", {
            min: PIPELINE_MAX_ATTEMPTS_RANGE.min,
            max: PIPELINE_MAX_ATTEMPTS_RANGE.max,
          })}
        </Mono>
        <Mono size={10.5} tone="land-mid" as="div">
          {t("pipeline.maxFixCyclesNote", {
            min: PIPELINE_MAX_FIX_CYCLES_RANGE.min,
            max: PIPELINE_MAX_FIX_CYCLES_RANGE.max,
          })}
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
