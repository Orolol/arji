"use client";

import { useTranslations } from "next-intl";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";
import {
  BUG_REGRESSION_CHECK_SETTING_KEY,
  BUG_REGRESSION_COMMAND_SETTING_KEY,
  DEFAULT_BUG_REGRESSION_COMMAND,
  DEFAULT_TEST_FILE_PATTERNS,
  REGRESSION_COMMAND_FILE_PLACEHOLDER,
  TEST_FILE_PATTERNS_SETTING_KEY,
} from "@/lib/verify/regression-constants";
import {
  VERIFY_COMMANDS_SETTING_KEY,
  VERIFY_TIMEOUT_MS_SETTING_KEY,
} from "@/lib/verify/verify-constants";

import { SettingField, SettingInput, SettingTextarea } from "./SettingField";
import { SettingRow } from "./SettingRow";
import { SettingToggle } from "./SettingToggle";
import { SettingsSection } from "./SettingsSection";
import type { SettingsDraft } from "./useSettingsDraft";

/**
 * VÉRIFICATION — the pool stratum of the Pipeline tab.
 *
 * The commands run sequentially in the epic worktree after a successful build;
 * an empty array keeps the stage off.
 *
 * THE REVEAL IS LOAD-BEARING. The regression command and the test-file globs
 * only exist while the gate is on — showing them under an off gate would
 * suggest they are consulted when they are not. Both are refused at save time
 * rather than falling back silently: a command without `{files}` would run the
 * whole suite on every check.
 */
export interface VerificationBandProps {
  draft: SettingsDraft;
}

export function VerificationBand({ draft }: VerificationBandProps) {
  const t = useTranslations("Settings");
  const gateOn = draft.flag(BUG_REGRESSION_CHECK_SETTING_KEY);

  return (
    <SettingsSection
      testId="verify-settings"
      heading={t("verification.heading")}
    >
      <StrataBand stratum="next">
        <BandHeader
          stratum="next"
          label={t("verification.label")}
          meta={
            <span className="font-sans text-[11.5px] leading-normal">
              {t("verification.meta")}
            </span>
          }
        />

        <SettingField
          kicker={t("verification.commands")}
          stratum="next"
          htmlFor="verify-commands"
        >
          <SettingTextarea
            id="verify-commands"
            data-testid="verify-commands"
            chrome="ground"
            rows={6}
            spellCheck={false}
            value={draft.text(VERIFY_COMMANDS_SETTING_KEY)}
            onChange={(event) =>
              draft.set(VERIFY_COMMANDS_SETTING_KEY, event.target.value)
            }
          />
        </SettingField>
        <Mono size={10.5} tone="next-mid" as="div">
          {t("verification.commandsExample")}
        </Mono>

        <SettingField
          kicker={t("verification.timeout")}
          stratum="next"
          htmlFor="verify-timeout-ms"
          width={190}
        >
          <SettingInput
            id="verify-timeout-ms"
            data-testid="verify-timeout-ms"
            chrome="ground"
            type="number"
            min={1}
            value={draft.text(VERIFY_TIMEOUT_MS_SETTING_KEY)}
            onChange={(event) =>
              draft.set(VERIFY_TIMEOUT_MS_SETTING_KEY, event.target.value)
            }
          />
        </SettingField>

        <SettingRow
          toggle={
            <SettingToggle
              on={gateOn}
              onChange={(next) => draft.set(BUG_REGRESSION_CHECK_SETTING_KEY, next)}
              label={t("verification.regressionGate")}
              testId="bug-regression-toggle"
            />
          }
          off={!gateOn}
          label={t("verification.regressionGate")}
          suffix={t("verification.regressionGateSuffix")}
          suffixTone="next-mid"
        />

        {gateOn ? (
          <div className="flex flex-col gap-[10px] border-l-[1.5px] border-strata-next-under pl-[14px]">
            <SettingField
              kicker={t("verification.regressionCommand")}
              stratum="next"
              htmlFor="bug-regression-command"
            >
              <SettingInput
                id="bug-regression-command"
                data-testid="bug-regression-command"
                chrome="ground"
                value={draft.text(BUG_REGRESSION_COMMAND_SETTING_KEY)}
                onChange={(event) =>
                  draft.set(BUG_REGRESSION_COMMAND_SETTING_KEY, event.target.value)
                }
              />
            </SettingField>
            <Mono size={10.5} tone="next-mid" as="div">
              {t("verification.regressionCommandNote", {
                placeholder: REGRESSION_COMMAND_FILE_PLACEHOLDER,
                default: DEFAULT_BUG_REGRESSION_COMMAND,
              })}
            </Mono>

            <SettingField
              kicker={t("verification.testFilePatterns")}
              stratum="next"
              htmlFor="test-file-patterns"
            >
              <SettingInput
                id="test-file-patterns"
                data-testid="test-file-patterns"
                chrome="ground"
                value={draft.text(TEST_FILE_PATTERNS_SETTING_KEY)}
                onChange={(event) =>
                  draft.set(TEST_FILE_PATTERNS_SETTING_KEY, event.target.value)
                }
              />
            </SettingField>
            <Mono size={10.5} tone="next-mid" as="div">
              {t("verification.testFilePatternsNote", {
                default: DEFAULT_TEST_FILE_PATTERNS.join(", "),
              })}
            </Mono>
          </div>
        ) : null}
      </StrataBand>
    </SettingsSection>
  );
}
