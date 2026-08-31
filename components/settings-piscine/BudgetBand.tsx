"use client";

import { BandHeader, Mono, QuietLink, RatioBar, StrataBand } from "@/components/piscine";
import { PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY } from "@/lib/tokens/budget-settings";
import {
  CLAUDE_WEEKLY_BUDGET_SETTING_KEY,
  MONTHLY_CAP_SETTING_KEY,
  type UsageMonthlyCap,
} from "@/lib/types/usage";
import { formatCostUsd } from "@/lib/utils/format-usage";

import { SettingField, SettingInput } from "./SettingField";
import { SettingsSection } from "./SettingsSection";
import type { SettingsDraft } from "./useSettingsDraft";

/**
 * BUDGET — the sun half of frame 11c's split row.
 *
 * THREE FIELDS, NOT ONE. The frame draws only PLAFOND MENSUEL; the weekly
 * Claude budget and the prompt-token threshold have no slot in it and would be
 * lost. They are the same kind of object — an advisory ceiling — so they join
 * this band rather than vanish.
 *
 * THE SPEND BAR IS LAZY AND OPTIONAL. Its figures live only in
 * `GET /api/usage`, which re-scans codex rollouts on every read, so it is
 * fetched after mount and never blocks first paint. With no cap or no reported
 * spend there is no bar and no "dépensés" line — a bar without a denominator
 * is an invented number.
 *
 * THE FRAME'S FOOTNOTE IS FALSE AND IS NOT REPRODUCED. Nothing in
 * `lib/auto-mode/*` reads a spend cap (see components/usage/MonthlyCapTile.tsx),
 * so "au plafond, Full Auto et les night runs se mettent en pause" would be a
 * promise the engine does not keep. The per-night cap, which does stop the
 * next wave, is named instead.
 */
export interface BudgetBandProps {
  draft: SettingsDraft;
  /** null until `GET /api/usage` lands, or forever if it fails. */
  cap: UsageMonthlyCap | null;
}

export function BudgetBand({ draft, cap }: BudgetBandProps) {
  const spent = cap?.spentUsd ?? null;
  const capUsd = cap?.capUsd ?? null;
  const showBar = cap !== null && spent !== null && capUsd !== null;

  return (
    <SettingsSection testId="usage-settings" className="min-w-0">
      <StrataBand stratum="land" gap={9} grow>
        <BandHeader
          stratum="land"
          label="Budget"
          right={
            <QuietLink href="/usage" tone="next" size={12}>
              open usage →
            </QuietLink>
          }
        />

        <div className="flex flex-wrap items-end gap-[16px]">
          <SettingField
            kicker="PLAFOND MENSUEL"
            stratum="land"
            htmlFor="monthly-cap"
            width={150}
          >
            <SettingInput
              id="monthly-cap"
              data-testid="monthly-cap-setting"
              chrome="paper"
              type="number"
              min={0}
              step="1"
              placeholder="Aucun plafond"
              value={draft.text(MONTHLY_CAP_SETTING_KEY)}
              onChange={(event) =>
                draft.set(MONTHLY_CAP_SETTING_KEY, event.target.value)
              }
            />
          </SettingField>

          <SettingField
            kicker="PLAFOND HEBDO · CLAUDE"
            stratum="land"
            htmlFor="usage-budget"
            width={170}
          >
            <SettingInput
              id="usage-budget"
              data-testid="usage-budget-setting"
              chrome="paper"
              type="number"
              min={0}
              step="1"
              placeholder="No budget"
              value={draft.text(CLAUDE_WEEKLY_BUDGET_SETTING_KEY)}
              onChange={(event) =>
                draft.set(CLAUDE_WEEKLY_BUDGET_SETTING_KEY, event.target.value)
              }
            />
          </SettingField>

          <SettingField
            kicker="BUDGET TOKENS / PROMPT"
            stratum="land"
            htmlFor="prompt-token-budget"
            width={190}
            testId="prompt-budget-settings"
          >
            <SettingInput
              id="prompt-token-budget"
              data-testid="prompt-token-budget-setting"
              chrome="paper"
              type="text"
              placeholder="e.g. 50000 or 50k (no threshold by default)"
              value={draft.text(PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY)}
              onChange={(event) =>
                draft.set(PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY, event.target.value)
              }
            />
          </SettingField>

          {showBar ? (
            <div className="flex min-w-[180px] flex-1 flex-col gap-[6px] pb-[3px]">
              <Mono size={11} tone="land-mid">
                {`${formatCostUsd(spent) ?? "—"} dépensés · alerte à ${cap.alertPercent} %`}
              </Mono>
              <RatioBar
                height={8}
                track="card"
                width="flex"
                segments={[
                  {
                    percent: Math.min(100, cap.usedPercent ?? 0),
                    color: "var(--strata-land-deep)",
                  },
                ]}
              />
            </div>
          ) : null}
        </div>

        <span className="font-sans text-[11.5px] leading-snug text-strata-land-mid">
          Le plafond est indicatif : rien ne met Full Auto ni les night runs en
          pause automatiquement. Le cap par night run, lui, arrête bien les
          vagues suivantes.
        </span>
      </StrataBand>
    </SettingsSection>
  );
}
