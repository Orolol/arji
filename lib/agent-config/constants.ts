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
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

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
};

export type AgentProvider = "claude-code" | "codex";

export const PROVIDER_OPTIONS: AgentProvider[] = ["claude-code", "codex"];

export function isAgentProvider(value: string): value is AgentProvider {
  return PROVIDER_OPTIONS.includes(value as AgentProvider);
}
