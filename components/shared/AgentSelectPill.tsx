"use client";

import * as React from "react";

import { SelectPill } from "@/components/piscine";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useNamedAgentsList, type NamedAgentOption } from "@/hooks/useNamedAgentsList";
import {
  OPENAI_COMPATIBLE_PROVIDER,
  PERSISTENT_CHAT_PROVIDER_OPTIONS,
  PROVIDER_LABELS,
  PROVIDER_OPTIONS,
  type ChatModeProvider,
} from "@/lib/agent-config/constants";

/**
 * The one agent picker. Three menus used to answer "who runs this?" — the
 * desk composer's pill, the chat page's pill and the project panel's shadcn
 * `Select` — and they drifted: only one of them offered the direct API and the
 * persistent CLIs, and only one of them was a Piscine `SelectPill`.
 *
 * `mode` is the capability gate, and it is not cosmetic:
 * - `chat` — everything a conversation can run on (see `ChatModeProvider`).
 * - `dispatch` — named agents only, because a BUILD cannot run on the direct
 *   API (chat-only, spec §8) nor on a persistent CLI (chat-only by
 *   construction). Offering them on a dispatch surface would offer a
 *   dispatch that the route cannot honour.
 *
 * THE `chat-option-*` / `chat-agent-select` TEST IDS ARE LEGACY NAMES kept
 * byte-for-byte through the merge. They are what the existing suites select
 * on; renaming them would be a silent break for the gain of a nicer prefix.
 * The TRIGGER's id is overridable (`testId`) for one measured reason:
 * `/projects/:id` mounts the desk AND the chat panel, so two pills live on one
 * page and a shared id resolves to two elements.
 */
export type AgentSelectMode = "chat" | "dispatch";

/**
 * One selection, one shape, for both modes.
 *
 * A NAMED AGENT OWNS ITS PROVIDER: `provider` travels alongside `namedAgentId`
 * for display only — `agentSelectionPatch()` drops it, because the conversation
 * PATCH route re-derives it from the agent row.
 *
 * `provider: null` is "Default agent": no choice was made, the server resolves
 * it (`resolveAgentByNamedId`). It only ever comes out of `dispatch` mode —
 * naming a provider there would be inventing one the desk never sent.
 */
export interface AgentSelection {
  namedAgentId: string | null;
  provider: ChatModeProvider | null;
}

export interface AgentSelectPillProps {
  mode: AgentSelectMode;
  /** The current choice, as the surface stores it. */
  selection: AgentSelection;
  onSelect: (selection: AgentSelection) => void;
  disabled?: boolean;
  className?: string;
  /** Trigger id. Override where a page mounts two pickers (see above). */
  testId?: string;
}

export const DEFAULT_AGENT_LABEL = "Default agent";
export const AGENT_SELECT_LOADING_LABEL = "Chargement…";

/** Label of a provider, tolerating a legacy value stored before a cleanup. */
function providerLabel(provider: ChatModeProvider | null): string | null {
  if (!provider) return null;
  return PROVIDER_LABELS[provider] ?? provider;
}

export function AgentSelectPill({
  mode,
  selection,
  onSelect,
  disabled = false,
  className,
  testId = "chat-agent-select",
}: AgentSelectPillProps) {
  const { agents, loading } = useNamedAgentsList();
  const safeAgents: NamedAgentOption[] = Array.isArray(agents) ? agents : [];

  // Mirrors the server's resolution order (chat/stream/route.ts): a linked
  // named agent wins, otherwise the stored provider. A namedAgentId whose
  // agent was deleted falls back to the provider rather than to an empty
  // trigger, so the pill never goes blank on a live conversation.
  const linkedAgent = selection.namedAgentId
    ? safeAgents.find((agent) => agent.id === selection.namedAgentId)
    : undefined;

  const label =
    linkedAgent?.name ??
    // The name lives in a list that has not landed yet — say so rather than
    // flashing the provider underneath and then swapping it.
    (loading && selection.namedAgentId
      ? AGENT_SELECT_LOADING_LABEL
      : (providerLabel(selection.provider) ??
        (mode === "dispatch" ? DEFAULT_AGENT_LABEL : "—")));

  const agentItems = safeAgents.map((agent) => (
    <DropdownMenuItem
      key={agent.id}
      data-testid={`chat-option-agent-${agent.id}`}
      onSelect={() =>
        onSelect({ namedAgentId: agent.id, provider: agent.provider })
      }
    >
      {agent.name}
    </DropdownMenuItem>
  ));

  return (
    <SelectPill
      data-testid={testId}
      label={label}
      tone="ink"
      // The trigger stays on screen while the agent list loads — a picker that
      // disappears and comes back moves the whole row under the cursor.
      disabled={disabled || loading}
      className={className}
    >
      {mode === "dispatch" ? (
        <>
          <DropdownMenuItem
            data-testid="chat-option-default-agent"
            onSelect={() => onSelect({ namedAgentId: null, provider: null })}
          >
            {DEFAULT_AGENT_LABEL}
          </DropdownMenuItem>
          {agentItems.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              {agentItems}
            </>
          ) : null}
        </>
      ) : (
        <>
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            Direct API
          </DropdownMenuLabel>
          <DropdownMenuItem
            data-testid="chat-option-openai-compatible"
            onSelect={() =>
              onSelect({
                namedAgentId: null,
                provider: OPENAI_COMPATIBLE_PROVIDER,
              })
            }
          >
            {PROVIDER_LABELS[OPENAI_COMPATIBLE_PROVIDER]}
          </DropdownMenuItem>

          {agentItems.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                Named Agents
              </DropdownMenuLabel>
              {agentItems}
            </>
          ) : null}

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            Persistent CLI
          </DropdownMenuLabel>
          {PERSISTENT_CHAT_PROVIDER_OPTIONS.map((provider) => (
            <DropdownMenuItem
              key={provider}
              data-testid={`chat-option-provider-${provider}`}
              onSelect={() => onSelect({ namedAgentId: null, provider })}
            >
              {PROVIDER_LABELS[provider]}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            CLI Providers
          </DropdownMenuLabel>
          {PROVIDER_OPTIONS.map((provider) => (
            <DropdownMenuItem
              key={provider}
              data-testid={`chat-option-provider-${provider}`}
              onSelect={() => onSelect({ namedAgentId: null, provider })}
            >
              {`${PROVIDER_LABELS[provider]} (CLI)`}
            </DropdownMenuItem>
          ))}
        </>
      )}
    </SelectPill>
  );
}
