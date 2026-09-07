"use client";

import { useTranslations } from "next-intl";

import {
  AvatarSquare,
  BreathingDot,
  Mono,
  SurfaceCard,
} from "@/components/piscine";
import type {
  AgentDayStats,
  AgentRosterStatsStatus,
  NamedAgent,
} from "@/hooks/useAgentConfig";
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
  /**
   * The AGGREGATE's state, not this agent's. `ready` with no `stats` is a
   * truthful zero (the query returns no row for an agent that has not run
   * today); anything else is "we do not know", and prints em-dashes.
   */
  statsStatus: AgentRosterStatsStatus;
  onSelect: () => void;
}

export function AgentRosterCard({
  agent,
  selected,
  dirty,
  stats,
  statsStatus,
  onSelect,
}: AgentRosterCardProps) {
  const t = useTranslations("AgentsWorkshop");
  // THE EM-DASH-NOT-ZERO INVARIANT. `stats?.runsToday ?? 0` alone cannot hold
  // it: the fallback fires both when the agent genuinely ran nothing and when
  // the aggregate never arrived, and printing "0 runs today" for a request
  // that failed is a figure the server never gave us.
  const known = statsStatus === "ready";
  const live = known ? (stats?.liveSessions ?? 0) : 0;

  const runs = known ? String(stats?.runsToday ?? 0) : EM_DASH;
  const clean = known
    ? formatReliabilityPercent(stats?.cleanRate ?? null)
    : EM_DASH;
  const cost = known ? (formatCostUsd(stats?.costTodayUsd) ?? EM_DASH) : EM_DASH;

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
          "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        )}
      >
        <div className="flex items-center gap-[9px]">
          <AvatarSquare
            label={agentInitials(agent.name)}
            tone={agentTone(agent.id)}
            size={34}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-[5px]">
              <span className="truncate font-sans text-[14.5px] font-semibold text-foreground">
                {agent.name}
              </span>
              {/* Both badges are WORDS, not colours. "Unsaved" used to be a
                  --action dot, which spent the screen's filled-button green on
                  a boolean and put a third loud colour in a two-colour frame.
                  These are states, and state is carried by the word. */}
              {agent.isDefault ? (
                <Mono
                  size={9.5}
                  tone="ink"
                  uppercase
                  tracking={0.06}
                  className="shrink-0"
                >
                  {t("composite.defaultBadge")}
                </Mono>
              ) : null}
              {dirty ? (
                <Mono
                  size={9.5}
                  tone="muted"
                  uppercase
                  tracking={0.06}
                  className="shrink-0"
                >
                  {t("roster.unsaved")}
                </Mono>
              ) : null}
            </span>
            <Mono size={10.5} tone="muted" clamp={1}>
              {/* A composite has no CLI and no model of its own, so it prints
                  its LADDER instead — the members in order, which is the only
                  thing that predicts what it will run. */}
              {agent.kind === "composite"
                ? (agent.members ?? []).length > 0
                  ? t("composite.ladder", {
                      ladder: (agent.members ?? [])
                        .map((member) => member.name)
                        .join(" → "),
                    })
                  : t("composite.ladderEmpty")
                : t("roster.providerLine", {
                    provider: agent.provider,
                    model: agent.model || t("common.cliDefault"),
                  })}
            </Mono>
          </span>
          {/* No dot at all when nothing runs — never a grey placeholder here,
              and never a stale one: an unavailable aggregate reports 0 live
              rather than leaving the previous poll's dot breathing. */}
          {live > 0 ? (
            <span
              title={t("roster.liveSessions", { count: live })}
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
            {t("roster.runsToday")}
          </span>
          <span>
            <Mono size={10.5} weight={700} tone="ink">
              {clean}
            </Mono>{" "}
            {t("roster.clean")}
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
