"use client";

import { useTranslations } from "next-intl";
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
import type { TranslationKey } from "@/lib/i18n/catalogue";
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
/**
 * The three availability sentences and the three screen-reader suffixes, as
 * catalogue KEY REFERENCES: the caller resolves the key with the
 * namespace-less translator and passes the CLI's own name as `{cli}`
 * (`lib/i18n/catalogue.ts`, pattern 3). Returning the KEY rather than the
 * rendered string is what keeps this pair callable from a second component
 * without threading a translator through it.
 */
const AVAILABILITY_KEYS: Record<
  "loading" | "ready" | "missing",
  { hintKey: TranslationKey; srKey: TranslationKey }
> = {
  loading: {
    hintKey: "AgentsWorkshop.cli.hintChecking",
    srKey: "AgentsWorkshop.cli.srChecking",
  },
  ready: {
    hintKey: "AgentsWorkshop.cli.hintReady",
    srKey: "AgentsWorkshop.cli.srReady",
  },
  missing: {
    hintKey: "AgentsWorkshop.cli.hintMissing",
    srKey: "AgentsWorkshop.cli.srMissing",
  },
};

function availabilityState(
  available: boolean,
  loading: boolean,
): "loading" | "ready" | "missing" {
  if (loading) return "loading";
  return available ? "ready" : "missing";
}

export function providerAvailabilityHintKey(
  available: boolean,
  loading: boolean,
): TranslationKey {
  return AVAILABILITY_KEYS[availabilityState(available, loading)].hintKey;
}

function availabilitySrKey(available: boolean, loading: boolean): TranslationKey {
  return AVAILABILITY_KEYS[availabilityState(available, loading)].srKey;
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
  const t = useTranslations();
  const ready = !!availability[value];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          title={t(providerAvailabilityHintKey(ready, availabilityLoading), {
            cli: PROVIDER_LABELS[value],
          })}
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
                  {t(availabilitySrKey(providerReady, availabilityLoading))}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
