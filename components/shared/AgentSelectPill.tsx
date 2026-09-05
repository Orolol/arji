"use client";

import * as React from "react";

import { SelectPill } from "@/components/piscine";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  /**
   * `(string & {})` is not slop: `conversations.provider` is a free-form text
   * column, so a row written before a provider cleanup carries a value this
   * union cannot name (`gemini-cli`, `pi`). The pill is built to render those
   * — `providerLabel` falls back to the raw string — so typing the field as
   * the narrow union would have made every call site assert something false
   * with a cast. The union half survives for autocompletion.
   */
  provider: ChatModeProvider | (string & {}) | null;
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

/**
 * The menu items are radio items, and the group carries the conversation's
 * CURRENT mode — the affordance the project panel had while it was a shadcn
 * `Select` (`aria-selected` plus a check indicator) and lost when the three
 * menus merged onto a `DropdownMenu`. Plain `DropdownMenuItem`s are peers:
 * `role="menuitem"`, no checked state, nothing marking which one is running.
 *
 * Values are namespaced because a named agent id and a provider string share
 * one value space here and must not be able to collide.
 */
const DEFAULT_AGENT_VALUE = "default-agent";
const agentValue = (id: string) => `agent:${id}`;
const providerValue = (provider: string) => `provider:${provider}`;

/**
 * Which item is checked. A conversation on a provider dropped in a cleanup
 * yields a value no item carries, so nothing is checked — correct, since no
 * item represents it.
 */
function checkedValue(selection: AgentSelection): string {
  if (selection.namedAgentId) return agentValue(selection.namedAgentId);
  if (selection.provider) return providerValue(selection.provider);
  return DEFAULT_AGENT_VALUE;
}

export const DEFAULT_AGENT_LABEL = "Default agent";
export const AGENT_SELECT_LOADING_LABEL = "Loading…";

/** Label of a provider, tolerating a legacy value stored before a cleanup. */
function providerLabel(provider: AgentSelection["provider"]): string | null {
  if (!provider) return null;
  return (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;
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
    <DropdownMenuRadioItem
      key={agent.id}
      value={agentValue(agent.id)}
      data-testid={`chat-option-agent-${agent.id}`}
      onSelect={() =>
        onSelect({ namedAgentId: agent.id, provider: agent.provider })
      }
    >
      {agent.name}
    </DropdownMenuRadioItem>
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
      {/* ONE radio group across every group heading, not one per heading: the
          chosen mode is a single choice, and a group per heading would let
          the menu claim several checked items at once. */}
      <DropdownMenuRadioGroup value={checkedValue(selection)}>
      {mode === "dispatch" ? (
        <>
          <DropdownMenuRadioItem
            value={DEFAULT_AGENT_VALUE}
            data-testid="chat-option-default-agent"
            onSelect={() => onSelect({ namedAgentId: null, provider: null })}
          >
            {DEFAULT_AGENT_LABEL}
          </DropdownMenuRadioItem>
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
          <DropdownMenuRadioItem
            value={providerValue(OPENAI_COMPATIBLE_PROVIDER)}
            data-testid="chat-option-openai-compatible"
            onSelect={() =>
              onSelect({
                namedAgentId: null,
                provider: OPENAI_COMPATIBLE_PROVIDER,
              })
            }
          >
            {PROVIDER_LABELS[OPENAI_COMPATIBLE_PROVIDER]}
          </DropdownMenuRadioItem>

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
            <DropdownMenuRadioItem
              key={provider}
              value={providerValue(provider)}
              data-testid={`chat-option-provider-${provider}`}
              onSelect={() => onSelect({ namedAgentId: null, provider })}
            >
              {PROVIDER_LABELS[provider]}
            </DropdownMenuRadioItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            CLI Providers
          </DropdownMenuLabel>
          {PROVIDER_OPTIONS.map((provider) => (
            <DropdownMenuRadioItem
              key={provider}
              value={providerValue(provider)}
              data-testid={`chat-option-provider-${provider}`}
              onSelect={() => onSelect({ namedAgentId: null, provider })}
            >
              {`${PROVIDER_LABELS[provider]} (CLI)`}
            </DropdownMenuRadioItem>
          ))}
        </>
      )}
      </DropdownMenuRadioGroup>
    </SelectPill>
  );
}
