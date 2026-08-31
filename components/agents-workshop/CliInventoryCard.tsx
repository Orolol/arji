"use client";

import { BreathingDot, FieldKicker } from "@/components/piscine";
import {
  PROVIDER_OPTIONS,
  type AgentProvider,
} from "@/lib/agent-config/constants";

/**
 * "CLIS ON THIS MACHINE" — the sunken card pinned to the bottom of the roster.
 *
 * The dot here is deliberately STATIC (`animate={false}`): it reports whether
 * a CLI is installed, which is not a liveness fact. The breathing dot belongs
 * to running sessions only.
 *
 * The row prints the provider KEY rather than its label, so it matches what an
 * error message will name. The frame's `omp` is shorthand; `oh-my-pi` is the
 * value the codebase actually stores.
 *
 * Availability is fetched once on mount by `useProvidersAvailable` — it shells
 * out to each CLI, so polling it would spawn four child processes an interval.
 */
export interface CliInventoryCardProps {
  availability: Record<AgentProvider, boolean>;
  loading: boolean;
}

export function CliInventoryCard({
  availability,
  loading,
}: CliInventoryCardProps) {
  return (
    <div className="mt-auto flex shrink-0 flex-col gap-[6px] rounded-[14px] bg-muted px-4 py-[13px]">
      <FieldKicker stratum="card" size={10}>
        CLIS ON THIS MACHINE
      </FieldKicker>
      {PROVIDER_OPTIONS.map((provider) => {
        const ready = !loading && !!availability[provider];
        return (
          <span
            key={provider}
            className={`flex items-center gap-[7px] font-sans text-[12px] ${
              ready ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            <BreathingDot
              size={6}
              animate={false}
              tone={ready ? "live" : "idle"}
            />
            {`${provider} · ${
              loading ? "checking…" : ready ? "ready" : "not installed"
            }`}
          </span>
        );
      })}
    </div>
  );
}
