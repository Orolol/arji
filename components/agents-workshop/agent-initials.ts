import type { TranslationKey } from "@/lib/i18n/catalogue";
import type { ProjectTone } from "@/lib/piscine/tokens";

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
