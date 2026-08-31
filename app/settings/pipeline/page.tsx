"use client";

import {
  AgentsMemoryBand,
  GlobalPromptBand,
  PipelineBand,
  SettingsFooter,
  VerificationBand,
  useSettingsDraft,
} from "@/components/settings-piscine";

/**
 * Paramètres → Pipeline.
 *
 * The tab the frame does not draw. It holds the nine settings that decide what
 * an autonomous run actually does — pipeline defaults, verification commands,
 * the bug-regression gate, the MCP tool channel, the memory and spec
 * automations, and the global prompt. Every one of them is read by an agent at
 * dispatch time; none of them had a home in frame 11c.
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
