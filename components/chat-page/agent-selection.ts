import type { AgentSelection } from "@/components/shared/AgentSelectPill";
import type {
  Conversation,
  UpdateConversationInput,
} from "@/hooks/useConversations";

/**
 * The picker's own contract, not a second copy of it — one shape for the desk,
 * the chat page and the project panel is the whole point of the merge.
 */
export type ChatAgentSelectionInput = AgentSelection;

/**
 * What the conversation PATCH must carry for one agent choice.
 *
 * A NAMED AGENT OWNS ITS PROVIDER: the PATCH route re-derives the provider from
 * the agent row, so a provider sent alongside a `namedAgentId` is silently
 * ignored — and sending both is how the user's choice gets lost. A raw provider
 * has to clear the link explicitly, or the stale named agent keeps winning
 * server-side.
 *
 * `null` for a selection that names nothing to write: the picker's "Default
 * agent" (`{ namedAgentId: null, provider: null }`), which belongs to dispatch
 * surfaces. A conversation is never patched into "no provider" — PATCHing
 * `provider: null` would clear a live conversation's mode.
 *
 * Shared by every chat surface so they cannot drift apart on the shape.
 */
export function agentSelectionPatch(
  selection: ChatAgentSelectionInput,
): UpdateConversationInput | null {
  if (selection.namedAgentId) return { namedAgentId: selection.namedAgentId };
  if (!selection.provider) return null;
  return { provider: selection.provider, namedAgentId: null };
}

/**
 * What the picker selects on for a stored conversation — the READ direction,
 * where `agentSelectionPatch` is the write one.
 *
 * Both chat surfaces derived this by hand from the same two columns, with the
 * same cast of a free-form text column to the narrow provider union. Two
 * copies of a mapping is how the label rule drifts: rename a provider, touch
 * one of them, and the composer pill and the roster row then name the same
 * conversation differently. `AgentSelection` accepts the legacy value
 * outright, so no call site has to assert anything here.
 */
export function selectionForConversation(
  conversation: Pick<Conversation, "provider" | "namedAgentId"> | null | undefined,
): AgentSelection {
  return {
    namedAgentId: conversation?.namedAgentId ?? null,
    provider: conversation?.provider ?? null,
  };
}
