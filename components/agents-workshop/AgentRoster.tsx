"use client";

import type { AgentDayStats, NamedAgent } from "@/hooks/useAgentConfig";
import type { AgentProvider } from "@/lib/agent-config/constants";

import { AddAgentCard } from "./AddAgentCard";
import { AgentRosterCard } from "./AgentRosterCard";
import { CliInventoryCard } from "./CliInventoryCard";

/**
 * The fixed 330px left column: the agent cards, the dashed create card, then
 * the CLI inventory pinned to the bottom by `margin-top: auto`.
 *
 * Only the CARD LIST scrolls. With four agents nothing does, matching the
 * frame; with thirty the inventory stays where it is instead of being pushed
 * off the bottom of the column.
 */
export interface AgentRosterProps {
  agents: NamedAgent[];
  selectedId: string | null;
  dirtyIds: Set<string>;
  stats: Record<string, AgentDayStats>;
  statsLoading: boolean;
  availability: Record<AgentProvider, boolean>;
  availabilityLoading: boolean;
  onSelect: (agentId: string) => void;
  onCreate: (input: {
    name: string;
    provider: AgentProvider;
  }) => Promise<{ ok: boolean; error?: string }>;
}

export function AgentRoster({
  agents,
  selectedId,
  dirtyIds,
  stats,
  statsLoading,
  availability,
  availabilityLoading,
  onSelect,
  onCreate,
}: AgentRosterProps) {
  return (
    <div
      className="flex w-[330px] shrink-0 flex-col gap-[10px]"
      data-testid="agent-roster"
    >
      <div className="-mr-1 flex min-h-0 flex-1 flex-col gap-[10px] overflow-y-auto pr-1">
        {agents.map((agent) => (
          <AgentRosterCard
            key={agent.id}
            agent={agent}
            selected={agent.id === selectedId}
            dirty={dirtyIds.has(agent.id)}
            stats={stats[agent.id]}
            statsLoading={statsLoading}
            onSelect={() => onSelect(agent.id)}
          />
        ))}
        <AddAgentCard
          availability={availability}
          availabilityLoading={availabilityLoading}
          onCreate={onCreate}
        />
      </div>
      <CliInventoryCard
        availability={availability}
        loading={availabilityLoading}
      />
    </div>
  );
}
