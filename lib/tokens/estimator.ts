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
