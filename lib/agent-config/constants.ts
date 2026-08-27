export const AGENT_TYPES = [
  "build",
  "review_security",
  "review_code",
  "review_compliance",
  "review_feature",
  "grading",
  "refinement",
  "chat",
  "spec_generation",
  "team_build",
  "ticket_build",
  "merge",
  "tech_check",
  "e2e_test",
  "release_notes",
  "title_generation",
  "import_analysis",
  "memory_distill",
  "dreaming",
  "forensic",
  "failure_digest",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * Agent types that produce code and own the in_progress column of the ticket
 * they are building. Drives the workflow engine's in_progress lock and
 * owning-session exemption (lib/workflow/context.ts) and the terminal
 * rollback sweeps (lib/agent-sessions/boot-cleanup.ts, lib/agents/scheduler.ts).
 * The "you may move your own ticket" prompt sentence
 * (lib/claude/prompt-sections.ts) uses this list minus team_build: a team
 * session row carries no epicId, so its MCP token has no ticket and the move
 * would 400 — promising it recreates the "board transition refused" bug for
 * that type. The similar lists in review-segregation, dispatch-reliability
 * and auto-mode select for different purposes and must stay separate.
 */
export const CODE_PRODUCING_AGENT_TYPES = [
  "build",
  "ticket_build",
  "team_build",
] as const;

/** True for the code-producing agent types; rows without a type are not. */
export function isCodeProducingAgentType(
  value: string | null | undefined
): boolean {
  return (
    value !== null &&
    value !== undefined &&
    (CODE_PRODUCING_AGENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The code-producing types the prompt layer tells they may move their own
 * ticket to review — `CODE_PRODUCING_AGENT_TYPES` minus `team_build`: a
 * team session row carries no epicId, so its MCP token has no ticket and
 * the move would 400 with MISSING_TICKET. Promising the capability the
 * tool channel cannot deliver recreates the "board transition refused"
 * bug for that type; if team builds ever get a ticketed session row, add
 * them back here.
 */
export const TICKET_MOVING_AGENT_TYPES: Exclude<
  (typeof CODE_PRODUCING_AGENT_TYPES)[number],
  "team_build"
>[] = CODE_PRODUCING_AGENT_TYPES.filter((type) => type !== "team_build");

/**
 * Agent types that receive a named agent's persona pre-prompt.
 *
 * An ALLOWLIST, deliberately, and the asymmetry is the whole point: missing a
 * type here costs a persona that should have been applied, while missing one
 * in a blocklist writes free-form persona text into a document Arij persists
 * verbatim. `spec_generation` replaces `projects.spec`, the memory writers
 * replace the memory document, `release_notes` becomes CHANGELOG.md, and
 * `title_generation` / `import_analysis` answer under strict format
 * contracts — a persona such as "answer in French and summarise your
 * reasoning" ends up inside the stored artifact, which then feeds every later
 * prompt. A new agent type therefore gets no persona until someone adds it
 * here on purpose.
 *
 * This is the same reasoning as MCP_EXEMPT_AGENT_TYPES in
 * lib/workflow/dreaming-constants.ts, but the two lists are NOT
 * interchangeable: that one is a blocklist covering only the types whose
 * prompt must not gain a trailing tools section, and it does not include
 * `spec_generation`.
 *
 * The set is the epic's stated scope — code work and review work —
 * plus the review-adjacent types that share their prompt shape. Second
 * opinion is a runtime-only string (SECOND_OPINION_AGENT_TYPE in
 * lib/auto-mode/second-opinion.ts) rather than a member of AGENT_TYPES,
 * so it is spelled out.
 */
export const PERSONA_AGENT_TYPES: readonly string[] = [
  ...CODE_PRODUCING_AGENT_TYPES,
  "review_security",
  "review_code",
  "review_compliance",
  "review_feature",
  "review_second_opinion",
  "grading",
  "merge",
];

/** True for the agent types a persona pre-prompt is injected into. */
export function acceptsPersonaPrompt(
  agentType: string | null | undefined
): boolean {
  return agentType != null && PERSONA_AGENT_TYPES.includes(agentType);
}

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
  grading: "Acceptance Grading",
  refinement: "Board Refinement",
  chat: "Chat",
  spec_generation: "Spec Generation",
  team_build: "Team Build",
  ticket_build: "Ticket Build",
  merge: "Merge",
  tech_check: "Tech Check",
  e2e_test: "E2E Test",
  release_notes: "Release Notes",
  title_generation: "Conversation Title",
  import_analysis: "Import Analysis",
  memory_distill: "Memory Distill",
  dreaming: "Dreaming",
  forensic: "Forensic",
  failure_digest: "Failure Digest",
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
  grading: "",
  refinement: "",
  chat: "",
  spec_generation: "",
  team_build: "",
  ticket_build: "",
  merge: "",
  tech_check: "",
  e2e_test: "",
  release_notes: "",
  title_generation: "",
  import_analysis: "",
  memory_distill: "",
  dreaming: "",
  forensic: "",
  failure_digest: "",
};

/**
 * Ready-to-use instructions for a custom review agent. The creation form is
 * intentionally useful after typing only a name.
 */
export const DEFAULT_REVIEW_AGENT_PROMPT = `You are a code reviewer. Review the changes on this ticket's branch and report concrete problems: bugs, security issues, missing edge cases, and unclear naming. Reference files and lines. Do not restyle working code.`;

/**
 * Selectable CLI providers. Every entry must support per-spawn MCP
 * injection of the Arij tool channel (lib/providers/types.ts documents the
 * rule); CLIs without that surface were removed in the 2026-08 cleanup.
 */
export type AgentProvider = "claude-code" | "codex" | "oh-my-pi" | "agy";

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
 * Chat-only modes backed by a long-lived CLI process. They are deliberately
 * separate from AgentProvider: build/review dispatch remains one process per
 * session, while chat conversations can explicitly opt into a warm process.
 */
export const CLAUDE_CODE_PERSISTENT_PROVIDER =
  "claude-code-persistent" as const;
export const OH_MY_PI_PERSISTENT_PROVIDER = "oh-my-pi-persistent" as const;

export const PERSISTENT_CHAT_PROVIDER_OPTIONS = [
  CLAUDE_CODE_PERSISTENT_PROVIDER,
  OH_MY_PI_PERSISTENT_PROVIDER,
] as const;

export type PersistentChatProvider =
  (typeof PERSISTENT_CHAT_PROVIDER_OPTIONS)[number];

/**
 * A provider a chat conversation can run on: any CLI agent provider, or
 * the OpenAI-compatible direct-API fast mode.
 */
export type ChatModeProvider =
  | AgentProvider
  | PersistentChatProvider
  | typeof OPENAI_COMPATIBLE_PROVIDER;

/**
 * Stable order — `pickAlternativeReviewProvider()` walks this list to choose
 * a reviewer that differs from the builder, so new providers are appended
 * rather than inserted.
 */
export const PROVIDER_OPTIONS: AgentProvider[] = [
  "claude-code",
  "codex",
  "oh-my-pi",
  "agy",
];

export const PROVIDER_LABELS: Record<ChatModeProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "oh-my-pi": "Oh My Pi",
  agy: "Antigravity",
  "openai-compatible": "OpenAI-compatible",
  "claude-code-persistent": "Claude Code — persistent",
  "oh-my-pi-persistent": "Oh My Pi — persistent",
};

export function isAgentProvider(value: string): value is AgentProvider {
  return (PROVIDER_OPTIONS as readonly string[]).includes(value);
}

/** True for anything a chat conversation can run on (see ChatModeProvider). */
export function isChatProvider(value: string): value is ChatModeProvider {
  return (
    value === OPENAI_COMPATIBLE_PROVIDER ||
    isAgentProvider(value) ||
    isPersistentChatProvider(value)
  );
}

export function isPersistentChatProvider(
  value: string | null | undefined,
): value is PersistentChatProvider {
  return Boolean(
    value &&
      (PERSISTENT_CHAT_PROVIDER_OPTIONS as readonly string[]).includes(value),
  );
}

/** Provider process used underneath a chat-only persistent mode. */
export function persistentChatBaseProvider(
  provider: PersistentChatProvider,
): Extract<AgentProvider, "claude-code" | "oh-my-pi"> {
  return provider === CLAUDE_CODE_PERSISTENT_PROVIDER
    ? "claude-code"
    : "oh-my-pi";
}

/**
 * Persona given to a newly created named agent. Applied at creation only —
 * migration 0041 leaves existing agents at NULL so that adding the feature
 * does not rewrite the prompt of every agent already configured.
 */
export const DEFAULT_PERSONA_PROMPT = "You're an experienced developer";

/**
 * Ceiling on a persona, in characters.
 *
 * The persona rides at the head of EVERY prompt this agent receives, so it is
 * one of the few unbounded sections a user can grow without noticing; the
 * same budgeting rule as the comment history applies (see
 * PROMPT_COMMENT_MAX_CHARS). Generous enough for a paragraph or two, small
 * enough that it can never be the reason a prompt outgrows argv.
 */
export const PERSONA_PROMPT_MAX_CHARS = 2_000;
