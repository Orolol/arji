export const AGENT_TYPES = [
  "build",
  "review_security",
  "review_code",
  "review_compliance",
  "chat",
  "spec_generation",
  "team_build",
  "ticket_build",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const PROVIDER_OPTIONS = ["claude-code", "codex"] as const;

export type ProviderOption = (typeof PROVIDER_OPTIONS)[number];

export function isValidAgentType(value: string): value is AgentType {
  return AGENT_TYPES.includes(value as AgentType);
}

export function isValidProvider(value: string): value is ProviderOption {
  return PROVIDER_OPTIONS.includes(value as ProviderOption);
}

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  build: "Build",
  review_security: "Security Review",
  review_code: "Code Review",
  review_compliance: "Compliance Review",
  chat: "Chat",
  spec_generation: "Spec Generation",
  team_build: "Team Build",
  ticket_build: "Ticket Build",
};
