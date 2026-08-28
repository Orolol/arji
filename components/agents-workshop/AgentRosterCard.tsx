"use client";

import {
  AvatarSquare,
  BreathingDot,
  Mono,
  SurfaceCard,
} from "@/components/piscine";
import type { AgentDayStats, NamedAgent } from "@/hooks/useAgentConfig";
import { formatReliabilityPercent } from "@/lib/agent-config/dispatch-reliability-constants";
import { formatCostUsd } from "@/lib/utils/format-usage";
import { cn } from "@/lib/utils";

import { agentInitials, agentTone } from "./agent-initials";

const EM_DASH = "—";

/**
 * One agent in the roster.
 *
 * THE POINT OF THE REDESIGN: an agent's numbers live on its card. You pick an
 * agent for what it does, not for its name — so today's runs, clean rate and
 * cost sit under the name rather than in a separate Stats tab.
 *
 * The card is a real `<button>` inside the `SurfaceCard`, which keeps the
 * roster keyboard-walkable without forking the primitive: the card owns the
 * fill, radius and the 2px selection border (reserved at rest, so selecting
 * never reflows the column), the button owns the hit area and the focus ring.
 *
 * The provider is printed as its KEY (`claude-code`, `codex`), not its label —
 * that is what the frame writes and what an error message will name.
 */
export interface AgentRosterCardProps {
  agent: NamedAgent;
  selected: boolean;
  dirty: boolean;
  stats?: AgentDayStats;
  statsLoading: boolean;
  onSelect: () => void;
}

export function AgentRosterCard({
  agent,
  selected,
  dirty,
  stats,
  statsLoading,
  onSelect,
}: AgentRosterCardProps) {
  const pending = statsLoading && !stats;
  const live = stats?.liveSessions ?? 0;

  const runs = pending ? EM_DASH : String(stats?.runsToday ?? 0);
  const clean = pending
    ? EM_DASH
    : formatReliabilityPercent(stats?.cleanRate ?? null);
  const cost = pending ? EM_DASH : (formatCostUsd(stats?.costTodayUsd) ?? EM_DASH);

  return (
    <SurfaceCard
      radius={12}
      selected={selected}
      className={cn("rounded-[14px]", !selected && "hover:border-border-strong")}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={agent.name}
        onClick={onSelect}
        className={cn(
          "flex w-full flex-col gap-2 rounded-[13px] px-4 py-[14px] text-left",
          "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        )}
      >
        <div className="flex items-center gap-[9px]">
          <AvatarSquare
            label={agentInitials(agent.name)}
            tone={agentTone(agent.id)}
            size={34}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-sans text-[14.5px] font-semibold text-foreground">
              {agent.name}
              {dirty ? (
                <span
                  aria-hidden="true"
                  title="unsaved changes"
                  className="ml-1.5 inline-block size-1 rounded-full bg-action align-middle"
                />
              ) : null}
            </span>
            <Mono size={10.5} tone="muted" clamp={1}>
              {`${agent.provider} · ${agent.model || "CLI default"}`}
            </Mono>
          </span>
          {/* No dot at all when nothing runs — never a grey placeholder here. */}
          {live > 0 ? (
            <span
              title={`${live} session${live === 1 ? "" : "s"} live`}
              className="flex shrink-0 items-center"
            >
              <BreathingDot size={7} tone="live" />
            </span>
          ) : null}
        </div>

        {/* The 12px gap separates the figures; the frame draws no middots. */}
        <div className="flex gap-3 font-mono text-[10.5px] tabular-nums text-muted-foreground">
          <span>
            <Mono size={10.5} weight={700} tone="live-deep">
              {runs}
            </Mono>{" "}
            runs today
          </span>
          <span>
            <Mono size={10.5} weight={700} tone="ink">
              {clean}
            </Mono>{" "}
            clean
          </span>
          <span>
            <Mono size={10.5} weight={700} tone="ink">
              {cost}
            </Mono>
          </span>
        </div>
      </button>
    </SurfaceCard>
  );
}
