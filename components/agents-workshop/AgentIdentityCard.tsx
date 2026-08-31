"use client";

import { useId, useState } from "react";

import {
  FieldKicker,
  SegmentedControl,
  SelectPill,
  SurfaceCard,
  type SegmentedControlOption,
} from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { NamedAgent } from "@/hooks/useAgentConfig";
import type { AgentProvider } from "@/lib/agent-config/constants";

import { CliDropdown, providerAvailabilityHint } from "./CliDropdown";
import { FieldBoxInput } from "./FieldBox";

/**
 * The identity row: NAME · CLI · MODEL · RETRY ESCALATION.
 *
 * Not a `StrataBand` — the frame gives this row the plain white card ground
 * with no label line, so it is a `SurfaceCard` at band radius.
 *
 * RETRY ESCALATION HAS ONLY TWO STORED STATES. The ladder is deterministic:
 * attempt 1 as configured, attempt 2 resumes, attempt 3 uses `escalatesTo`
 * when one is set, and the provider escalation ALWAYS happens (attempt 3
 * without a stronger model, attempt 4 with one). "Other CLI" is therefore not
 * a choice anyone can make — it is rendered disabled with a hint rather than
 * hidden, because hiding it would suggest it does not happen.
 */
type RetryMode = "none" | "stronger" | "other-cli";

export interface AgentIdentityCardProps {
  agentId: string;
  agents: NamedAgent[];
  name: string;
  provider: AgentProvider;
  model: string;
  escalatesTo: string | null;
  availability: Record<AgentProvider, boolean>;
  availabilityLoading: boolean;
  disabled: boolean;
  onNameChange: (value: string) => void;
  onProviderChange: (value: AgentProvider) => void;
  onModelChange: (value: string) => void;
  onEscalatesToChange: (value: string | null) => void;
}

export function AgentIdentityCard({
  agentId,
  agents,
  name,
  provider,
  model,
  escalatesTo,
  availability,
  availabilityLoading,
  disabled,
  onNameChange,
  onProviderChange,
  onModelChange,
  onEscalatesToChange,
}: AgentIdentityCardProps) {
  const uid = useId();
  // "Stronger model" is chosen before a target is picked; the segment must
  // stay lit while the menu is open. Remounted per agent by the caller's key.
  const [strongerPending, setStrongerPending] = useState(false);

  // The candidate filter is the EDITED provider, not the stored one — the
  // server rejects a cross-provider edge outright.
  const candidates = agents.filter(
    (candidate) => candidate.id !== agentId && candidate.provider === provider,
  );

  const retryMode: RetryMode =
    escalatesTo || strongerPending ? "stronger" : "none";

  const retryOptions: SegmentedControlOption<RetryMode>[] = [
    { value: "none", label: "None", flex: 1 },
    {
      value: "stronger",
      label: "Stronger model",
      flex: 1.4,
      disabled: candidates.length === 0,
      hint:
        candidates.length === 0
          ? "aucun autre agent n'utilise ce CLI"
          : undefined,
    },
    {
      value: "other-cli",
      label: "Other CLI",
      flex: 1.2,
      disabled: true,
      hint: "toujours tenté en dernier recours — tentative 3 sans modèle plus fort, tentative 4 avec.",
    },
  ];

  const target = candidates.find((candidate) => candidate.id === escalatesTo);

  return (
    <SurfaceCard className="shrink-0 rounded-[14px] px-[18px] py-[14px]">
      {/* Wraps: the four fields need ~800px side by side, so below `lg` they
          reflow onto as many lines as the viewport affords instead of
          pushing the model field past the right edge. */}
      <div className="flex flex-wrap items-end gap-x-[22px] gap-y-[14px]">
        <div className="flex min-w-[180px] flex-1 flex-col gap-[5px] lg:w-[280px] lg:flex-none">
          <FieldKicker stratum="card" size={10}>
            NAME
          </FieldKicker>
          <FieldBoxInput
            id={`${uid}-name`}
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            aria-label="Name"
            placeholder="Agent name"
            disabled={disabled}
          />
        </div>

        <div className="flex min-w-[150px] flex-1 flex-col gap-[5px] lg:w-[200px] lg:flex-none">
          <FieldKicker stratum="card" size={10}>
            CLI
          </FieldKicker>
          <CliDropdown
            id={`${uid}-cli`}
            value={provider}
            onChange={onProviderChange}
            availability={availability}
            availabilityLoading={availabilityLoading}
            disabled={disabled}
            aria-describedby={`${uid}-cli-hint`}
          />
          <span id={`${uid}-cli-hint`} className="sr-only">
            {providerAvailabilityHint(
              provider,
              !!availability[provider],
              availabilityLoading,
            )}
          </span>
        </div>

        <div className="flex min-w-[150px] flex-1 flex-col gap-[5px] lg:w-[220px] lg:flex-none">
          <FieldKicker stratum="card" size={10}>
            MODEL
          </FieldKicker>
          <FieldBoxInput
            mono
            id={`${uid}-model`}
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            aria-label="Model"
            placeholder="CLI default"
            disabled={disabled}
          />
        </div>

        <div className="flex min-w-[240px] flex-1 flex-col gap-[5px]">
          <FieldKicker stratum="card" size={10}>
            RETRY ESCALATION
          </FieldKicker>
          <div className="flex items-center gap-2">
            <SegmentedControl<RetryMode>
              options={retryOptions}
              value={retryMode}
              onChange={(next) => {
                if (disabled) return;
                if (next === "none") {
                  setStrongerPending(false);
                  onEscalatesToChange(null);
                  return;
                }
                if (next === "stronger") setStrongerPending(true);
              }}
              chrome="bordered"
              size="md"
              wrap
              className="min-w-0 flex-1 self-stretch"
            />
            {retryMode === "stronger" && candidates.length > 0 ? (
              <SelectPill
                tone="ink"
                fill="card"
                disabled={disabled}
                label={target ? target.name : "Choose an agent"}
              >
                {candidates.map((candidate) => (
                  <DropdownMenuItem
                    key={candidate.id}
                    onSelect={() => onEscalatesToChange(candidate.id)}
                  >
                    {candidate.name}
                    {candidate.model
                      ? ` — ${candidate.model}`
                      : " — CLI default"}
                  </DropdownMenuItem>
                ))}
              </SelectPill>
            ) : null}
          </div>
        </div>
      </div>
    </SurfaceCard>
  );
}
