"use client";

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
  return (
    <SettingsSection testId="pipeline-settings" heading="Autonomous Pipeline">
      <StrataBand stratum="land">
        <BandHeader
          stratum="land"
          label="Pipeline"
          meta={
            <span className="font-sans text-[11.5px] leading-normal">
              chaîne une review sur chaque build — un run vert laisse le ticket
              en Review, il n&apos;approuve jamais
            </span>
          }
        />

        <SettingRow
          toggle={
            <SettingToggle
              on={draft.flag(PIPELINE_ENABLED_SETTING_KEY)}
              onChange={(next) => draft.set(PIPELINE_ENABLED_SETTING_KEY, next)}
              label="Run the pipeline by default"
              testId="pipeline-enabled-toggle"
            />
          }
          off={!draft.flag(PIPELINE_ENABLED_SETTING_KEY)}
          label="Run the pipeline by default"
          suffix="· chaque dispatch peut encore le forcer"
          suffixTone="land-mid"
        />
        <SettingRow
          toggle={
            <SettingToggle
              on={draft.flag(PIPELINE_GRADER_ENABLED_SETTING_KEY)}
              onChange={(next) =>
                draft.set(PIPELINE_GRADER_ENABLED_SETTING_KEY, next)
              }
              label="Grade acceptance criteria"
              testId="pipeline-grader-toggle"
            />
          }
          off={!draft.flag(PIPELINE_GRADER_ENABLED_SETTING_KEY)}
          label="Grade acceptance criteria"
          suffix="· entre verify et review"
          suffixTone="land-mid"
        />

        <div className="flex flex-wrap items-end gap-[20px]">
          <SettingField
            kicker="Attempts per stage"
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
            kicker="Review → fix cycles"
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
          {`combien de fois un build, un fix ou une review en échec est relancé avant l'abandon (${PIPELINE_MAX_ATTEMPTS_RANGE.min}–${PIPELINE_MAX_ATTEMPTS_RANGE.max})`}
        </Mono>
        <Mono size={10.5} tone="land-mid" as="div">
          {`combien de fois des findings bloquants renvoient le ticket à un agent de fix (${PIPELINE_MAX_FIX_CYCLES_RANGE.min}–${PIPELINE_MAX_FIX_CYCLES_RANGE.max} ; 0 rapporte les findings sans les corriger)`}
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
