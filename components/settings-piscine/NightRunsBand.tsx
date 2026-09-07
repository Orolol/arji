"use client";

import { useTranslations } from "next-intl";

import { BandHeader, CheckMark, Mono, StrataBand } from "@/components/piscine";
import {
  DEFAULT_NIGHT_CIRCUIT_BREAKER,
  NIGHT_CIRCUIT_BREAKER_RANGE,
  NIGHT_CIRCUIT_BREAKER_SETTING_KEY,
  NIGHT_COST_CAP_SETTING_KEY,
} from "@/lib/night/constants";
import { DREAMING_AFTER_NIGHT_RUN_SETTING_KEY } from "@/lib/workflow/dreaming-constants";

import { SettingField, SettingInput } from "./SettingField";
import { SettingRow } from "./SettingRow";
import { SettingToggle } from "./SettingToggle";
import { SettingsSection } from "./SettingsSection";
import type { SettingsDraft } from "./useSettingsDraft";

/**
 * NIGHT RUNS — the pool-blue stratum. Defaults for unattended overnight runs.
 *
 * NO MASTER TOGGLE, and the omission is the point: there is no global
 * night-run enable key. Each project's `routines` row carries its own
 * `enabled` boolean and its own `timeOfDay`, and the wave count is derived
 * from the dependency DAG at run time — so the frame's FENÊTRE 23:00 → 07:00
 * field, its WAVES PAR NUIT segmented control and its band-header switch all
 * describe state that lives per project, not here. The footnote says so
 * instead of a control pretending otherwise.
 *
 * The kept frame control is BUDGET / NUIT — `night_cost_cap_usd` is real, it
 * is global, and unlike the monthly cap it actually stops the next wave.
 */
export interface NightRunsBandProps {
  draft: SettingsDraft;
}

export function NightRunsBand({ draft }: NightRunsBandProps) {
  const t = useTranslations("Settings");

  return (
    <SettingsSection id="night-runs" testId="night-settings">
      <StrataBand stratum="next">
        <BandHeader
          stratum="next"
          label={t("nightRuns.label")}
          meta={
            <span className="font-sans text-[11.5px] leading-normal">
              {t("nightRuns.meta")}
            </span>
          }
        />

        <div className="flex flex-wrap items-end gap-[20px]">
          <SettingField
            kicker={t("nightRuns.budget")}
            stratum="next"
            htmlFor="night-cost-cap"
            width={170}
          >
            <SettingInput
              id="night-cost-cap"
              data-testid="night-cost-cap-setting"
              chrome="ground"
              type="number"
              min={0}
              step="0.5"
              // Empty is unlimited — a cost cap of zero would stop every wave.
              placeholder={t("nightRuns.budgetPlaceholder")}
              value={draft.text(NIGHT_COST_CAP_SETTING_KEY)}
              onChange={(event) =>
                draft.set(NIGHT_COST_CAP_SETTING_KEY, event.target.value)
              }
            />
          </SettingField>

          <SettingField
            kicker={t("nightRuns.circuitBreaker")}
            stratum="next"
            htmlFor="night-circuit-breaker"
            width={190}
          >
            <SettingInput
              id="night-circuit-breaker"
              data-testid="night-circuit-breaker-setting"
              chrome="ground"
              type="number"
              min={NIGHT_CIRCUIT_BREAKER_RANGE.min}
              max={NIGHT_CIRCUIT_BREAKER_RANGE.max}
              // Empty keeps the engine default; the number is the placeholder.
              placeholder={String(DEFAULT_NIGHT_CIRCUIT_BREAKER)}
              value={draft.text(NIGHT_CIRCUIT_BREAKER_SETTING_KEY)}
              onChange={(event) =>
                draft.set(NIGHT_CIRCUIT_BREAKER_SETTING_KEY, event.target.value)
              }
            />
          </SettingField>

          <SettingRow
            className="pb-[7px]"
            toggle={
              <SettingToggle
                on={draft.flag(DREAMING_AFTER_NIGHT_RUN_SETTING_KEY)}
                onChange={(next) =>
                  draft.set(DREAMING_AFTER_NIGHT_RUN_SETTING_KEY, next)
                }
                label={t("nightRuns.dream")}
                testId="dream-after-night-run"
              />
            }
            off={!draft.flag(DREAMING_AFTER_NIGHT_RUN_SETTING_KEY)}
            label={t("nightRuns.dream")}
          />
        </div>

        <Mono size={10.5} tone="next-mid" as="div">
          {t("nightRuns.perProject")}
        </Mono>
        <SettingRow
          toggle={<CheckMark checked shape="disc" tone="live" />}
          label={t("nightRuns.skipDependents")}
          suffix={t("nightRuns.skipDependentsSuffix")}
          suffixTone="next-mid"
        />
        <Mono size={10.5} tone="next-mid" as="div">
          {t("nightRuns.defaults")}
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
