export const AGENT_TYPES = [
  "build",
  "review_security",
  "review_code",
  "review_compliance",
  "review_feature",
  "chat",
  "spec_generation",
  "team_build",
  "ticket_build",
  "merge",
  "tech_check",
  "e2e_test",
  "release_notes",
  "memory_distill",
  "forensic",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * Agent types that produce code and own the in_progress column of the ticket
 * they are building. The workflow engine's in_progress lock
 * (lib/workflow/context.ts) and the "you may move your own ticket" prompt
 * sentence (lib/claude/prompt-sections.ts) must agree on this membership —
 * a new build type added to one but not the other recreates the "board
 * transition refused" bug for that type. The similar lists in
 * review-segregation, dispatch-reliability and auto-mode select for
 * different purposes and must stay separate.
 */
export const CODE_PRODUCING_AGENT_TYPES = [
  "build",
  "ticket_build",
  "team_build",
] as const;

export const BUILTIN_REVIEW_TYPES = [
  "security",
  "code_review",
  "compliance",
  "feature_review",
] as const;

export type BuiltinReviewType = (typeof BUILTIN_REVIEW_TYPES)[number];

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  build: "Build",
  review_security: "Review: Security",
  review_code: "Review: Code",
  review_compliance: "Review: Compliance",
  review_feature: "Review: Feature",
  chat: "Chat",
  spec_generation: "Spec Generation",
  team_build: "Team Build",
  ticket_build: "Ticket Build",
  merge: "Merge",
  tech_check: "Tech Check",
  e2e_test: "E2E Test",
  release_notes: "Release Notes",
  memory_distill: "Memory Distill",
  forensic: "Forensic",
};

export function isAgentType(value: string): value is AgentType {
  return AGENT_TYPES.includes(value as AgentType);
}

export const REVIEW_TYPE_TO_AGENT_TYPE: Record<BuiltinReviewType, AgentType> = {
  security: "review_security",
  code_review: "review_code",
  compliance: "review_compliance",
  feature_review: "review_feature",
};

export const BUILTIN_AGENT_PROMPTS: Record<AgentType, string> = {
  build: "",
  review_security: "",
  review_code: "",
  review_compliance: "",
  review_feature: "",
  chat: "",
  spec_generation: "",
  team_build: "",
  ticket_build: "",
  merge: "",
  tech_check: "",
  e2e_test: "",
  release_notes: "",
  memory_distill: "",
  forensic: "",
};

/**
 * Ready-to-use instructions for a custom review agent. The creation form is
 * intentionally useful after typing only a name.
 */
export const DEFAULT_REVIEW_AGENT_PROMPT = `You are a code reviewer. Review the changes on this ticket's branch and report concrete problems: bugs, security issues, missing edge cases, and unclear naming. Reference files and lines. Do not restyle working code.`;

export type AgentProvider =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "mistral-vibe"
  | "qwen-code"
  | "opencode"
  | "deepseek"
  | "kimi"
  | "zai"
  | "pi"
  | "oh-my-pi";

export const FALLBACK_PROVIDER: AgentProvider = "claude-code";
/**
 * The direct-API chat provider (fast mode). Deliberately NOT an
 * `AgentProvider`: it has no CLI to install or spawn, so it must never be
 * picked as a build/review provider, appear in `PROVIDER_OPTIONS`, or be
 * offered as a named-agent provider — it is a per-conversation chat mode
 * only.
 */
export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible" as const;

/**
 * A provider a chat conversation can run on: any CLI agent provider, or
 * the OpenAI-compatible direct-API fast mode.
 */
export type ChatModeProvider = AgentProvider | typeof OPENAI_COMPATIBLE_PROVIDER;

/**
 * Stable order — `pickAlternativeReviewProvider()` walks this list to choose
 * a reviewer that differs from the builder, so new providers are appended
 * rather than inserted.
 */
export const PROVIDER_OPTIONS: AgentProvider[] = [
  "claude-code",
  "codex",
  "gemini-cli",
  "mistral-vibe",
  "qwen-code",
  "opencode",
  "deepseek",
  "kimi",
  "zai",
  "pi",
  "oh-my-pi",
];

export const PROVIDER_LABELS: Record<ChatModeProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  "mistral-vibe": "Mistral Vibe",
  "qwen-code": "Qwen Code",
  opencode: "OpenCode",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  zai: "Zai",
  pi: "Pi",
  "oh-my-pi": "Oh My Pi",
  "openai-compatible": "OpenAI-compatible",
};

export function isAgentProvider(value: string): value is AgentProvider {
  return (PROVIDER_OPTIONS as readonly string[]).includes(value);
}

/** True for anything a chat conversation can run on (see ChatModeProvider). */
export function isChatProvider(value: string): value is ChatModeProvider {
  return value === OPENAI_COMPATIBLE_PROVIDER || isAgentProvider(value);
}
