"use client";

/**
 * AGENTS on the linden ground (frame 6a, lines 309-317).
 *
 * Three outline pills and zero filled ones — correct, and deliberate: this
 * screen's two-loud-colour budget is already spent on turquoise (liveness)
 * and coral (the conversation label and the delete link).
 *
 * GRADE is the third. Acceptance grading is observational — it never moves the
 * ticket, it writes a report the USER STORIES band stamps — so it is a peer of
 * Review and Re-build, not a fourth stratum's worth of UI. Its dispatch route
 * has always existed; the redesign simply left it with no button.
 *
 * The frame renders a literal `▾` in the select pill; `SelectPill` ships a
 * lucide chevron instead. That is the system's glyph language; no text caret
 * is added on top of it.
 *
 * NO NAMED AGENTS CONFIGURED ⇒ the pill reads `—` with a disabled menu and
 * both actions disabled. The band is never hidden: "you have no agents" is
 * information.
 */

import { ClipboardCheck, Hammer, Search } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  BandHeader,
  PillButton,
  SelectPill,
  StrataBand,
} from "@/components/piscine";

export interface AgentsBandAgent {
  id: string;
  name: string;
}

export interface AgentsBandProps {
  agents: AgentsBandAgent[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onReview: () => void;
  onRebuild: () => void;
  /** Dispatch acceptance grading. Omit to drop the pill entirely. */
  onGrade?: () => void;
  /** True while a dispatch is in flight or a session already owns the ticket. */
  locked: boolean;
}

export function AgentsBand({
  agents,
  selectedAgentId,
  onSelectAgent,
  onReview,
  onRebuild,
  onGrade,
  locked,
}: AgentsBandProps) {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  // Em-dash, never a fabricated default name.
  const label = selected?.name ?? (agents.length > 0 ? "Default agent" : "—");

  return (
    <StrataBand stratum="feed" density="rail" gap={8} className="shrink-0">
      <BandHeader
        label="Agents"
        stratum="feed"
        standalone
        className="gap-[10px]"
      />

      <span data-testid="ticket-agent-select" className="self-start">
        <SelectPill
          label={label}
          tone="ink"
          fill="card"
          disabled={agents.length === 0}
        >
          <DropdownMenuItem onSelect={() => onSelectAgent(null)}>
            Default agent
          </DropdownMenuItem>
          {agents.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onSelect={() => onSelectAgent(agent.id)}
            >
              {agent.name}
            </DropdownMenuItem>
          ))}
        </SelectPill>
      </span>

      <div className="flex flex-wrap gap-2">
        <PillButton
          variant="outline"
          outlineTone="action"
          size="sm"
          icon={Search}
          onClick={onReview}
          disabled={locked}
          data-testid="ticket-review-now"
        >
          Review now
        </PillButton>
        <PillButton
          variant="outline"
          outlineTone="action"
          size="sm"
          icon={Hammer}
          onClick={onRebuild}
          disabled={locked}
          data-testid="ticket-rebuild"
        >
          Re-build
        </PillButton>
        {onGrade ? (
          <PillButton
            variant="outline"
            outlineTone="action"
            size="sm"
            icon={ClipboardCheck}
            onClick={onGrade}
            disabled={locked}
            data-testid="ticket-grade"
          >
            Grade
          </PillButton>
        ) : null}
      </div>
    </StrataBand>
  );
}
