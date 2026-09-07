"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";

import {
  BandHeader,
  CheckMark,
  FieldKicker,
  SegmentedControl,
  SelectPill,
  StrataBand,
  type SegmentedControlOption,
} from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import {
  getProviderOptionDefinitions,
  type NamedAgentCliOptions,
  type ProviderOptionDefinition,
} from "@/lib/providers/options-registry";

import {
  CLI_DEFAULT_VALUE,
  cliOptionControlKind,
  cliOptionKicker,
  cliOptionKickerSuffixKey,
} from "./cli-options";
import { FieldBoxInput } from "./FieldBox";

/**
 * CLI OPTIONS — the pool band.
 *
 * REGISTRY-DRIVEN, AND IT MUST STAY THAT WAY. Keys, labels, hints, accepted
 * values and defaults all come from lib/providers/options-registry.ts, so this
 * component has no per-CLI knowledge and a CLI with no registry entry renders
 * nothing at all — the band then collapses to its label line, which is the
 * system's universal fallback.
 *
 * THE FRAME DRAWS A "Plan" SEGMENT AND WE DO NOT SHIP IT. `plan` was removed
 * from the permission modes after measurement: it refuses mutating tools
 * INCLUDING the Arij MCP tools, so an agent set to it cannot call
 * update_ticket_status and a reviewer set to it filed no findings and
 * persisted no review_verdict, silently degrading every review to the prose
 * fallback. Rendering it because a mock draws it would re-open a fixed bug.
 * The frame's four-segment EFFORT is equally out of date — claude-code
 * declares five levels and all five ship.
 *
 * STORING `undefined` DELETES THE KEY. The server treats "absent" and "equal
 * to the default" as the same state, which is what keeps an unconfigured
 * agent's argv byte-identical to the pre-registry argv. A stored `false`, an
 * empty string or a NaN would all be a configuration the user never made.
 */
export interface CliOptionsBandProps {
  provider: string;
  options: NamedAgentCliOptions;
  onChange: (options: NamedAgentCliOptions) => void;
  disabled: boolean;
}

export function CliOptionsBand({
  provider,
  options,
  onChange,
  disabled,
}: CliOptionsBandProps) {
  const t = useTranslations("AgentsWorkshop");
  // Namespace-less: the registry's labels, hints and choices are KEY
  // REFERENCES in the `ProviderOptions` namespace, not in this band's.
  const tKey = useTranslations();
  const uid = useId();
  const definitions = getProviderOptionDefinitions(provider);

  /** The explanatory clause the frame appends to two of the kickers. */
  const suffixOf = (key: string) => {
    const suffixKey = cliOptionKickerSuffixKey(key);
    return suffixKey ? tKey(suffixKey) : "";
  };

  function setOption(
    key: string,
    value: NamedAgentCliOptions[string] | undefined,
  ) {
    const next = { ...options };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  }

  return (
    <StrataBand stratum="next" density="full" gap={10} className="pb-4">
      <BandHeader
        stratum="next"
        labelSize={12}
        label={t("cliOptions.label")}
        meta={t("cliOptions.meta")}
      />
      {definitions.length > 0 ? (
        <div className="flex flex-wrap gap-x-[22px] gap-y-[10px]">
          {definitions.map((definition) => (
            <div
              key={definition.key}
              title={tKey(definition.hintKey)}
              className="flex min-w-[220px] flex-1 flex-col gap-[6px]"
            >
              {/* `normal-case` so the explanatory clause the frame appends
                  stays lower-case; the label half is already uppercased in the
                  string. FieldKicker's own `uppercase` would shout both. */}
              <FieldKicker stratum="next" size={10} className="normal-case">
                {cliOptionKicker({
                  label: tKey(definition.labelKey),
                  suffix: suffixOf(definition.key),
                })}
              </FieldKicker>
              <OptionControl
                idPrefix={`${uid}-${definition.key}`}
                definition={definition}
                value={options[definition.key]}
                onChange={(value) => setOption(definition.key, value)}
                disabled={disabled}
                tKey={tKey}
                defaultLabel={t("common.cliDefault")}
              />
            </div>
          ))}
        </div>
      ) : null}
    </StrataBand>
  );
}

function OptionControl({
  idPrefix,
  definition,
  value,
  onChange,
  disabled,
  tKey,
  defaultLabel,
}: {
  idPrefix: string;
  definition: ProviderOptionDefinition;
  value: NamedAgentCliOptions[string] | undefined;
  onChange: (value: NamedAgentCliOptions[string] | undefined) => void;
  disabled: boolean;
  /** The namespace-less translator, for the registry's KEY REFERENCES. */
  tKey: (key: TranslationKey) => string;
  /** Already resolved by the band: the leading "CLI default" on every control. */
  defaultLabel: string;
}) {
  const kind = cliOptionControlKind(definition);

  if (kind === "checkmark") {
    return (
      <span className="flex h-[34px] items-center gap-2 font-sans text-[12px] text-strata-next-mid">
        <CheckMark
          checked={value === true}
          shape="square"
          tone="action"
          disabled={disabled}
          // `false` is stored as undefined: the absence of an option and the
          // option explicitly switched off are the same argv.
          onToggle={() => onChange(value === true ? undefined : true)}
        />
        {tKey(definition.labelKey)}
      </span>
    );
  }

  if (kind === "segmented") {
    const segments: SegmentedControlOption<string>[] = [
      {
        value: CLI_DEFAULT_VALUE,
        label: defaultLabel,
        flex: 1.3,
        disabled,
      },
      ...(definition.choices ?? []).map((choice) => ({
        value: choice.value,
        label: tKey(choice.labelKey),
        flex: 1,
        disabled,
      })),
    ];
    return (
      <SegmentedControl
        options={segments}
        value={typeof value === "string" && value ? value : CLI_DEFAULT_VALUE}
        onChange={(next) =>
          onChange(next === CLI_DEFAULT_VALUE ? undefined : next)
        }
        chrome="filled"
        size="md"
        // Up to six levels on one rail: on a phone they take a second row
        // rather than overlapping each other's labels.
        wrap
        // On the pool ground the inactive label is the stratum's mid tone,
        // not --muted-foreground.
        className="[--segment-inactive:var(--strata-next-mid)]"
      />
    );
  }

  if (kind === "menu") {
    // Nine segments would not fit the track; the dropdown is the fallback.
    const current = (definition.choices ?? []).find(
      (choice) => choice.value === value,
    );
    return (
      <SelectPill
        tone="ink"
        fill="card"
        disabled={disabled}
        label={current ? tKey(current.labelKey) : defaultLabel}
        className="h-[34px] rounded-[10px]"
      >
        <DropdownMenuItem onSelect={() => onChange(undefined)}>
          {defaultLabel}
        </DropdownMenuItem>
        {(definition.choices ?? []).map((choice) => (
          <DropdownMenuItem
            key={choice.value}
            onSelect={() => onChange(choice.value)}
          >
            {tKey(choice.labelKey)}
          </DropdownMenuItem>
        ))}
      </SelectPill>
    );
  }

  if (kind === "number") {
    return (
      <FieldBoxInput
        mono
        id={idPrefix}
        type="number"
        inputMode="numeric"
        min={definition.min}
        max={definition.max}
        aria-label={tKey(definition.labelKey)}
        value={typeof value === "number" ? String(value) : ""}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (!raw) return onChange(undefined);
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? parsed : undefined);
        }}
        placeholder={defaultLabel}
        disabled={disabled}
      />
    );
  }

  return (
    <FieldBoxInput
      id={idPrefix}
      aria-label={tKey(definition.labelKey)}
      value={typeof value === "string" ? value : ""}
      onChange={(event) =>
        onChange(event.target.value.trim() ? event.target.value : undefined)
      }
      placeholder={defaultLabel}
      disabled={disabled}
    />
  );
}
