import {
  getProviderOptionDefinitions,
  type NamedAgentCliOptions,
} from "@/lib/providers/options-registry";

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

/**
 * Which control a registry definition gets on the CLI OPTIONS band.
 *
 * A `select` is a segmented control while its choices fit the track — six
 * segments is the practical ceiling at this width — and falls back to a
 * dropdown beyond that (oh-my-pi's `thinking` has eight). Everything else maps
 * one-to-one onto a control kind.
 *
 * Nothing here knows a CLI's name: the shape of the definition decides, so a
 * provider added to the registry renders without touching this file.
 */
export const SEGMENTED_CHOICE_LIMIT = 5;

export type CliOptionControlKind =
  | "segmented"
  | "menu"
  | "checkmark"
  | "number"
  | "text";

export function cliOptionControlKind(definition: {
  type: string;
  choices?: { value: string }[];
}): CliOptionControlKind {
  if (definition.type === "bool") return "checkmark";
  if (definition.type === "number") return "number";
  if (definition.type === "select") {
    return (definition.choices?.length ?? 0) <= SEGMENTED_CHOICE_LIMIT
      ? "segmented"
      : "menu";
  }
  return "text";
}

/** Sentinel for "no value chosen" — never stored, only used as a menu key. */
export const CLI_DEFAULT_VALUE = "__default__";

/** The leading segment / item label on every CLI option control. */
export const CLI_DEFAULT_LABEL = "CLI default";

/**
 * Kicker copy for one option group.
 *
 * The frame writes a French explanatory clause after two of the kickers and is
 * the higher-fidelity source for them, so the clause is kept — but as a SUFFIX
 * on the registry's own label rather than as a replacement for it. Written as
 * a replacement, "EFFORT — …" would also overwrite agy's "Reasoning effort",
 * whose key is the same word. Every other definition is just its label,
 * uppercased, so an option added to the registry needs no edit here.
 */
const KICKER_SUFFIXES: Record<string, string> = {
  effort: " — combien l'agent réfléchit par tour",
  permission_mode: " — ce qu'il peut toucher sans demander",
};

export function cliOptionKicker(definition: {
  key: string;
  label: string;
}): string {
  return `${definition.label.toUpperCase()}${KICKER_SUFFIXES[definition.key] ?? ""}`;
}
