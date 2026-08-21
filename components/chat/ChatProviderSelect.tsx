"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import {
  OPENAI_COMPATIBLE_PROVIDER,
  PROVIDER_LABELS,
  PROVIDER_OPTIONS,
  type AgentProvider,
  type ChatModeProvider,
} from "@/lib/agent-config/constants";
import type { Conversation } from "@/hooks/useConversations";

export interface ChatAgentSelection {
  namedAgentId: string | null;
  provider: ChatModeProvider;
}

interface ChatProviderSelectProps {
  activeConversation: Conversation | null;
  onSelect: (selection: ChatAgentSelection) => void;
  disabled?: boolean;
  className?: string;
}

/** True for a provider string that has its own item in the list below. */
function isSelectableProvider(value: string): boolean {
  return (
    value === OPENAI_COMPATIBLE_PROVIDER ||
    PROVIDER_OPTIONS.includes(value as AgentProvider)
  );
}

/**
 * Single unified chat agent and provider selector:
 * Offers Direct API (OpenAI-compatible fast mode), configured Named Agents,
 * and raw CLI Providers.
 */
export function ChatProviderSelect({
  activeConversation,
  onSelect,
  disabled = false,
  className,
}: ChatProviderSelectProps) {
  const { agents, loading } = useNamedAgentsList();
  const safeAgents = Array.isArray(agents) ? agents : [];

  if (loading) {
    return (
      <Select disabled>
        <SelectTrigger
          data-testid="chat-agent-select"
          className={
            className ??
            "h-[26px] w-44 border-0 bg-transparent text-[12.5px] text-muted-foreground shadow-none"
          }
        >
          <SelectValue placeholder="Loading..." />
        </SelectTrigger>
      </Select>
    );
  }

  // Mirrors the server's resolution order (chat/stream/route.ts): a linked
  // named agent wins, otherwise the stored provider. A namedAgentId whose
  // agent was deleted falls back to the provider rather than to an empty
  // selection, so the trigger never goes blank on a live conversation.
  const linkedAgent = activeConversation?.namedAgentId
    ? safeAgents.find((agent) => agent.id === activeConversation.namedAgentId)
    : undefined;
  const storedProvider = activeConversation?.provider ?? "";
  const selectedValue = linkedAgent
    ? linkedAgent.id
    : isSelectableProvider(storedProvider)
      ? storedProvider
      : "";

  function handleValueChange(nextValue: string) {
    if (nextValue === OPENAI_COMPATIBLE_PROVIDER) {
      onSelect({
        namedAgentId: null,
        provider: OPENAI_COMPATIBLE_PROVIDER,
      });
    } else {
      const selectedAgent = safeAgents.find((a) => a.id === nextValue);
      if (selectedAgent) {
        onSelect({
          namedAgentId: selectedAgent.id,
          provider: selectedAgent.provider,
        });
      } else if (PROVIDER_OPTIONS.includes(nextValue as AgentProvider)) {
        onSelect({
          namedAgentId: null,
          provider: nextValue as AgentProvider,
        });
      }
    }
  }

  return (
    <Select
      value={selectedValue || ""}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <SelectTrigger
        data-testid="chat-agent-select"
        className={
          className ??
          "h-[26px] w-44 border-0 bg-transparent text-[12.5px] text-muted-foreground shadow-none"
        }
      >
        <SelectValue placeholder="Select provider" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel className="text-[11px] font-semibold text-muted-foreground px-2 py-1">
            Direct API
          </SelectLabel>
          <SelectItem
            value={OPENAI_COMPATIBLE_PROVIDER}
            data-testid="chat-option-openai-compatible"
          >
            {PROVIDER_LABELS[OPENAI_COMPATIBLE_PROVIDER]}
          </SelectItem>
        </SelectGroup>
        {safeAgents.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-[11px] font-semibold text-muted-foreground px-2 py-1">
              Named Agents
            </SelectLabel>
            {safeAgents.map((agent) => (
              <SelectItem
                key={agent.id}
                value={agent.id}
                data-testid={`chat-option-agent-${agent.id}`}
              >
                {agent.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        <SelectGroup>
          <SelectLabel className="text-[11px] font-semibold text-muted-foreground px-2 py-1">
            CLI Providers
          </SelectLabel>
          {PROVIDER_OPTIONS.map((provider) => (
            <SelectItem
              key={provider}
              value={provider}
              data-testid={`chat-option-provider-${provider}`}
            >
              {`${PROVIDER_LABELS[provider]} (CLI)`}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
