"use client";

import { useState } from "react";

import {
  BandHeader,
  FieldKicker,
  Mono,
  QuietLink,
  SelectPill,
  StrataBand,
  SurfaceCard,
} from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type {
  NamedAgent,
  ResolvedAgentAssignment,
} from "@/hooks/useAgentConfig";
import {
  AGENT_TYPE_LABELS,
  PROVIDER_LABELS,
  type AgentType,
} from "@/lib/agent-config/constants";

import { sourceLabel } from "./agent-initials";

/**
 * WHERE HE WORKS — the turquoise band, and the ONE band on this screen that
 * grows into the leftover column height.
 *
 * The redesign's third change: assignments come back into the agent's own
 * sheet. Before, they lived in a separate tab nobody knew existed.
 *
 * FIVE OF TWENTY-ONE. The grid is a curated view — the five roles a user
 * actually reassigns — so the remaining sixteen must stay reachable: the
 * header carries a link to the full table. Each tile puts the REAL
 * `AGENT_TYPE_LABELS` value in its `title`, so the friendly name never hides
 * which role is being written.
 */
const TILES: { kicker: string; agentType: AgentType }[] = [
  { kicker: "BUILD", agentType: "build" },
  // Story-scoped code work — also what the pipeline's fix stage dispatches at
  // story scope, which is what makes "bug fix" the honest user-facing name.
  { kicker: "BUG FIX", agentType: "ticket_build" },
  { kicker: "REVIEW", agentType: "review_code" },
  { kicker: "MERGE FIX", agentType: "merge" },
  // spec_generation is reachable on /agents/assignments.
  { kicker: "CHAT & SPEC", agentType: "chat" },
];

export interface WhereHeWorksBandProps {
  assignments: ResolvedAgentAssignment[];
  namedAgents: NamedAgent[];
  selectedAgentId: string | null;
  scope: "global" | "project";
  onAssign: (
    agentType: AgentType,
    namedAgentId: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function WhereHeWorksBand({
  assignments,
  namedAgents,
  selectedAgentId,
  scope,
  onAssign,
}: WhereHeWorksBandProps) {
  const [savingRole, setSavingRole] = useState<AgentType | null>(null);
  // A per-role map, never one shared string: one failing assignment must not
  // blank the message of another.
  const [errors, setErrors] = useState<Partial<Record<AgentType, string>>>({});

  const byRole = new Map(
    assignments.map((assignment) => [assignment.agentType, assignment]),
  );

  async function updateAssignment(
    agentType: AgentType,
    namedAgentId: string | null,
  ) {
    setSavingRole(agentType);
    setErrors((current) => ({ ...current, [agentType]: undefined }));
    try {
      const result = await onAssign(agentType, namedAgentId);
      if (!result.ok) {
        setErrors((current) => ({
          ...current,
          [agentType]: result.error || "Could not update this assignment.",
        }));
      }
    } catch {
      setErrors((current) => ({
        ...current,
        [agentType]: "Could not update this assignment. Try again.",
      }));
    } finally {
      setSavingRole(null);
    }
  }

  const clearLabel =
    scope === "project"
      ? "Use the all-projects assignment"
      : "Use the Arij default";

  return (
    <StrataBand stratum="live" density="full" gap={10} grow>
      <BandHeader
        stratum="live"
        labelSize={12}
        label="Where he works"
        meta="l'agent par défaut de chaque type de tâche — cet agent est surligné"
        right={
          <QuietLink href="/agents/assignments" tone="live" size={12}>
            tous les rôles →
          </QuietLink>
        }
      />

      <div className="min-h-0 overflow-y-auto">
        <div className="grid grid-cols-5 gap-[10px]">
          {TILES.map(({ kicker, agentType }) => {
            const assignment = byRole.get(agentType);
            const owned =
              !!selectedAgentId && assignment?.namedAgentId === selectedAgentId;
            const label =
              assignment?.namedAgent?.name ?? sourceLabel("builtin");
            const error = errors[agentType];

            return (
              // The wrapper carries the title: `SurfaceCard` takes no
              // pass-through DOM props, and the real role name must stay
              // discoverable behind the friendly kicker.
              <div key={agentType} title={AGENT_TYPE_LABELS[agentType]}>
              <SurfaceCard
                radius={11}
                selected={owned}
                className="flex h-full flex-col gap-[6px] px-3 py-[11px]"
              >
                <FieldKicker stratum="live" size={10}>
                  {kicker}
                </FieldKicker>

                {owned ? (
                  <span className="truncate font-sans text-[13px] font-semibold text-foreground">
                    {label}
                  </span>
                ) : (
                  <SelectPill
                    tone="ink"
                    fill="transparent"
                    disabled={
                      namedAgents.length === 0 || savingRole === agentType
                    }
                    label={label}
                    className="h-auto px-0"
                  >
                    <DropdownMenuItem
                      onSelect={() => updateAssignment(agentType, null)}
                    >
                      {clearLabel}
                    </DropdownMenuItem>
                    {namedAgents.map((agent) => (
                      <DropdownMenuItem
                        key={agent.id}
                        onSelect={() => updateAssignment(agentType, agent.id)}
                      >
                        <span className="flex flex-col items-start">
                          <span>{agent.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {PROVIDER_LABELS[agent.provider]}
                            {agent.model
                              ? ` · ${agent.model}`
                              : " · CLI default model"}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </SelectPill>
                )}

                {/* The provenance line, but never a stutter: with no named
                    agent, line 2 already reads "Arij default" and repeating it
                    underneath says nothing. Collapse instead. */}
                {owned ? (
                  <Mono size={10} tone="muted" clamp={1}>
                    this agent
                  </Mono>
                ) : assignment?.namedAgent ? (
                  <Mono size={10} tone="muted" clamp={1}>
                    {sourceLabel(assignment.source)}
                  </Mono>
                ) : null}

                {error ? (
                  <p
                    role="alert"
                    className="font-sans text-[11px] text-destructive"
                  >
                    {error}
                  </p>
                ) : null}
              </SurfaceCard>
              </div>
            );
          })}
        </div>

        {namedAgents.length === 0 ? (
          <p className="pt-[10px] font-sans text-[11.5px] text-strata-live-mid">
            Create an agent first — then you can assign it to a task.
          </p>
        ) : null}
      </div>

      <span className="font-sans text-[11.5px] text-strata-live-mid">
        Full Auto et Night runs suivent ces défauts ; un dispatch manuel peut
        toujours choisir un autre agent.
      </span>
    </StrataBand>
  );
}
