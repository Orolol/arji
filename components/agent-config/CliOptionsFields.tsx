"use client";

/**
 * The "CLI options" section of the named-agent editor.
 *
 * Every field here is rendered from lib/providers/options-registry.ts — keys,
 * labels, hints, accepted values and defaults all come from the registry, so
 * this component has no per-CLI knowledge and a CLI with no registry entry
 * renders nothing at all.
 */

import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/agent-config/Field";
import {
  getProviderOptionDefinitions,
  type NamedAgentCliOptions,
  type ProviderOptionDefinition,
} from "@/lib/providers/options-registry";

/** Sentinel for "no value chosen" — Radix Select rejects an empty item value. */
const UNSET = "__default__";

/**
 * Drops every option the target CLI does not declare.
 *
 * Switching CLI in the editor must not carry ghost values across: an option
 * key that means one thing on Codex may not exist on Oh My Pi, and a value
 * the new CLI never offered would be silently stored (the server drops it
 * again, but the form would keep showing it until a reload).
 */
export function resetOptionsForProvider(
  provider: string,
  options: NamedAgentCliOptions,
): NamedAgentCliOptions {
  const definitions = getProviderOptionDefinitions(provider);
  const next: NamedAgentCliOptions = {};

  for (const definition of definitions) {
    const value = options[definition.key];
    if (value === undefined || value === definition.default) continue;
    // A key can exist on both CLIs with a different set of accepted values
    // (claude's effort has xhigh/max, agy's does not), so re-check membership
    // rather than trusting the key alone.
    if (
      definition.type === "select" &&
      !definition.choices?.some((choice) => choice.value === String(value))
    ) {
      continue;
    }
    next[definition.key] = value;
  }

  return next;
}

function OptionField({
  idPrefix,
  definition,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  definition: ProviderOptionDefinition;
  value: NamedAgentCliOptions[string] | undefined;
  onChange: (value: NamedAgentCliOptions[string] | undefined) => void;
  disabled?: boolean;
}) {
  const id = `${idPrefix}-${definition.key}`;

  if (definition.type === "bool") {
    return (
      <Field id={id} label={definition.label} hint={definition.hint}>
        <Checkbox
          id={id}
          checked={value === true}
          onCheckedChange={(checked) =>
            onChange(checked === true ? true : undefined)
          }
          disabled={disabled}
        />
      </Field>
    );
  }

  if (definition.type === "select") {
    return (
      <Field id={id} label={definition.label} hint={definition.hint}>
        <Select
          value={typeof value === "string" && value ? value : UNSET}
          onValueChange={(next) =>
            onChange(next === UNSET ? undefined : next)
          }
          disabled={disabled}
        >
          <SelectTrigger id={id} className="h-8 text-sm">
            <SelectValue placeholder="CLI default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET}>CLI default</SelectItem>
            {definition.choices?.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  }

  if (definition.type === "number") {
    return (
      <Field id={id} label={definition.label} hint={definition.hint}>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={definition.min}
          max={definition.max}
          value={typeof value === "number" ? String(value) : ""}
          onChange={(event) => {
            const raw = event.target.value.trim();
            if (!raw) return onChange(undefined);
            const parsed = Number(raw);
            onChange(Number.isFinite(parsed) ? parsed : undefined);
          }}
          placeholder="CLI default"
          className="h-8 text-sm"
          disabled={disabled}
        />
      </Field>
    );
  }

  return (
    <Field id={id} label={definition.label} hint={definition.hint}>
      <Input
        id={id}
        value={typeof value === "string" ? value : ""}
        onChange={(event) =>
          onChange(event.target.value.trim() ? event.target.value : undefined)
        }
        placeholder="CLI default"
        className="h-8 text-sm"
        disabled={disabled}
      />
    </Field>
  );
}

export function CliOptionsFields({
  idPrefix,
  provider,
  options,
  onChange,
  disabled,
}: {
  idPrefix: string;
  provider: string;
  options: NamedAgentCliOptions;
  onChange: (options: NamedAgentCliOptions) => void;
  disabled?: boolean;
}) {
  const definitions = getProviderOptionDefinitions(provider);
  if (definitions.length === 0) return null;

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
    <section
      aria-labelledby={`${idPrefix}-cli-options-heading`}
      className="rounded-md border border-border/60 p-3 space-y-3"
    >
      <h4
        id={`${idPrefix}-cli-options-heading`}
        className="text-xs font-medium text-muted-foreground"
      >
        CLI options
      </h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {definitions.map((definition) => (
          <OptionField
            key={definition.key}
            idPrefix={idPrefix}
            definition={definition}
            value={options[definition.key]}
            onChange={(value) => setOption(definition.key, value)}
            disabled={disabled}
          />
        ))}
      </div>
    </section>
  );
}
