"use client";

import {
  AgentsMemoryBand,
  GlobalPromptBand,
  PipelineBand,
  SettingsFooter,
  VerificationBand,
  useSettingsDraft,
} from "@/components/settings-piscine";
import { McpServersSection } from "@/components/settings/McpServersSection";

/**
 * Paramètres → Pipeline.
 *
 * The tab the frame does not draw. It holds the nine settings that decide what
 * an autonomous run actually does — pipeline defaults, verification commands,
 * the bug-regression gate, the MCP tool channel, the memory and spec
 * automations, and the global prompt. Every one of them is read by an agent at
 * dispatch time; none of them had a home in frame 11c.
 *
 * The third-party MCP server list lives here too, right under the band that
 * owns `mcp_tools_enabled`: that flag is its single gate (off = no MCP at
 * all, arij channel included), so separating the two would put the switch on
 * one tab and what it switches off on another. It is the one surface on this
 * page outside the draft/footer contract — it owns its own rows through
 * `/api/mcp-servers`, so it saves per row rather than through the page PATCH.
 *
 * Same grammar as Workspace: one stratum per subject, one draft, one footer,
 * one PATCH.
 */
export default function PipelineSettingsPage() {
  const draft = useSettingsDraft();

  return (
    <div className="flex flex-col gap-[10px]">
      <PipelineBand draft={draft} />
      <VerificationBand draft={draft} />
      <AgentsMemoryBand draft={draft} />
      <GlobalPromptBand draft={draft} />

      {/* Global servers (projectId null); per-project rows live on the
          project's own settings tab. */}
      <McpServersSection projectId={null} />

      <SettingsFooter
        dirty={draft.dirty}
        saving={draft.saving}
        onSave={() => void draft.save()}
        onDiscard={draft.discard}
        message={draft.message}
        messageTone={draft.messageTone}
        disabled={draft.loadFailed}
      />
    </div>
  );
}
