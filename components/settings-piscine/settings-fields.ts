/**
 * The settings inventory of frame 11c — one entry per key the screen owns.
 *
 * WHY A REGISTRY AND NOT 58 useState. The page this replaces held every value
 * in its own hook with its own save button; the failure mode of rebuilding it
 * is a setting silently disappearing. Here every batched key declares, in one
 * place, how it is READ out of `GET /api/settings` and how the editor value is
 * PARSED back into what the PATCH stores — and `SETTINGS_INVENTORY` names the
 * tab and the test id it must be reachable through, so a regression test can
 * assert the whole table is still on screen.
 *
 * TWO VALUE SPACES, never confused:
 * - the EDITOR value (what the control holds: a string, or a boolean),
 * - the STORED value (what the PATCH body carries: number | boolean | null |
 *   string | array).
 * `read` goes stored → editor, `parse` goes editor → stored. Normalisation on
 * the way out is free: after a successful save the merged server state is fed
 * back through `read`, so a clamped breaker, a re-joined pattern list and
 * reformatted verify JSON all appear exactly as they were stored.
 *
 * EMPTY IS NEVER ZERO. Every "clear me" case parses to `null` (or `""` for
 * `projects_root`, whose blank IS a valid value that clears the override) and
 * is WRITTEN, never omitted — omitting the key would leave the old value in
 * the database while the field shows empty.
 *
 * GLOBAL KEYS ONLY. Every key here is bare. A `<key>:<projectId>` override is
 * per-project state edited by the project's own surfaces (AutoModeDialog,
 * LimitsView, the project settings page); this screen must never write one.
 */

import {
  AUTO_MODE_BUILD_AGENT_SETTING_KEY,
  AUTO_MODE_ENABLED_SETTING_KEY,
  AUTO_MODE_REVIEW_AGENT_SETTING_KEY,
  AUTO_MODE_SMART_DISPATCH_SETTING_KEY,
  FULL_AUTO_SECOND_OPINION_SETTING_KEY,
  parseAutoModeEnabled,
} from "@/lib/auto-mode/constants";
import {
  AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
  parseMaxConcurrentSetting,
} from "@/lib/agents/scheduler-constants";
import {
  NIGHT_CIRCUIT_BREAKER_SETTING_KEY,
  NIGHT_COST_CAP_SETTING_KEY,
  parseNightCircuitBreaker,
  parseNightCostCap,
} from "@/lib/night/constants";
import {
  DEFAULT_PIPELINE_MAX_ATTEMPTS,
  DEFAULT_PIPELINE_MAX_FIX_CYCLES,
  PIPELINE_ENABLED_SETTING_KEY,
  PIPELINE_GRADER_ENABLED_SETTING_KEY,
  PIPELINE_MAX_ATTEMPTS_SETTING_KEY,
  PIPELINE_MAX_FIX_CYCLES_SETTING_KEY,
  parsePipelineEnabledSetting,
  parsePipelineMaxAttempts,
  parsePipelineMaxFixCycles,
} from "@/lib/pipeline/constants";
import {
  PROJECTS_ROOT_SETTING_KEY,
  parseProjectsRootSetting,
} from "@/lib/projects/workspace-constants";
import { PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY, parsePromptTokenBudget } from "@/lib/tokens/budget-settings";
import {
  CLAUDE_WEEKLY_BUDGET_SETTING_KEY,
  MONTHLY_CAP_SETTING_KEY,
} from "@/lib/types/usage";
import {
  BUG_REGRESSION_CHECK_SETTING_KEY,
  BUG_REGRESSION_COMMAND_SETTING_KEY,
  DEFAULT_BUG_REGRESSION_COMMAND,
  DEFAULT_TEST_FILE_PATTERNS,
  REGRESSION_COMMAND_FILE_PLACEHOLDER,
  TEST_FILE_PATTERNS_SETTING_KEY,
  parseBugRegressionCommand,
  parseBugRegressionSetting,
  parseTestFilePatterns,
} from "@/lib/verify/regression-constants";
import {
  VERIFY_COMMANDS_SETTING_KEY,
  VERIFY_TIMEOUT_MS_SETTING_KEY,
  parseVerifyCommands,
  parseVerifyTimeoutMs,
  resolveVerifyConfig,
} from "@/lib/verify/verify-constants";
import { DREAMING_AFTER_NIGHT_RUN_SETTING_KEY, parseDreamingAfterNightRunSetting } from "@/lib/workflow/dreaming-constants";
import {
  OPENAI_API_KEY_SETTING_KEY,
  OPENAI_BASE_URL_SETTING_KEY,
  OPENAI_MODEL_SETTING_KEY,
  OPENAI_REASONING_EFFORT_SETTING_KEY,
} from "@/lib/openai/constants";
/**
 * `github_pat`, inlined. The constant lives in `lib/github/client.ts`, which
 * imports better-sqlite3 — importing it here would drag the database into the
 * client bundle. The old settings page inlined the literal for the same
 * reason; `app/api/settings/route.ts` remains the authority.
 */
export const GITHUB_PAT_SETTING_KEY = "github_pat";

/** Keys that carry a global prompt / memory / spec switch and have no constant. */
export const GLOBAL_PROMPT_SETTING_KEY = "global_prompt";
export const MEMORY_AUTO_DISTILL_SETTING_KEY = "memory_auto_distill";
export const SPEC_AUTO_REWRITE_SETTING_KEY = "spec_auto_rewrite";
export const MCP_TOOLS_ENABLED_SETTING_KEY = "mcp_tools_enabled";

/** What a control holds. Text fields and segments are strings; toggles are booleans. */
export type EditorValue = string | boolean;

export type SettingsData = Record<string, unknown>;

/**
 * `value` — send it. `omit` — the editor holds nothing storable (a half-typed
 * number), so the key drops out of this PATCH. `error` — refuse the WHOLE
 * save and show this message; the settings route validates every key before
 * writing any, and so does this screen.
 */
export type ParseResult =
  | { readonly value: unknown }
  | { readonly omit: true }
  | { readonly error: string };

export interface SettingFieldSpec {
  key: string;
  /** Stored payload → editor value. Never renders a built-in default as typed text. */
  read: (data: SettingsData) => EditorValue;
  /** Editor value → PATCH value, or a refusal. */
  parse: (editor: EditorValue) => ParseResult;
}

function bool(editor: EditorValue): boolean {
  return editor === true;
}

/** A positive dollar amount, or null to clear. Shared by both usage budgets. */
function parseDollarBudget(editor: EditorValue): ParseResult {
  const raw = String(editor).trim();
  if (raw === "") return { value: null };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: "Budget must be a positive dollar amount." };
  }
  return { value: parsed };
}

/** A stored dollar budget only counts when it is positive; anything else is "none". */
function readDollarBudget(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? String(value)
    : "";
}

const SPECS: readonly SettingFieldSpec[] = [
  /* ── Workspace ──────────────────────────────────────────────────────── */
  {
    key: PROJECTS_ROOT_SETTING_KEY,
    read: (data) => parseProjectsRootSetting(data[PROJECTS_ROOT_SETTING_KEY]) ?? "",
    // Blank IS valid: it clears the override (app/api/settings/route.ts).
    parse: (editor) => ({ value: String(editor).trim() }),
  },
  {
    key: AUTO_MODE_ENABLED_SETTING_KEY,
    read: (data) => parseAutoModeEnabled(data[AUTO_MODE_ENABLED_SETTING_KEY]) ?? false,
    parse: (editor) => ({ value: bool(editor) }),
  },
  {
    key: AUTO_MODE_SMART_DISPATCH_SETTING_KEY,
    read: (data) =>
      parseAutoModeEnabled(data[AUTO_MODE_SMART_DISPATCH_SETTING_KEY]) ?? false,
    parse: (editor) => ({ value: bool(editor) }),
  },
  {
    key: FULL_AUTO_SECOND_OPINION_SETTING_KEY,
    read: (data) =>
      parseAutoModeEnabled(data[FULL_AUTO_SECOND_OPINION_SETTING_KEY]) ?? false,
    parse: (editor) => ({ value: bool(editor) }),
  },
  /*
    The two Full Auto roles. Editor value is a named-agent id, or "" for the
    "Default" row — which is the ABSENCE of a workspace default, not an agent
    named "". It parses to null and is WRITTEN, so clearing actually clears:
    `resolveAutoModeConfig` then falls through project → global → built-in.
    Bare keys only, as the file header says — the `:<projectId>` overrides are
    the Full Auto popover's to write.
  */
  {
    key: AUTO_MODE_BUILD_AGENT_SETTING_KEY,
    read: (data) =>
      typeof data[AUTO_MODE_BUILD_AGENT_SETTING_KEY] === "string"
        ? (data[AUTO_MODE_BUILD_AGENT_SETTING_KEY] as string)
        : "",
    parse: (editor) => ({ value: String(editor) || null }),
  },
  {
    key: AUTO_MODE_REVIEW_AGENT_SETTING_KEY,
    read: (data) =>
      typeof data[AUTO_MODE_REVIEW_AGENT_SETTING_KEY] === "string"
        ? (data[AUTO_MODE_REVIEW_AGENT_SETTING_KEY] as string)
        : "",
    parse: (editor) => ({ value: String(editor) || null }),
  },
  {
    // Shared with components/agents-workshop/LimitsView.tsx — SAME key, SAME
    // parser, SAME encoding: unlimited round-trips as 0.
    key: AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
    read: (data) => {
      const parsed = parseMaxConcurrentSetting(
        data[AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY],
      );
      if (parsed === null) return "";
      return Number.isFinite(parsed) ? String(parsed) : "inf";
    },
    parse: (editor) => {
      const raw = String(editor).trim();
      if (raw === "") return { omit: true };
      if (raw === "inf") return { value: 0 };
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) return { omit: true };
      return { value: parsed };
    },
  },
  {
    key: NIGHT_COST_CAP_SETTING_KEY,
    read: (data) => {
      const cap = parseNightCostCap(data[NIGHT_COST_CAP_SETTING_KEY]);
      return cap == null ? "" : String(cap);
    },
    parse: (editor) => {
      const raw = String(editor).trim();
      if (raw === "") return { value: null }; // empty = unlimited
      const parsed = parseNightCostCap(raw);
      if (parsed === null) return { error: "Cost cap must be a positive dollar amount." };
      return { value: parsed };
    },
  },
  {
    key: NIGHT_CIRCUIT_BREAKER_SETTING_KEY,
    read: (data) => {
      const breaker = parseNightCircuitBreaker(data[NIGHT_CIRCUIT_BREAKER_SETTING_KEY]);
      return breaker == null ? "" : String(breaker);
    },
    parse: (editor) => {
      const raw = String(editor).trim();
      if (raw === "") return { value: null }; // empty = engine default
      const parsed = parseNightCircuitBreaker(raw);
      if (parsed === null) {
        return { error: "Circuit breaker must be a whole number between 0 and 10." };
      }
      return { value: parsed };
    },
  },
  {
    key: DREAMING_AFTER_NIGHT_RUN_SETTING_KEY,
    read: (data) =>
      parseDreamingAfterNightRunSetting(data[DREAMING_AFTER_NIGHT_RUN_SETTING_KEY]) ??
      false,
    parse: (editor) => ({ value: bool(editor) }),
  },
  {
    key: MONTHLY_CAP_SETTING_KEY,
    read: (data) => readDollarBudget(data[MONTHLY_CAP_SETTING_KEY]),
    parse: parseDollarBudget,
  },
  {
    key: CLAUDE_WEEKLY_BUDGET_SETTING_KEY,
    read: (data) => readDollarBudget(data[CLAUDE_WEEKLY_BUDGET_SETTING_KEY]),
    parse: parseDollarBudget,
  },
  {
    key: PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
    read: (data) => {
      const budget = parsePromptTokenBudget(data[PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY]);
      return budget == null ? "" : String(budget);
    },
    parse: (editor) => {
      const raw = String(editor).trim();
      if (raw === "") return { value: null };
      const parsed = parsePromptTokenBudget(raw);
      if (parsed === null || parsed <= 0) {
        return {
          error: "Budget must be a positive integer token count (e.g. 50000 or 50k).",
        };
      }
      return { value: parsed };
    },
  },

  /* ── Pipeline ───────────────────────────────────────────────────────── */
  {
    key: PIPELINE_ENABLED_SETTING_KEY,
    read: (data) =>
      parsePipelineEnabledSetting(data[PIPELINE_ENABLED_SETTING_KEY]) ?? true,
    parse: (editor) => ({ value: bool(editor) }),
  },
  {
    key: PIPELINE_GRADER_ENABLED_SETTING_KEY,
    read: (data) =>
      parsePipelineEnabledSetting(data[PIPELINE_GRADER_ENABLED_SETTING_KEY]) ?? false,
    parse: (editor) => ({ value: bool(editor) }),
  },
  {
    key: PIPELINE_MAX_ATTEMPTS_SETTING_KEY,
    read: (data) =>
      String(
        parsePipelineMaxAttempts(data[PIPELINE_MAX_ATTEMPTS_SETTING_KEY]) ??
          DEFAULT_PIPELINE_MAX_ATTEMPTS,
      ),
    parse: (editor) => {
      const parsed = parsePipelineMaxAttempts(String(editor).trim());
      // A half-typed number is not a refusal, it is nothing to save yet.
      return parsed === null ? { omit: true } : { value: parsed };
    },
  },
  {
    key: PIPELINE_MAX_FIX_CYCLES_SETTING_KEY,
    read: (data) =>
      String(
        parsePipelineMaxFixCycles(data[PIPELINE_MAX_FIX_CYCLES_SETTING_KEY]) ??
          DEFAULT_PIPELINE_MAX_FIX_CYCLES,
      ),
    parse: (editor) => {
      const parsed = parsePipelineMaxFixCycles(String(editor).trim());
      return parsed === null ? { omit: true } : { value: parsed };
    },
  },
  {
    key: VERIFY_COMMANDS_SETTING_KEY,
    read: (data) => JSON.stringify(resolveVerifyConfig(data).commands, null, 2),
    parse: (editor) => {
      const parsed = parseVerifyCommands(String(editor));
      if (parsed === null) {
        return {
          error:
            "Verification commands must be a JSON array of objects with non-empty name and command fields.",
        };
      }
      return { value: parsed };
    },
  },
  {
    key: VERIFY_TIMEOUT_MS_SETTING_KEY,
    read: (data) => String(resolveVerifyConfig(data).timeoutMs),
    parse: (editor) => {
      const parsed = parseVerifyTimeoutMs(String(editor).trim());
      if (parsed === null) {
        return { error: "Verification timeout must be a positive number of milliseconds." };
      }
      return { value: parsed };
    },
  },
  {
    key: BUG_REGRESSION_CHECK_SETTING_KEY,
    read: (data) =>
      parseBugRegressionSetting(data[BUG_REGRESSION_CHECK_SETTING_KEY]) ?? false,
    parse: (editor) => ({ value: bool(editor) }),
  },
  {
    key: BUG_REGRESSION_COMMAND_SETTING_KEY,
    read: (data) =>
      parseBugRegressionCommand(data[BUG_REGRESSION_COMMAND_SETTING_KEY]) ??
      DEFAULT_BUG_REGRESSION_COMMAND,
    parse: (editor) => {
      const parsed = parseBugRegressionCommand(String(editor));
      if (!parsed) {
        // Without {files} the template runs the whole suite on every check.
        return {
          error: `The command must contain ${REGRESSION_COMMAND_FILE_PLACEHOLDER} — it is replaced with the detected test files.`,
        };
      }
      return { value: parsed };
    },
  },
  {
    key: TEST_FILE_PATTERNS_SETTING_KEY,
    read: (data) =>
      (
        parseTestFilePatterns(data[TEST_FILE_PATTERNS_SETTING_KEY]) ??
        DEFAULT_TEST_FILE_PATTERNS
      ).join(", "),
    parse: (editor) => {
      const parsed = parseTestFilePatterns(String(editor));
      if (!parsed) return { error: "Enter at least one glob pattern." };
      return { value: parsed };
    },
  },
  {
    // The one default-ON flag: only an explicitly-false value disables it.
    key: MCP_TOOLS_ENABLED_SETTING_KEY,
    read: (data) => {
      const stored = data[MCP_TOOLS_ENABLED_SETTING_KEY];
      return !(stored === false || stored === "false");
    },
    parse: (editor) => ({ value: bool(editor) }),
  },
  {
    key: MEMORY_AUTO_DISTILL_SETTING_KEY,
    read: (data) => {
      const stored = data[MEMORY_AUTO_DISTILL_SETTING_KEY];
      return stored === true || stored === "true";
    },
    parse: (editor) => ({ value: bool(editor) }),
  },
  {
    key: SPEC_AUTO_REWRITE_SETTING_KEY,
    read: (data) => {
      const stored = data[SPEC_AUTO_REWRITE_SETTING_KEY];
      return stored === true || stored === "true";
    },
    parse: (editor) => ({ value: bool(editor) }),
  },
  {
    key: GLOBAL_PROMPT_SETTING_KEY,
    read: (data) => {
      const stored = data[GLOBAL_PROMPT_SETTING_KEY];
      return typeof stored === "string" ? stored : "";
    },
    parse: (editor) => ({ value: String(editor) }),
  },
];

/** key → spec, for the draft hook. */
export const SETTING_FIELDS: Readonly<Record<string, SettingFieldSpec>> =
  Object.fromEntries(SPECS.map((spec) => [spec.key, spec]));

/** Every batched key, in declaration order. */
export const SETTING_FIELD_KEYS: readonly string[] = SPECS.map((s) => s.key);

/** Reads the whole payload into editor values, once per server response. */
export function readEditors(data: SettingsData): Record<string, EditorValue> {
  const editors: Record<string, EditorValue> = {};
  for (const spec of SPECS) editors[spec.key] = spec.read(data);
  return editors;
}

/* ------------------------------------------------------------------ */
/* The inventory — every setting this screen owns, and where it lives   */
/* ------------------------------------------------------------------ */

export type SettingsTab = "workspace" | "pipeline" | "integrations";

export interface SettingsInventoryEntry {
  key: string;
  tab: SettingsTab;
  /** The `data-testid` that proves the control is on screen. */
  testId: string;
  /** `false` for the three secrets/webhooks, which are never batched. */
  batched: boolean;
}

/**
 * The load-bearing table: every setting the old 1862-line page owned, plus the
 * five global Full Auto / budget keys it never surfaced, each with the tab and
 * the test id it must be reachable through.
 *
 * `__tests__/settings-inventory.test.tsx` renders all three tabs and asserts
 * every entry here is in the DOM. That is the cheapest possible defence
 * against this packet's stated failure mode — a setting quietly disappearing.
 */
export const SETTINGS_INVENTORY: readonly SettingsInventoryEntry[] = [
  { key: PROJECTS_ROOT_SETTING_KEY, tab: "workspace", testId: "projects-root-setting", batched: true },
  { key: AUTO_MODE_ENABLED_SETTING_KEY, tab: "workspace", testId: "full-auto-master", batched: true },
  { key: AUTO_MODE_SMART_DISPATCH_SETTING_KEY, tab: "workspace", testId: "auto-smart-dispatch", batched: true },
  { key: FULL_AUTO_SECOND_OPINION_SETTING_KEY, tab: "workspace", testId: "auto-second-opinion", batched: true },
  { key: AUTO_MODE_BUILD_AGENT_SETTING_KEY, tab: "workspace", testId: "auto-build-agent", batched: true },
  { key: AUTO_MODE_REVIEW_AGENT_SETTING_KEY, tab: "workspace", testId: "auto-review-agent", batched: true },
  { key: AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY, tab: "workspace", testId: "agent-max-concurrent", batched: true },
  { key: NIGHT_COST_CAP_SETTING_KEY, tab: "workspace", testId: "night-cost-cap-setting", batched: true },
  { key: NIGHT_CIRCUIT_BREAKER_SETTING_KEY, tab: "workspace", testId: "night-circuit-breaker-setting", batched: true },
  { key: DREAMING_AFTER_NIGHT_RUN_SETTING_KEY, tab: "workspace", testId: "dream-after-night-run", batched: true },
  { key: MONTHLY_CAP_SETTING_KEY, tab: "workspace", testId: "monthly-cap-setting", batched: true },
  { key: CLAUDE_WEEKLY_BUDGET_SETTING_KEY, tab: "workspace", testId: "usage-budget-setting", batched: true },
  { key: PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY, tab: "workspace", testId: "prompt-token-budget-setting", batched: true },

  { key: PIPELINE_ENABLED_SETTING_KEY, tab: "pipeline", testId: "pipeline-enabled-toggle", batched: true },
  { key: PIPELINE_GRADER_ENABLED_SETTING_KEY, tab: "pipeline", testId: "pipeline-grader-toggle", batched: true },
  { key: PIPELINE_MAX_ATTEMPTS_SETTING_KEY, tab: "pipeline", testId: "pipeline-max-attempts", batched: true },
  { key: PIPELINE_MAX_FIX_CYCLES_SETTING_KEY, tab: "pipeline", testId: "pipeline-max-fix-cycles", batched: true },
  { key: VERIFY_COMMANDS_SETTING_KEY, tab: "pipeline", testId: "verify-commands", batched: true },
  { key: VERIFY_TIMEOUT_MS_SETTING_KEY, tab: "pipeline", testId: "verify-timeout-ms", batched: true },
  { key: BUG_REGRESSION_CHECK_SETTING_KEY, tab: "pipeline", testId: "bug-regression-toggle", batched: true },
  // Revealed by the toggle above; the inventory test switches it on first.
  { key: BUG_REGRESSION_COMMAND_SETTING_KEY, tab: "pipeline", testId: "bug-regression-command", batched: true },
  { key: TEST_FILE_PATTERNS_SETTING_KEY, tab: "pipeline", testId: "test-file-patterns", batched: true },
  { key: MCP_TOOLS_ENABLED_SETTING_KEY, tab: "pipeline", testId: "mcp-tools-toggle", batched: true },
  { key: MEMORY_AUTO_DISTILL_SETTING_KEY, tab: "pipeline", testId: "memory-auto-distill-toggle", batched: true },
  { key: SPEC_AUTO_REWRITE_SETTING_KEY, tab: "pipeline", testId: "spec-auto-rewrite-toggle", batched: true },
  { key: GLOBAL_PROMPT_SETTING_KEY, tab: "pipeline", testId: "global-prompt", batched: true },

  { key: GITHUB_PAT_SETTING_KEY, tab: "integrations", testId: "github-pat", batched: false },
  { key: OPENAI_BASE_URL_SETTING_KEY, tab: "integrations", testId: "openai-base-url", batched: false },
  { key: OPENAI_API_KEY_SETTING_KEY, tab: "integrations", testId: "openai-api-key", batched: false },
  { key: OPENAI_MODEL_SETTING_KEY, tab: "integrations", testId: "openai-model", batched: false },
  { key: OPENAI_REASONING_EFFORT_SETTING_KEY, tab: "integrations", testId: "openai-reasoning-effort", batched: false },
  { key: "webhook_url", tab: "integrations", testId: "webhooks-settings", batched: false },
];
