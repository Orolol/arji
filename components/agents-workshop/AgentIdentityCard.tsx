"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";

import { FieldKicker, SurfaceCard } from "@/components/piscine";
import {
  PROVIDER_LABELS,
  type AgentProvider,
} from "@/lib/agent-config/constants";

import { CliDropdown, providerAvailabilityHintKey } from "./CliDropdown";
import { FieldBoxInput } from "./FieldBox";

/**
 * The identity row: NAME · CLI · MODEL.
 *
 * Not a `StrataBand` — the frame gives this row the plain white card ground
 * with no label line, so it is a `SurfaceCard` at band radius.
 *
 * THERE IS NO RETRY CONTROL HERE ANY MORE. A simple agent is retried as
 * itself, full stop; fallback to a different agent is what a COMPOSITE is
 * for, and it is configured on the composite rather than as an edge hanging
 * off each simple agent. The old "retry escalation" segment offered a choice
 * that the default attempt cap of 2 meant the pipeline never reached.
 */
export interface AgentIdentityCardProps {
  name: string;
  provider: AgentProvider;
  model: string;
  availability: Record<AgentProvider, boolean>;
  availabilityLoading: boolean;
  disabled: boolean;
  onNameChange: (value: string) => void;
  onProviderChange: (value: AgentProvider) => void;
  onModelChange: (value: string) => void;
}

export function AgentIdentityCard({
  name,
  provider,
  model,
  availability,
  availabilityLoading,
  disabled,
  onNameChange,
  onProviderChange,
  onModelChange,
}: AgentIdentityCardProps) {
  const uid = useId();
  const t = useTranslations("AgentsWorkshop");
  // Namespace-less, for the availability hint's KEY REFERENCE.
  const tKey = useTranslations();

  return (
    <SurfaceCard className="shrink-0 rounded-[14px] px-[18px] py-[14px]">
      {/* Wraps: the three fields need ~700px side by side, so below `lg` they
          reflow onto as many lines as the viewport affords instead of
          pushing the model field past the right edge. */}
      <div className="flex flex-wrap items-end gap-x-[22px] gap-y-[14px]">
        <div className="flex min-w-[180px] flex-1 flex-col gap-[5px] lg:w-[280px] lg:flex-none">
          <FieldKicker stratum="card" size={10}>
            {t("identity.nameKicker")}
          </FieldKicker>
          <FieldBoxInput
            id={`${uid}-name`}
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            aria-label={t("identity.nameAria")}
            placeholder={t("common.agentNamePlaceholder")}
            disabled={disabled}
          />
        </div>

        <div className="flex min-w-[150px] flex-1 flex-col gap-[5px] lg:w-[200px] lg:flex-none">
          <FieldKicker stratum="card" size={10}>
            {t("identity.cliKicker")}
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
            {tKey(
              providerAvailabilityHintKey(
                !!availability[provider],
                availabilityLoading,
              ),
              { cli: PROVIDER_LABELS[provider] },
            )}
          </span>
        </div>

        <div className="flex min-w-[150px] flex-1 flex-col gap-[5px] lg:w-[220px] lg:flex-none">
          <FieldKicker stratum="card" size={10}>
            {t("identity.modelKicker")}
          </FieldKicker>
          <FieldBoxInput
            mono
            id={`${uid}-model`}
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            aria-label={t("identity.modelAria")}
            placeholder={t("common.cliDefault")}
            disabled={disabled}
          />
        </div>
      </div>
    </SurfaceCard>
  );
}
