import type { ChatModeProvider } from "@/lib/agent-config/constants";
import type { UpdateConversationInput } from "@/hooks/useConversations";

/**
 * What the conversation PATCH must carry for one agent choice.
 *
 * A NAMED AGENT OWNS ITS PROVIDER: the PATCH route re-derives the provider from
 * the agent row, so a provider sent alongside a `namedAgentId` is silently
 * ignored — and sending both is how the user's choice gets lost. A raw provider
 * has to clear the link explicitly, or the stale named agent keeps winning
 * server-side.
 *
 * Extracted from the panel's `handleSelectAgentOrProvider` so the two surfaces
 * (the panel's select, this page's pill) cannot drift apart on the shape.
 */
export interface ChatAgentSelectionInput {
  namedAgentId: string | null;
  provider: ChatModeProvider;
}

export function agentSelectionPatch(
  selection: ChatAgentSelectionInput,
): UpdateConversationInput {
  return selection.namedAgentId
    ? { namedAgentId: selection.namedAgentId }
    : { provider: selection.provider, namedAgentId: null };
}
