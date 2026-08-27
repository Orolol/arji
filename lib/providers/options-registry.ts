/**
 * Per-CLI named-agent option registry — the single source of truth for which
 * options each provider exposes, what values they accept, and how a value
 * becomes CLI arguments.
 *
 * The UI renders its "CLI options" section from this file and the providers
 * translate from it at spawn time, so an option exists in exactly one place.
 * A provider with no entry here simply has no options: the UI renders no
 * section and the spawn argv is byte-identical to what it was before.
 *
 * MEASURED, NOT ASSUMED. Every option below was checked against the CLI
 * installed on this machine (see the per-provider notes); the epic's
 * provisional list is corrected by those measurements rather than copied:
 *
 *   claude 2.1.245   --effort, --permission-mode exist.
 *                    --max-turns and --fast do NOT exist in this CLI.
 *   codex-cli 0.148  -c model_reasoning_effort=<low|medium|high|xhigh>
 *                    (`minimal` parses but the API rejects it for gpt-5.5),
 *                    -p/--profile (NOT accepted by `codex exec resume`).
 *   omp 18.0.5       --thinking, --max-time, --advisor.
 *   agy 1.1.22       --effort (low|medium|high).
 *
 * Deliberately NOT exposed, each for a measured reason:
 *   codex -s/--sandbox and its approval policy — the sandbox is what severs
 *     codex's MCP tool channel (see codexApprovalArgs() in ./codex.ts). An
 *     option that silently turns reviews back into prose is a regression with
 *     a settings toggle in front of it.
 *   omp --approval-mode — same failure: always-ask gates device writes behind
 *     an approval that auto-blocks in print mode (see ./oh-my-pi.ts).
 *   agy --mode — Arij derives the read-only posture from the session mode.
 *   agy --sandbox — its effect on run_command and on the MCP shim agy spawns
 *     is unmeasured; see the note beside AGY_OPTIONS.
 *
 * This module is imported by client components, so it must stay free of node
 * built-ins and of any import that pulls in `child_process` or the database.
 */

import { isCodeProducingAgentType } from "@/lib/agent-config/constants";
import type { ProviderType } from "./types";

export type ProviderOptionType = "select" | "bool" | "number" | "text";

/** A stored option value. `undefined` is "unset", never a stored value. */
export type ProviderOptionValue = string | number | boolean;

/** The options persisted on a named agent, keyed by option key. */
export type NamedAgentCliOptions = Record<string, ProviderOptionValue>;

export interface ProviderOptionChoice {
  value: string;
  label: string;
}

export interface ProviderOptionDefinition {
  /** Stable storage key. Never renamed — it is persisted per agent. */
  key: string;
  label: string;
  hint: string;
  type: ProviderOptionType;
  /**
   * The value that means "leave it to the CLI". A stored value equal to the
   * default emits no argument at all, which is what keeps an agent with no
   * options chosen byte-identical to the pre-registry argv.
   */
  default: ProviderOptionValue;
  /** select only — the accepted values, in display order. */
  choices?: ProviderOptionChoice[];
  /** number only — inclusive bounds, both required when type is "number". */
  min?: number;
  max?: number;
  /** text only — the accepted shape. */
  pattern?: RegExp;
  /**
   * Translation to CLI arguments for a non-default value. Absent means the
   * provider consumes the option itself rather than appending arguments —
   * today only claude's permission mode, which REPLACES a derived flag (see
   * resolveClaudePermissionMode).
   */
  toArgs?: (value: ProviderOptionValue) => string[];
  /**
   * False when the CLI's resume path rejects the flag. `codex exec resume`
   * takes a strict subset of `codex exec`'s flags, and an unknown flag there
   * is a fatal argv error, not a warning.
   */
  resumeSupported?: boolean;
  /**
   * True when the option may only be applied to a CODE-PRODUCING session
   * (build / ticket_build / team_build), as decided by the session's agent
   * TYPE — not by its spawn mode.
   *
   * The distinction is load-bearing: reviews, grading and the second-opinion
   * gate all spawn in mode "code" on purpose, because plan mode refuses the
   * mutating MCP tools they exist to call (see the comments at
   * lib/pipeline/stages.ts and lib/grading/dispatch.ts). Anything gated on
   * the spawn mode alone therefore reaches reviewers too.
   */
  codeProducingOnly?: boolean;
}

const EFFORT_CHOICES: ProviderOptionChoice[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

/**
 * Claude Code's permission modes that are SAFE for a headless, allowlisted
 * spawn. `claude --help` on 2.1.245 prints six; `plan` is deliberately not
 * offered.
 *
 * Measured on 2.1.245, `claude --print --permission-mode <mode>
 * --allowedTools Write` asked to write one file:
 *
 *   bypassPermissions  file written
 *   acceptEdits        file written
 *   manual             file written
 *   dontAsk            file written
 *   auto               file written
 *   plan               NOT written
 *
 * `plan` is the odd one out at the harness level too: it refuses mutating
 * tools regardless of the allowlist, INCLUDING the Arij MCP tools (see
 * buildClaudeArgs in lib/claude/spawn.ts). An agent set to it cannot call
 * update_ticket_status, so its ticket never leaves in_progress, and — before
 * the codeProducingOnly gate below — a reviewer set to it filed no findings
 * and persisted no review_verdict, silently degrading every review to the
 * prose fallback. Arij still derives "plan" itself for genuinely read-only
 * spawns; what is removed is the ability to CHOOSE it per agent.
 *
 * The remaining five behave headlessly because allowlisted tools are
 * auto-approved; they differ in how much they tighten a code session
 * relative to Arij's bypassPermissions default.
 */
const CLAUDE_PERMISSION_MODES: ProviderOptionChoice[] = [
  { value: "acceptEdits", label: "Accept edits" },
  { value: "auto", label: "Auto" },
  { value: "bypassPermissions", label: "Bypass permissions" },
  { value: "manual", label: "Manual" },
  { value: "dontAsk", label: "Don't ask" },
];

const CLAUDE_CODE_OPTIONS: ProviderOptionDefinition[] = [
  {
    key: "effort",
    label: "Effort",
    hint: "How much thinking Claude Code puts into each turn. Empty uses the CLI's own default.",
    type: "select",
    default: "",
    choices: EFFORT_CHOICES,
    toArgs: (value) => ["--effort", String(value)],
  },
  {
    key: "permission_mode",
    label: "Permission mode",
    hint: "Applies to code-producing sessions (build, ticket build, team build). Reviews, grading and every read-only session keep the posture their tool channel needs.",
    type: "select",
    default: "",
    choices: CLAUDE_PERMISSION_MODES,
    // Gated on the agent TYPE, not the spawn mode: reviews and grading spawn
    // in mode "code" on purpose, so a mode-only gate would reach them.
    codeProducingOnly: true,
    // No toArgs: buildClaudeArgs replaces its derived --permission-mode
    // rather than appending a second one.
  },
];

const CODEX_OPTIONS: ProviderOptionDefinition[] = [
  {
    key: "reasoning_effort",
    label: "Reasoning effort",
    hint: "Codex's reasoning budget. Empty uses the model's own default.",
    type: "select",
    default: "",
    choices: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra high" },
    ],
    // codex has no dedicated flag; the documented path is a config override,
    // and `-c` is accepted by both `codex exec` and `codex exec resume`.
    toArgs: (value) => ["-c", `model_reasoning_effort=${String(value)}`],
  },
  {
    key: "profile",
    label: "Config profile",
    hint: "Layers $CODEX_HOME/<name>.config.toml over the base config. Empty uses no profile.",
    type: "text",
    default: "",
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    toArgs: (value) => ["-p", String(value)],
    // `codex exec resume` has no --profile; passing it there is fatal.
    resumeSupported: false,
  },
];

const OH_MY_PI_OPTIONS: ProviderOptionDefinition[] = [
  {
    key: "thinking",
    label: "Thinking",
    hint: "Oh My Pi's thinking level. Empty uses the CLI's own default.",
    type: "select",
    default: "",
    choices: [
      { value: "off", label: "Off" },
      { value: "minimal", label: "Minimal" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra high" },
      { value: "max", label: "Max" },
      { value: "auto", label: "Auto" },
    ],
    toArgs: (value) => ["--thinking", String(value)],
  },
  {
    key: "max_time",
    label: "Time limit (seconds)",
    hint: "Stops the session after this many seconds. Empty lets Arij's watchdog own the timing.",
    type: "number",
    default: 0,
    min: 30,
    max: 86_400,
    toArgs: (value) => ["--max-time", String(value)],
  },
  {
    key: "advisor",
    label: "Advisor",
    hint: "Runs Oh My Pi's advisor, which passively reviews each turn and injects notes.",
    type: "bool",
    default: false,
    toArgs: () => ["--advisor"],
  },
];

const AGY_OPTIONS: ProviderOptionDefinition[] = [
  {
    key: "effort",
    label: "Reasoning effort",
    hint: "Antigravity's reasoning effort. Empty uses the CLI's own default.",
    type: "select",
    default: "",
    choices: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    toArgs: (value) => ["--effort", String(value)],
  },
];

/*
 * agy `--sandbox` ("terminal restrictions enabled") is deliberately NOT
 * offered, and unlike the other exclusions this one is withheld for a
 * measurement that could not be completed rather than one that came back
 * negative. Two things would have to hold before it is safe:
 *
 *  1. run_command still works — a build agent that cannot run the test suite
 *     is not a tightened build, it is a broken one;
 *  2. the Arij stdio MCP shim still starts. agy spawns it as a child that
 *     inherits ARIJ_BASE_URL / ARIJ_MCP_TOKEN from the CLI's own environment
 *     (see the buildEnv note in ./agy.ts), which is exactly the kind of thing
 *     a terminal sandbox restricts.
 *
 * A shell probe on 1.1.22 was inconclusive (the control run without the flag
 * did not write its file either), and (2) cannot be settled without a live
 * MCP token. Every other entry in this file is justified by a measured effect
 * on the tool channel; shipping this one on a guess is precisely the failure
 * the codex-sandbox exclusion above exists to prevent.
 */

/**
 * The registry. A provider absent from this map has no options — that is the
 * no-regression path for any CLI added later and not yet measured.
 */
const REGISTRY: Partial<Record<ProviderType, ProviderOptionDefinition[]>> = {
  "claude-code": CLAUDE_CODE_OPTIONS,
  codex: CODEX_OPTIONS,
  "oh-my-pi": OH_MY_PI_OPTIONS,
  agy: AGY_OPTIONS,
};

const NO_OPTIONS: ProviderOptionDefinition[] = [];

/** Option definitions for a provider; empty for anything not in the registry. */
export function getProviderOptionDefinitions(
  provider: string | null | undefined,
): ProviderOptionDefinition[] {
  if (!provider) return NO_OPTIONS;
  return REGISTRY[provider as ProviderType] ?? NO_OPTIONS;
}

/** True when the option is unset — its value is indistinguishable from absent. */
export function isProviderOptionDefault(
  definition: ProviderOptionDefinition,
  value: ProviderOptionValue | undefined,
): boolean {
  if (value === undefined || value === null || value === "") return true;
  return value === definition.default;
}

export interface ProviderOptionValidation {
  /** Registry-known, non-default values only. Never contains unset keys. */
  options: NamedAgentCliOptions;
  /** One message per rejected key. Empty when everything validated. */
  errors: string[];
}

function validateOne(
  definition: ProviderOptionDefinition,
  raw: unknown,
): { value?: ProviderOptionValue; error?: string } {
  switch (definition.type) {
    case "bool": {
      if (typeof raw !== "boolean") {
        return { error: `${definition.label} must be true or false` };
      }
      return { value: raw };
    }
    case "number": {
      const numeric = typeof raw === "string" ? Number(raw) : raw;
      if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
        return { error: `${definition.label} must be a number` };
      }
      if (!Number.isInteger(numeric)) {
        return { error: `${definition.label} must be a whole number` };
      }
      const min = definition.min ?? Number.NEGATIVE_INFINITY;
      const max = definition.max ?? Number.POSITIVE_INFINITY;
      if (numeric < min || numeric > max) {
        return {
          error: `${definition.label} must be between ${min} and ${max}`,
        };
      }
      return { value: numeric };
    }
    case "select": {
      if (typeof raw !== "string") {
        return { error: `${definition.label} must be one of the offered values` };
      }
      const allowed = definition.choices?.some((choice) => choice.value === raw);
      if (!allowed) {
        const values = (definition.choices ?? [])
          .map((choice) => choice.value)
          .join(", ");
        return {
          error: `${definition.label} must be one of: ${values}`,
        };
      }
      return { value: raw };
    }
    case "text": {
      if (typeof raw !== "string") {
        return { error: `${definition.label} must be text` };
      }
      const trimmed = raw.trim();
      if (definition.pattern && !definition.pattern.test(trimmed)) {
        return { error: `${definition.label} has an unsupported value` };
      }
      return { value: trimmed };
    }
  }
}

/**
 * Validates a raw option bag against one provider's registry entry.
 *
 * Keys the provider does not declare are DROPPED, not rejected: switching an
 * agent's CLI is an ordinary edit, and the leftovers of the previous CLI must
 * not become a permanent save error. Values that are declared but wrong ARE
 * rejected, because a bad value would reach argv.
 *
 * Values equal to the option's default are dropped too, so "nothing chosen"
 * and "chosen, then reset" are the same stored state — and the same argv.
 */
export function normalizeProviderOptions(
  provider: string | null | undefined,
  raw: unknown,
): ProviderOptionValidation {
  const definitions = getProviderOptionDefinitions(provider);
  if (definitions.length === 0 || raw === null || raw === undefined) {
    return { options: {}, errors: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { options: {}, errors: ["options must be an object"] };
  }

  const source = raw as Record<string, unknown>;
  const options: NamedAgentCliOptions = {};
  const errors: string[] = [];

  for (const definition of definitions) {
    if (!(definition.key in source)) continue;

    const incoming = source[definition.key];
    if (
      incoming === undefined ||
      incoming === null ||
      incoming === "" ||
      incoming === definition.default
    ) {
      continue;
    }

    const { value, error } = validateOne(definition, incoming);
    if (error) {
      errors.push(error);
      continue;
    }
    if (value !== undefined && !isProviderOptionDefault(definition, value)) {
      options[definition.key] = value;
    }
  }

  return { options, errors };
}

/** Parses the JSON stored on `named_agents.options`; `{}` on anything odd. */
export function parseStoredProviderOptions(
  provider: string | null | undefined,
  stored: string | null | undefined,
): NamedAgentCliOptions {
  if (!stored) return {};
  try {
    return normalizeProviderOptions(provider, JSON.parse(stored)).options;
  } catch {
    return {};
  }
}

/**
 * Drops options this session's agent TYPE is not allowed to carry.
 *
 * Applied at the spawn wiring point, where the agent type is known, so the
 * registry stays the one place a restriction is declared. Options with no
 * restriction pass through untouched, which keeps every other option's argv
 * identical.
 *
 * `agentType` null/unknown is treated as NOT code-producing: a session whose
 * role Arij cannot name does not get the option that widens what a spawn may
 * do to the working tree.
 */
export function filterProviderOptionsForAgentType(
  provider: string | null | undefined,
  options: NamedAgentCliOptions | null | undefined,
  agentType: string | null | undefined,
): NamedAgentCliOptions {
  if (!options) return {};

  const restricted = getProviderOptionDefinitions(provider)
    .filter((definition) => definition.codeProducingOnly)
    .map((definition) => definition.key);
  if (restricted.length === 0) return { ...options };

  const codeProducing = isCodeProducingAgentType(agentType);
  if (codeProducing) return { ...options };

  const kept: NamedAgentCliOptions = {};
  for (const [key, value] of Object.entries(options)) {
    if (!restricted.includes(key)) kept[key] = value;
  }
  return kept;
}

export interface ProviderOptionArgsContext {
  /** True on a CLI resume path, where some flags are not accepted. */
  resume?: boolean;
}

/**
 * Translates stored options into CLI arguments, in registry order.
 *
 * Returns `[]` for an unknown provider, an empty bag, or a bag whose values
 * are all defaults — which is the property that keeps an unconfigured agent's
 * argv identical to what it was before this registry existed.
 */
export function buildProviderOptionArgs(
  provider: string | null | undefined,
  options: NamedAgentCliOptions | null | undefined,
  context: ProviderOptionArgsContext = {},
): string[] {
  if (!options) return [];
  const definitions = getProviderOptionDefinitions(provider);
  const args: string[] = [];

  for (const definition of definitions) {
    if (!definition.toArgs) continue;
    if (context.resume && definition.resumeSupported === false) continue;

    const value = options[definition.key];
    if (isProviderOptionDefault(definition, value)) continue;

    args.push(...definition.toArgs(value as ProviderOptionValue));
  }

  return args;
}

/**
 * The `--permission-mode` a claude-code spawn should use.
 *
 * TWO gates, and they cover different things:
 *
 *  1. The agent TYPE gate, applied upstream by
 *     filterProviderOptionsForAgentType at the spawn wiring point. That is
 *     the one that matters, because reviews, grading and the second-opinion
 *     gate deliberately spawn in mode "code" — plan mode refuses the mutating
 *     MCP tools they exist to call. By the time this function sees the
 *     options, a non-code-producing session no longer carries the key.
 *
 *  2. The spawn MODE gate below, kept as defence in depth for the read-only
 *     postures ("plan", "chat", "analyze") used by direct call sites that
 *     never pass through the wiring point — chat turns carry cliOptions on
 *     ResolvedAgent. A per-agent setting is not authority to hand a read-only
 *     guarantee away.
 *
 * The value is also re-checked against the offered choices, so a bag written
 * before an option was narrowed (the `plan` value, removed after measurement)
 * falls back to the derived posture rather than reaching argv.
 */
export function resolveClaudePermissionMode(
  mode: "plan" | "code" | "analyze" | "chat",
  options: NamedAgentCliOptions | null | undefined,
): string {
  const derived =
    mode === "plan" ? "plan" : mode === "chat" ? "default" : "bypassPermissions";

  if (mode !== "code") return derived;

  const chosen = options?.permission_mode;
  if (typeof chosen !== "string" || chosen === "") return derived;

  const known = CLAUDE_PERMISSION_MODES.some(
    (choice) => choice.value === chosen,
  );
  return known ? chosen : derived;
}

/**
 * Human-readable "options in effect" pairs for a session detail view.
 * Unknown keys are kept verbatim so an option removed from the registry
 * still reads sensibly on an old session row.
 */
export function describeProviderOptions(
  provider: string | null | undefined,
  options: NamedAgentCliOptions | null | undefined,
): Array<{ key: string; label: string; value: string }> {
  if (!options) return [];
  const definitions = getProviderOptionDefinitions(provider);
  const byKey = new Map(definitions.map((d) => [d.key, d]));

  return Object.entries(options).map(([key, value]) => {
    const definition = byKey.get(key);
    if (!definition) {
      return { key, label: key, value: String(value) };
    }
    const choice = definition.choices?.find(
      (candidate) => candidate.value === String(value),
    );
    return {
      key,
      label: definition.label,
      value:
        definition.type === "bool"
          ? value
            ? "on"
            : "off"
          : (choice?.label ?? String(value)),
    };
  });
}
