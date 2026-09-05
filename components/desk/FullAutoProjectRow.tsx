"use client";

import * as React from "react";

import { CheckMark, Mono, SelectPill } from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import { cn } from "@/lib/utils";

/**
 * One project in the Full Auto popover: the on/off box, and the two
 * per-project agent overrides.
 *
 * WHY THE OVERRIDES LIVE HERE. `/settings` writes the BARE
 * `auto_mode_build_agent` / `auto_mode_review_agent` keys — the workspace
 * default. The suffixed `:<projectId>` form is a different setting, and
 * `resolveAutoModeConfig` reads it first. Putting the two in one popover row
 * would blur that, so this row only ever writes the suffixed pair, through the
 * project's own auto-mode route.
 *
 * The pills show the EFFECTIVE agent, which is what
 * `GET /api/projects/:id/auto-mode` resolves (project → workspace → built-in).
 * That is the honest answer to "who will run this project", and picking
 * "Default" clears the override so the chain resolves again.
 *
 * The enable box is untouched by all of this: the PUT route keys off
 * `"buildAgent" in payload`, so a body carrying only an agent leaves the
 * enabled flag exactly where it was, and vice versa.
 */

export interface FullAutoProjectRowProps {
  project: { id: string; name: string; autoModeEnabled: boolean; activeAgents: number };
  onToggle: (projectId: string, enabled: boolean) => void | Promise<void>;
  /** Persist one override. Omit to render the row without the pills. */
  onSetAgent?: (
    projectId: string,
    role: "buildAgent" | "reviewAgent",
    namedAgentId: string | null,
  ) => void | Promise<void>;
  /** Effective agents, as resolved by the auto-mode route. */
  agents?: { buildAgent: string | null; reviewAgent: string | null };
}

export function FullAutoProjectRow({
  project,
  onToggle,
  onSetAgent,
  agents,
}: FullAutoProjectRowProps) {
  const { agents: namedAgents } = useNamedAgentsList();

  const labelFor = (id: string | null) =>
    (id ? namedAgents.find((agent) => agent.id === id)?.name : null) ?? "Default";

  return (
    <div className="flex flex-col gap-1" data-testid={`full-auto-row-${project.id}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={project.autoModeEnabled}
        onClick={() => void onToggle(project.id, !project.autoModeEnabled)}
        className={cn(
          "flex w-full items-center gap-2 rounded-[10px] px-2 py-[6px] text-left",
          "outline-none hover:bg-muted",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        <CheckMark checked={project.autoModeEnabled} />
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-foreground">
          {project.name}
        </span>
        <Mono size={10.5} tone="muted">
          {project.activeAgents > 0 ? `${project.activeAgents} live` : "—"}
        </Mono>
      </button>

      {onSetAgent && project.autoModeEnabled ? (
        <div className="flex items-center gap-1.5 pb-1 pl-[26px]">
          <SelectPill
            label={labelFor(agents?.buildAgent ?? null)}
            tone="ink"
            fill="transparent"
            className="h-[26px] px-2 text-[11.5px]"
          >
            <DropdownMenuItem onSelect={() => void onSetAgent(project.id, "buildAgent", null)}>
              Default
            </DropdownMenuItem>
            {namedAgents.map((agent) => (
              <DropdownMenuItem
                key={agent.id}
                onSelect={() => void onSetAgent(project.id, "buildAgent", agent.id)}
              >
                {agent.name}
              </DropdownMenuItem>
            ))}
          </SelectPill>

          <SelectPill
            label={labelFor(agents?.reviewAgent ?? null)}
            tone="ink"
            fill="transparent"
            className="h-[26px] px-2 text-[11.5px]"
          >
            <DropdownMenuItem onSelect={() => void onSetAgent(project.id, "reviewAgent", null)}>
              Default
            </DropdownMenuItem>
            {namedAgents.map((agent) => (
              <DropdownMenuItem
                key={agent.id}
                onSelect={() => void onSetAgent(project.id, "reviewAgent", agent.id)}
              >
                {agent.name}
              </DropdownMenuItem>
            ))}
          </SelectPill>
        </div>
      ) : null}
    </div>
  );
}
