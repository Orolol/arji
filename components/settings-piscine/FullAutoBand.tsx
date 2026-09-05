"use client";

import * as React from "react";

import {
  BandHeader,
  CheckMark,
  Mono,
  SegmentedControl,
  SelectPill,
  StrataBand,
} from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import {
  AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
} from "@/lib/agents/scheduler-constants";
import {
  AUTO_MODE_BUILD_AGENT_SETTING_KEY,
  AUTO_MODE_ENABLED_SETTING_KEY,
  AUTO_MODE_REVIEW_AGENT_SETTING_KEY,
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
 *
 * THE TWO ROLE PILLS are the workspace default for `resolveAutoModeConfig`'s
 * project → global → built-in chain, and the only place it can be set: before
 * this band, `auto_mode_build_agent` / `auto_mode_review_agent` were reachable
 * only through AutoModeDialog, which writes the SUFFIXED per-project keys.
 * "Default" is the empty value — no workspace default, so the chain falls
 * through to the built-in Claude Code — not an agent whose name is blank.
 *
 * …AND THEY DO NOT DIE WITH THE MASTER SWITCH. `dimmed` is the BARE
 * `auto_mode_enabled`, but the desk popover arms one project through
 * `auto_mode_enabled:<projectId>`, which the resolver reads FIRST — so a
 * workspace with the bare key off can be armed and dispatching. These two
 * pills are that dispatch's fallback rung: their value keeps deciding which
 * agent runs unattended work, and disabling them locks a user who arms
 * projects one at a time out of a live setting.
 *
 * THE REST OF THE BAND KEEPS THE FRAME'S DISABLE AS A SCOPE LINE, NOT AS A
 * RUNTIME GUARANTEE. Their values are not suspended either: for a project
 * armed on its own, `resolveAutoModeConfigForProject` inherits the global
 * `auto_mode_smart_dispatch` and `full_auto_second_opinion` through the same
 * fallback chain, and `resolveMaxConcurrentForProject` applies
 * `agent_max_concurrent` without ever reading `auto_mode_enabled`. They stay
 * disabled here because unlocking them is a separate product decision; the
 * pills are the control the bug report names, so they are the one that
 * changes.
 */
export interface FullAutoBandProps {
  draft: SettingsDraft;
  /** Total projects, or null when `GET /api/projects` failed — never 0 as a guess. */
  projectCount: number | null;
}

type ConcurrencySegment = "2" | "4" | "8" | "inf" | "";

const LADDER: readonly ConcurrencySegment[] = ["2", "4", "8", "inf"];

export function FullAutoBand({ draft, projectCount }: FullAutoBandProps) {
  const { agents: namedAgents } = useNamedAgentsList();
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

            {/*
              THE ONE FIELD THIS BAND KEEPS OPERABLE. It dims with the band —
              that state is honest — but it stays clickable, so the two pills
              opt back out of BandDim's two disabling halves and nothing here
              passes `dimmed` down:
              - `pointer-events-auto` undoes the body's `pointer-events-none`;
              - `aria-disabled={false}` stops the body's `aria-disabled="true"`
                propagating, which is how assistive tech (and Playwright's
                actionability check) reads a disabled ancestor.
              Drop either one and the pills go back to being unclickable while
              a project armed from the desk is dispatching under their value.
            */}
            <SettingField
              kicker="AGENTS PAR DÉFAUT"
              stratum="live"
              flex={1}
              testId="full-auto-agents"
            >
              <div
                data-testid="full-auto-agents-live"
                aria-disabled={false}
                className="pointer-events-auto flex items-center gap-[6px]"
              >
                <RolePill
                  role="build"
                  settingKey={AUTO_MODE_BUILD_AGENT_SETTING_KEY}
                  label="Build"
                  testId="auto-build-agent"
                  draft={draft}
                  agents={namedAgents}
                />
                <RolePill
                  role="review"
                  settingKey={AUTO_MODE_REVIEW_AGENT_SETTING_KEY}
                  label="Review"
                  testId="auto-review-agent"
                  draft={draft}
                  agents={namedAgents}
                />
              </div>
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

/**
 * One role's workspace default. The pill shows the agent's NAME, never its id:
 * an id on screen is unreadable, and a stored id whose agent has since been
 * deleted must not render as if it still resolved — it falls back to
 * "Default", which is what the resolution chain will actually do.
 */
function RolePill({
  role,
  settingKey,
  label,
  testId,
  draft,
  agents,
}: {
  role: "build" | "review";
  settingKey: string;
  label: string;
  testId: string;
  draft: SettingsDraft;
  agents: readonly { id: string; name: string }[];
}) {
  const selected = draft.text(settingKey);
  const name = agents.find((agent) => agent.id === selected)?.name ?? "Default";

  return (
    <div data-testid={testId} className="min-w-0">
      <SelectPill
        label={`${label} · ${name}`}
        tone="ink"
        fill="card"
        className="h-[30px]"
      >
        <DropdownMenuItem onSelect={() => draft.set(settingKey, "")}>
          Default
        </DropdownMenuItem>
        {agents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            onSelect={() => draft.set(settingKey, agent.id)}
          >
            {agent.name}
          </DropdownMenuItem>
        ))}
      </SelectPill>
      <span className="sr-only">{`Agent ${role} par défaut`}</span>
    </div>
  );
}
