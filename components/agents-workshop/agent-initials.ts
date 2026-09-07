import type { TranslationKey } from "@/lib/i18n/catalogue";
import type { ProjectTone } from "@/lib/piscine/tokens";
import { PROVIDER_LABELS } from "@/lib/agent-config/constants";

/**
 * Two-letter roster-avatar label. Words first ("Opus Builder" → "OB"), falling
 * back to the first two characters of a single word ("opus" → "Op").
 *
 * ITS TWIN IS GONE: `projectInitials` lived in the left rail
 * (components/layout/Sidebar.tsx), retired with frame 13a — the global bar
 * prints full project names on its chips, so nothing abbreviates a project any
 * more. This is now the only initials rule in the app.
 */
export function agentInitials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) {
    const word = words[0];
    return (word[0] + (word[1] ?? ""))
      .slice(0, 2)
      .replace(/^./, (c) => c.toUpperCase());
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * A stable pastel for an agent's avatar square.
 *
 * DECORATION, NOT IDENTITY. Agents have no `colorIndex` column and must not
 * get one: nothing in the product means anything by an agent's colour, so a
 * stored column would invent a fact. Hashing the id keeps the square stable
 * across reloads (the honest part) without pretending the colour is data.
 */
export function agentTone(agentId: string): ProjectTone {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return ((hash % 4) + 1) as ProjectTone;
}

/**
 * Where an assignment or a prompt comes from. The same three strings the
 * agent-config sheet used, kept in ONE place now that the assignments tiles,
 * the assignments page and the prompts page all render them.
 *
 * A MODULE-SCOPE COPY TABLE, so it holds catalogue KEY REFERENCES and the
 * caller resolves them with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3): `t(sourceLabelKey(source))`.
 */
const SOURCE_LABELS: Record<
  "builtin" | "global" | "project",
  { labelKey: TranslationKey }
> = {
  builtin: { labelKey: "AgentsWorkshop.source.builtin" },
  global: { labelKey: "AgentsWorkshop.source.global" },
  project: { labelKey: "AgentsWorkshop.source.project" },
};

export function sourceLabelKey(
  source: "builtin" | "global" | "project",
): TranslationKey {
  return SOURCE_LABELS[source].labelKey;
}

/**
 * The phrases the second line of an agent row is made of, already resolved by
 * the caller's translator (`lib/i18n/catalogue.ts`, pattern 3) —
 * `assignmentAgentSubLabel` composes, it does not hold copy.
 */
export interface AssignmentAgentCopy {
  /** `AgentsWorkshop.composite.ladder` — the members in order. */
  compositeLadder: (ladder: string) => string;
  /** `AgentsWorkshop.composite.ladderEmpty`. */
  compositeEmpty: string;
  /** `AgentsWorkshop.assignments.agentMeta` — provider and model. */
  simple: (provider: string, model: string) => string;
  /** `AgentsWorkshop.common.cliDefaultModel` — the model when none is set. */
  cliDefaultModel: string;
}

/**
 * The second line of an agent row in the two ROLE-ASSIGNMENT pickers.
 *
 * A composite has no CLI and no model of its own — `named_agents.provider`
 * holds the documented sentinel, and `PROVIDER_LABELS` (keyed on
 * `ChatModeProvider`) has no entry for it. Rendering the simple-agent shape
 * for one therefore printed an empty label followed by " · CLI default
 * model": a blank provider and a claim about a CLI it does not have.
 *
 * A composite's ladder is what predicts its run, so that is what this shows,
 * matching the "composite · N" marker the two dispatch pickers already use.
 * Shared because both assignment surfaces render the identical row and this
 * is exactly the kind of duplicated vocabulary that drifts.
 */
export function assignmentAgentSubLabel(
  agent: {
    kind?: "simple" | "composite";
    provider: string;
    model: string;
    members?: Array<{ name: string }>;
  },
  copy: AssignmentAgentCopy,
): string {
  if (agent.kind === "composite") {
    const members = agent.members ?? [];
    if (members.length === 0) return copy.compositeEmpty;
    return copy.compositeLadder(
      members.map((member) => member.name).join(" → "),
    );
  }
  const label =
    (PROVIDER_LABELS as Record<string, string>)[agent.provider] ??
    agent.provider;
  return copy.simple(label, agent.model || copy.cliDefaultModel);
}
