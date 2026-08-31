/**
 * The settings surface of frame 11c — one import surface, mirroring
 * `components/piscine/index.ts`.
 *
 * The Piscine primitive set is FROZEN and has no toggle, no field chrome and
 * no draft machinery, so those four live here. Everything else in this folder
 * is a band: a `StrataBand` plus the controls of one subject. Bands are dumb —
 * they take a `SettingsDraft` and render; the reading, parsing and saving all
 * happen in `useSettingsDraft` / `settings-fields`.
 */

export { SettingToggle } from "./SettingToggle";
export type { SettingToggleProps } from "./SettingToggle";

export { SettingRow } from "./SettingRow";
export type { SettingRowProps } from "./SettingRow";

export {
  SettingField,
  SettingInput,
  SettingTextarea,
  SETTING_INPUT_BASE,
} from "./SettingField";
export type {
  SettingFieldProps,
  SettingInputProps,
  SettingTextareaProps,
} from "./SettingField";

export { BandDim } from "./BandDim";
export type { BandDimProps } from "./BandDim";

export { SettingsSection } from "./SettingsSection";
export type { SettingsSectionProps } from "./SettingsSection";

export { SettingsFooter } from "./SettingsFooter";
export type { SettingsFooterProps } from "./SettingsFooter";

export { SettingsTabSync } from "./SettingsTabSync";

export { useSettingsDraft } from "./useSettingsDraft";
export type { SettingsDraft } from "./useSettingsDraft";

export {
  SETTING_FIELDS,
  SETTING_FIELD_KEYS,
  SETTINGS_INVENTORY,
  readEditors,
  GITHUB_PAT_SETTING_KEY,
  GLOBAL_PROMPT_SETTING_KEY,
  MEMORY_AUTO_DISTILL_SETTING_KEY,
  SPEC_AUTO_REWRITE_SETTING_KEY,
  MCP_TOOLS_ENABLED_SETTING_KEY,
} from "./settings-fields";
export type {
  EditorValue,
  ParseResult,
  SettingFieldSpec,
  SettingsData,
  SettingsInventoryEntry,
  SettingsTab,
} from "./settings-fields";

/* Bands — Workspace tab */
export { WorkspaceBand } from "./WorkspaceBand";
export { FullAutoBand } from "./FullAutoBand";
export { NightRunsBand } from "./NightRunsBand";
export { NotificationsBand } from "./NotificationsBand";
export type { NotificationWebhook } from "./NotificationsBand";
export { BudgetBand } from "./BudgetBand";

/* Bands — Pipeline tab */
export { PipelineBand } from "./PipelineBand";
export { VerificationBand } from "./VerificationBand";
export { AgentsMemoryBand } from "./AgentsMemoryBand";
export { GlobalPromptBand } from "./GlobalPromptBand";

/* Bands — Intégrations tab */
export { GitHubCard } from "./GitHubCard";
export { OpenAiCard } from "./OpenAiCard";
export { WebhooksBand } from "./WebhooksBand";
export type { WebhookRow } from "./WebhooksBand";

/* Bands — Apparence tab */
export { AppearanceBand } from "./AppearanceBand";
