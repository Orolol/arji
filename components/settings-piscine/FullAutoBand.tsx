"use client";

import * as React from "react";

import {
  BandHeader,
  CheckMark,
  Mono,
  SegmentedControl,
  StrataBand,
} from "@/components/piscine";
import {
  AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
} from "@/lib/agents/scheduler-constants";
import {
  AUTO_MODE_ENABLED_SETTING_KEY,
  AUTO_MODE_SMART_DISPATCH_SETTING_KEY,
  FULL_AUTO_SECOND_OPINION_SETTING_KEY,
  parseAutoModeEnabled,
} from "@/lib/auto-mode/constants";

import { BandDim } from "./BandDim";
import { SettingField } from "./SettingField";
import { SettingRow } from "./SettingRow";
import { SettingToggle } from "./SettingToggle";
import { SettingsSection } from "./SettingsSection";
import type { SettingsDraft } from "./useSettingsDraft";

/**
 * FULL AUTO — the turquoise stratum, and the real human/machine contract.
 *
 * THIS BAND WRITES BARE KEYS ONLY. `lib/auto-mode/config.ts` resolves every
 * value through per-project key → global key → built-in default; a bare
 * `auto_mode_enabled` is the global, `auto_mode_enabled:<projectId>` is the
 * per-project override owned by `AutoModeDialog`. Writing a suffixed key from
 * here would silently convert a workspace setting into project state.
 *
 * THE BLAST RADIUS IS PART OF THE CONTROL. `listAutoModeEnabledProjectIds`
 * reads the global flag as "every project EXCEPT those that stored false", so
 * arming this toggle arms unattended build → review → merge-into-main across
 * the whole workspace. The frame draws a bare switch; we draw the switch and
 * one mono line of derived truth under it.
 *
 * TWO OF THE FRAME'S THREE ROWS ARE NOT SETTINGS. "Refuser les tickets avec
 * findings ouverts" is `evaluateMergeReadiness().ready` — an invariant, shown
 * as a CheckMark, because a permanently-on toggle claims an off state that
 * does not exist. "Chaîner review puis land automatiquement si clean" is what
 * the supervisor always does; it moved into the footnote. The two toggle slots
 * carry two real global booleans instead.
 */
export interface FullAutoBandProps {
  draft: SettingsDraft;
  /** Total projects, or null when `GET /api/projects` failed — never 0 as a guess. */
  projectCount: number | null;
}

type ConcurrencySegment = "2" | "4" | "8" | "inf" | "";

const LADDER: readonly ConcurrencySegment[] = ["2", "4", "8", "inf"];

export function FullAutoBand({ draft, projectCount }: FullAutoBandProps) {
  const enabled = draft.flag(AUTO_MODE_ENABLED_SETTING_KEY);
  const dimmed = !enabled;

  const stored = draft.text(AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY);
  const segment: ConcurrencySegment = (
    LADDER as readonly string[]
  ).includes(stored)
    ? (stored as ConcurrencySegment)
    : "";
  // A free integer behind a four-rung ladder: 1, 3, 5, 6… have no segment.
  // Leave every rung inactive and say the number rather than snap it — a snap
  // would silently rewrite the scheduler's budget.
  const offLadder = stored !== "" && segment === "";

  const optedOut = React.useMemo(() => {
    const prefix = `${AUTO_MODE_ENABLED_SETTING_KEY}:`;
    let count = 0;
    for (const [key, value] of Object.entries(draft.data)) {
      if (!key.startsWith(prefix)) continue;
      if (parseAutoModeEnabled(value) === false) count += 1;
    }
    return count;
  }, [draft.data]);

  const armed = projectCount === null ? null : Math.max(0, projectCount - optedOut);

  return (
    <SettingsSection testId="full-auto-settings">
      <StrataBand stratum="live">
        <BandHeader
          stratum="live"
          label="Full Auto"
          meta={
            <span className="font-sans text-[11.5px] leading-normal">
              le pilote qui dispatche tout seul — ces règles le bornent
            </span>
          }
          right={
            <SettingToggle
              size="lg"
              on={enabled}
              onChange={(next) => draft.set(AUTO_MODE_ENABLED_SETTING_KEY, next)}
              label="Full Auto"
              testId="full-auto-master"
            />
          }
        />

        <BandDim dimmed={dimmed} testId="full-auto-body">
          <div className="flex flex-wrap items-end gap-[20px]">
            <SettingField
              kicker="AGENTS EN PARALLÈLE, MAX"
              stratum="live"
              flex={1}
              testId="agent-max-concurrent"
            >
              <SegmentedControl<ConcurrencySegment>
                chrome="filled"
                size="md"
                className="[--segment-inactive:var(--strata-live-mid)]"
                options={LADDER.map((v) => ({
                  value: v,
                  label: v === "inf" ? "∞" : v,
                  disabled: dimmed,
                }))}
                value={segment}
                onChange={(next) =>
                  draft.set(AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY, next)
                }
              />
              {offLadder ? (
                <Mono size={10} tone="live-mid" as="div">
                  {`réglé sur ${stored} — hors des paliers`}
                </Mono>
              ) : null}
            </SettingField>

            <div className="flex min-w-[260px] flex-[1.6] flex-col justify-end gap-[8px]">
              <SettingRow
                toggle={
                  <SettingToggle
                    on={draft.flag(AUTO_MODE_SMART_DISPATCH_SETTING_KEY)}
                    onChange={(next) =>
                      draft.set(AUTO_MODE_SMART_DISPATCH_SETTING_KEY, next)
                    }
                    disabled={dimmed}
                    label="Choisir l'agent d'après son historique"
                    testId="auto-smart-dispatch"
                  />
                }
                off={!draft.flag(AUTO_MODE_SMART_DISPATCH_SETTING_KEY)}
                label="Choisir l'agent d'après son historique"
                suffix="· rôles non assignés"
                suffixTone="live-mid"
              />
              <SettingRow
                toggle={
                  <SettingToggle
                    on={draft.flag(FULL_AUTO_SECOND_OPINION_SETTING_KEY)}
                    onChange={(next) =>
                      draft.set(FULL_AUTO_SECOND_OPINION_SETTING_KEY, next)
                    }
                    disabled={dimmed}
                    label="Second avis indépendant avant le land"
                    testId="auto-second-opinion"
                  />
                }
                off={!draft.flag(FULL_AUTO_SECOND_OPINION_SETTING_KEY)}
                label="Second avis indépendant avant le land"
                suffix="· un slot review"
                suffixTone="live-mid"
              />
              <SettingRow
                toggle={<CheckMark checked shape="disc" tone="live" />}
                label="Refuser les tickets avec findings ouverts"
                suffix="· toujours"
                suffixTone="live-mid"
              />
            </div>
          </div>

          <Mono size={10.5} tone="live-mid" as="div">
            Chaîne review puis land automatiquement si clean · land sans
            confirmation humaine
          </Mono>
          <div data-testid="full-auto-blast-radius">
            <Mono size={10.5} tone="live-mid" as="div">
              {`arme ${armed === null ? "—" : armed} projets · ${optedOut} l'ont désactivé`}
            </Mono>
          </div>
        </BandDim>
      </StrataBand>
    </SettingsSection>
  );
}
