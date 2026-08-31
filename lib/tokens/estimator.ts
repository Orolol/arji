import type { PromptContextSectionKey } from "@/lib/claude/prompt-sections";
export type { PromptContextSectionKey } from "@/lib/claude/prompt-sections";

/**
 * Deterministic prompt token estimation and context section breakdown.
 *
 * Uses the chars/4 heuristic (~1 token per 4 characters), which is fast,
 * deterministic, and requires no external tokenizer dependencies.
 */

export interface PromptTokenBreakdown {
  spec: number;
  memory: number;
  ticket: number;
  comments: number;
  findings: number;
  documents: number;
  system: number;
  other: number;
  /**
   * Named-agent persona, prepended to the whole prompt by
   * processManager.start() AFTER the dispatch-time estimate is taken (see
   * lib/claude/process-manager.ts) — so a STORED breakdown never carries it
   * and `system` never double-counts it.
   *
   * OPTIONAL, and only ever emitted when the caller supplied
   * `sections.persona`: the eight-key shape is a wire format several suites
   * pin exactly (`Object.values(breakdown)` must stay length 8), and
   * app/api/projects/[projectId]/prompt-estimate/route.ts builds an eight-key
   * literal. A required ninth key would break both.
   */
  persona?: number;
}

export interface EstimatedPromptTokens {
  total: number;
  breakdown: PromptTokenBreakdown;
}

export interface LargestContextSection {
  key: PromptContextSectionKey;
  label: string;
  tokens: number;
  percentage: number;
}

export interface PromptSectionTexts {
  system?: string | null;
  spec?: string | null;
  memory?: string | null;
  ticket?: string | null;
  comments?: string | null;
  findings?: string | null;
  documents?: string | null;
  other?: string | null;
  /**
   * The named agent's persona block. Deliberately NOT a
   * {@link PromptContextSectionKey}: it is not a budgetable context section,
   * it is agent configuration prepended at spawn time. Supplying it here is
   * how a caller that already knows the persona (the prompt-anatomy route)
   * gets a `persona` entry in the breakdown.
   */
  persona?: string | null;
}

export const SECTION_LABELS: Record<PromptContextSectionKey, string> = {
  spec: "Project Specification",
  memory: "Learned Memory",
  ticket: "Ticket & Stories",
  comments: "Comment History",
  findings: "Review Findings & Checklists",
  documents: "Reference Documents",
  system: "System Instructions",
  other: "General Instructions",
};

/**
 * Basic character to token estimator: 1 token ≈ 4 characters.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimates prompt tokens by measuring individual context sections by construction.
 * This avoids any misattribution from markdown headings or code fences inside user/agent text.
 */
export function estimatePromptTokensBySections(
  sections: PromptSectionTexts,
  fullPromptText?: string
): EstimatedPromptTokens {
  const breakdown: PromptTokenBreakdown = {
    spec: estimateTokens(sections.spec),
    memory: estimateTokens(sections.memory),
    ticket: estimateTokens(sections.ticket),
    comments: estimateTokens(sections.comments),
    findings: estimateTokens(sections.findings),
    documents: estimateTokens(sections.documents),
    system: estimateTokens(sections.system),
    other: estimateTokens(sections.other),
  };

  // The ninth key materialises ONLY when a persona was supplied, so the
  // eight-key wire shape (and `Object.values(breakdown).length === 8`) is
  // unchanged for every existing caller.
  if (typeof sections.persona === "string" && sections.persona.length > 0) {
    breakdown.persona = estimateTokens(sections.persona);
  }

  const total = fullPromptText
    ? estimateTokens(fullPromptText)
    : Math.max(
        0,
        Math.ceil(
          Object.values(sections)
            .filter((s): s is string => Boolean(s))
            .join("\n").length / 4
        )
      );

  return {
    total,
    breakdown,
  };
}

/**
 * Calculates a total for arbitrary text. A breakdown is emitted only when
 * exact builder sections are supplied; guessing from untrusted Markdown
 * headings would produce confidently wrong persisted data.
 */
export function estimatePromptTokens(
  prompt: string | null | undefined,
  sections?: PromptSectionTexts
): EstimatedPromptTokens {
  if (!prompt || prompt.length === 0) {
    return {
      total: 0,
      breakdown: {
        spec: 0,
        memory: 0,
        ticket: 0,
        comments: 0,
        findings: 0,
        documents: 0,
        system: 0,
        other: 0,
      },
    };
  }

  if (sections) {
    return estimatePromptTokensBySections(sections, prompt);
  }

  return {
    total: estimateTokens(prompt),
    breakdown: {
      spec: 0,
      memory: 0,
      ticket: 0,
      comments: 0,
      findings: 0,
      documents: 0,
      system: 0,
      other: 0,
    },
  };
}

/**
 * Identifies the largest context section in the breakdown.
 */
export function findLargestContextSection(
  breakdown: PromptTokenBreakdown,
  totalTokens?: number
): LargestContextSection | null {
  const keys: PromptContextSectionKey[] = [
    "spec",
    "memory",
    "ticket",
    "comments",
    "findings",
    "documents",
    "system",
    "other",
  ];

  let maxKey: PromptContextSectionKey = "spec";
  let maxTokens = 0;

  for (const key of keys) {
    const tokens = breakdown[key] ?? 0;
    if (tokens > maxTokens) {
      maxTokens = tokens;
      maxKey = key;
    }
  }

  if (maxTokens <= 0) return null;

  const total = totalTokens && totalTokens > 0 ? totalTokens : maxTokens;
  const percentage = Math.min(100, Math.round((maxTokens / total) * 100));

  return {
    key: maxKey,
    label: SECTION_LABELS[maxKey] ?? maxKey,
    tokens: maxTokens,
    percentage,
  };
}

// ---------------------------------------------------------------------------
// Prompt anatomy — the six segments of frame 8b's stacked token bar
// ---------------------------------------------------------------------------

/**
 * The six segments of the ANATOMIE DU PROMPT bar, in their fixed paint order.
 *
 * Deliberately NOT the same vocabulary as {@link PromptContextSectionKey}:
 * the estimator stores eight budgetable sections, the design draws six bands.
 * The folding between the two lives in {@link toPromptAnatomySegments} and
 * nowhere else, so the route and the band can never disagree about it.
 */
export type PromptAnatomySegment =
  | "system"
  | "persona"
  | "spec"
  | "memory"
  | "ticket"
  | "docs";

export const PROMPT_ANATOMY_ORDER: PromptAnatomySegment[] = [
  "system",
  "persona",
  "spec",
  "memory",
  "ticket",
  "docs",
];

/**
 * Folds a stored eight-key breakdown onto the six drawn segments.
 *
 * - `ticket + comments + findings` → TICKET / DIFF (one blue band: they are
 *   all "what this particular piece of work is about").
 * - `other` → SYSTEM. `other` is the builder's general instructions; giving it
 *   its own colour would need a seventh legend entry the design does not have.
 * - PERSONA comes from the caller, not from the row: the persona is prepended
 *   after the estimate is taken, so a stored breakdown never contains it.
 *   Passing `undefined` falls back to an explicitly-supplied `breakdown.persona`
 *   (the case where the estimate was computed WITH `sections.persona`).
 */
export function toPromptAnatomySegments(
  breakdown: PromptTokenBreakdown,
  personaTokens?: number,
): Record<PromptAnatomySegment, number> {
  const safe = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

  const persona =
    personaTokens === undefined ? safe(breakdown.persona) : safe(personaTokens);

  return {
    system: safe(breakdown.system) + safe(breakdown.other),
    persona,
    spec: safe(breakdown.spec),
    memory: safe(breakdown.memory),
    ticket:
      safe(breakdown.ticket) + safe(breakdown.comments) + safe(breakdown.findings),
    docs: safe(breakdown.documents),
  };
}
