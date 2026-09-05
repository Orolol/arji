"use client";

import { ChevronDown } from "lucide-react";

import { BreathingDot } from "@/components/piscine";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PROVIDER_LABELS,
  PROVIDER_OPTIONS,
  type AgentProvider,
} from "@/lib/agent-config/constants";
import { cn } from "@/lib/utils";

/**
 * The CLI picker: the identity card's CLI FieldBox and the create card's CLI
 * field are the same control.
 *
 * The frame draws a literal "▾"; the system's glyph language is lucide, so we
 * ship `chevron-down`. The leading dot is the STATIC readiness dot
 * (`animate={false}`) — it says "installed", not "running", and motion would
 * contradict that.
 *
 * The three availability sentences are carried verbatim from the sheet this
 * page replaces. The third is the only place the product tells a user why a
 * configured agent will never run, so it must survive the redesign.
 */
export function providerAvailabilityHint(
  provider: AgentProvider,
  available: boolean,
  loading: boolean,
): string {
  if (loading) {
    return `Checking whether ${PROVIDER_LABELS[provider]} is ready on this machine.`;
  }
  return available
    ? `${PROVIDER_LABELS[provider]} is ready to use on this machine.`
    : `${PROVIDER_LABELS[provider]} was not detected. Install or sign in to the CLI before running this agent.`;
}

function availabilitySrText(available: boolean, loading: boolean): string {
  if (loading) return " — checking availability";
  return available ? " — ready to use" : " — not detected";
}

export interface CliDropdownProps {
  id?: string;
  value: AgentProvider;
  onChange: (value: AgentProvider) => void;
  availability: Record<AgentProvider, boolean>;
  availabilityLoading: boolean;
  disabled?: boolean;
  className?: string;
  "aria-describedby"?: string;
}

export function CliDropdown({
  id,
  value,
  onChange,
  availability,
  availabilityLoading,
  disabled,
  className,
  ...aria
}: CliDropdownProps) {
  const ready = !!availability[value];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          title={providerAvailabilityHint(value, ready, availabilityLoading)}
          className={cn(
            "flex h-[34px] w-full items-center gap-[7px] rounded-[10px]",
            "border-[1.5px] border-border bg-transparent px-3",
            "font-sans text-[13px] font-normal text-foreground",
            "outline-none focus-visible:border-border-strong",
            "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
            "disabled:pointer-events-none disabled:opacity-50",
            className,
          )}
          {...aria}
        >
          <BreathingDot
            size={6}
            animate={false}
            tone={!availabilityLoading && ready ? "live" : "idle"}
          />
          <span className="min-w-0 truncate">{PROVIDER_LABELS[value]}</span>
          <ChevronDown
            size={12}
            aria-hidden="true"
            className="ml-auto shrink-0 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="rounded-[12px] border-[1.5px] border-border bg-card shadow-none"
      >
        {PROVIDER_OPTIONS.map((provider) => {
          const providerReady = !!availability[provider];
          return (
            <DropdownMenuItem
              key={provider}
              onSelect={() => onChange(provider)}
            >
              <span className="flex items-center gap-1.5">
                <BreathingDot
                  size={6}
                  animate={false}
                  tone={
                    !availabilityLoading && providerReady ? "live" : "idle"
                  }
                />
                {PROVIDER_LABELS[provider]}
                <span className="sr-only">
                  {availabilitySrText(providerReady, availabilityLoading)}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
