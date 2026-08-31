"use client";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";

import { SettingRow } from "./SettingRow";
import { SettingToggle } from "./SettingToggle";
import { SettingsSection } from "./SettingsSection";
import {
  MCP_TOOLS_ENABLED_SETTING_KEY,
  MEMORY_AUTO_DISTILL_SETTING_KEY,
  SPEC_AUTO_REWRITE_SETTING_KEY,
} from "./settings-fields";
import type { SettingsDraft } from "./useSettingsDraft";

/**
 * AGENTS & MÉMOIRE — the turquoise stratum of the Pipeline tab.
 *
 * Three switches that change what an agent session IS: whether it gets the
 * structured tool channel, whether a green build refreshes the project memory,
 * whether a release rewrites the spec. Each keeps the sentence that explains
 * it — those sentences are the only documentation of what the switches do.
 *
 * `mcp_tools_enabled` is the one DEFAULT-ON flag in the whole table: only an
 * explicitly-false value disables it. The asymmetry is reproduced in
 * `settings-fields.ts`, not here.
 */
export interface AgentsMemoryBandProps {
  draft: SettingsDraft;
}

export function AgentsMemoryBand({ draft }: AgentsMemoryBandProps) {
  return (
    <SettingsSection testId="agents-memory-settings" heading="Agents and memory">
      <StrataBand stratum="live">
        <BandHeader
          stratum="live"
          label="Agents & mémoire"
          meta={
            <span className="font-sans text-[11.5px] leading-normal">
              ce qu&apos;une session d&apos;agent reçoit, et ce qu&apos;elle
              laisse derrière elle
            </span>
          }
        />

        <SettingRow
          toggle={
            <SettingToggle
              on={draft.flag(MCP_TOOLS_ENABLED_SETTING_KEY)}
              onChange={(next) => draft.set(MCP_TOOLS_ENABLED_SETTING_KEY, next)}
              label="Outils MCP Arij"
              testId="mcp-tools-toggle"
            />
          }
          off={!draft.flag(MCP_TOOLS_ENABLED_SETTING_KEY)}
          label="Outils MCP Arij"
          suffix="· on par défaut"
          suffixTone="live-mid"
        />
        <Mono size={10.5} tone="live-mid" as="div">
          lire son ticket, commenter, changer le statut, poser une question
          bloquante, déposer un finding — sans conventions en prose. Off : les
          nouvelles sessions démarrent sans le canal, les sessions en cours ne
          bougent pas.
        </Mono>

        <SettingRow
          toggle={
            <SettingToggle
              on={draft.flag(MEMORY_AUTO_DISTILL_SETTING_KEY)}
              onChange={(next) => draft.set(MEMORY_AUTO_DISTILL_SETTING_KEY, next)}
              label="Distiller la mémoire après un build réussi"
              testId="memory-auto-distill-toggle"
            />
          }
          off={!draft.flag(MEMORY_AUTO_DISTILL_SETTING_KEY)}
          label="Distiller la mémoire après un build réussi"
        />
        <Mono size={10.5} tone="live-mid" as="div">
          un agent de distillation fusionne les nouvelles conventions dans la
          mémoire du projet, injectée ensuite dans chaque prompt. Off par
          défaut.
        </Mono>

        <SettingRow
          toggle={
            <SettingToggle
              on={draft.flag(SPEC_AUTO_REWRITE_SETTING_KEY)}
              onChange={(next) => draft.set(SPEC_AUTO_REWRITE_SETTING_KEY, next)}
              label="Réécrire la spec après chaque release"
              testId="spec-auto-rewrite-toggle"
            />
          }
          off={!draft.flag(SPEC_AUTO_REWRITE_SETTING_KEY)}
          label="Réécrire la spec après chaque release"
        />
        <Mono size={10.5} tone="live-mid" as="div">
          à la publication d&apos;une release, un agent en plan-mode réécrit la
          spécification pour coller à ce qui a réellement été livré. Sautée
          pendant une mise à jour manuelle. Off par défaut.
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
