/**
 * Deterministic prompt token estimation and context section breakdown.
 *
 * Uses the chars/4 heuristic (~1 token per 4 characters), which is fast,
 * deterministic, and requires no external tokenizer dependencies.
 */

export type PromptContextSectionKey =
  | "spec"
  | "memory"
  | "ticket"
  | "comments"
  | "findings"
  | "documents"
  | "system"
  | "other";

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

function matchTopLevelHeading(headingLine: string): PromptContextSectionKey | null {
  const line = headingLine.trim().toLowerCase();

  if (line.startsWith("# system instructions")) {
    return "system";
  }
  if (
    line.startsWith("# project:") ||
    line.startsWith("## project description") ||
    line.startsWith("## project specification")
  ) {
    return "spec";
  }
  if (line.startsWith("## project memory")) {
    return "memory";
  }
  if (line.startsWith("## reference documents")) {
    return "documents";
  }
  if (
    line.startsWith("## epic to implement") ||
    line.startsWith("## ticket to implement") ||
    line.startsWith("## epic context") ||
    line.startsWith("## ticket under review") ||
    line.startsWith("## epic under review") ||
    line.startsWith("## bug under review") ||
    line.startsWith("## user stories") ||
    line.startsWith("### attached screenshots") ||
    line.startsWith("## attached screenshots")
  ) {
    return "ticket";
  }
  if (
    line.startsWith("## comment history") ||
    line.startsWith("## conversation history")
  ) {
    return "comments";
  }
  if (
    line.startsWith("## security audit checklist") ||
    line.startsWith("## code review checklist") ||
    line.startsWith("## compliance & accessibility review checklist") ||
    line.startsWith("## feature completeness review checklist") ||
    line.startsWith("## bug fix verification checklist") ||
    line.startsWith("## custom review agent instructions") ||
    line.startsWith("## code review feedback") ||
    line.startsWith("## deterministic verification evidence") ||
    line.startsWith("## bug-fix rule") ||
    line.startsWith("## acceptance criteria grading rubric") ||
    line.startsWith("## acceptance criteria grading evidence") ||
    line.startsWith("## acceptance-criteria rubric") ||
    line.startsWith("## review findings") ||
    line.startsWith("## ci failure evidence") ||
    line.startsWith("## forensic investigation evidence")
  ) {
    return "findings";
  }
  if (
    line.startsWith("## instructions") ||
    line.startsWith("## visual proof instructions") ||
    line.startsWith("## role boundary")
  ) {
    return "other";
  }

  return null;
}

/**
 * Parses an assembled markdown prompt into context sections and calculates
 * the total estimated tokens and breakdown per section.
 * If sections are provided, attributes directly by construction.
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

  const charCounts: Record<PromptContextSectionKey, number> = {
    spec: 0,
    memory: 0,
    ticket: 0,
    comments: 0,
    findings: 0,
    documents: 0,
    system: 0,
    other: 0,
  };

  // Split prompt by markdown headings outside of code blocks
  const lines = prompt.split("\n");
  let currentKey: PromptContextSectionKey = "other";
  let currentBlockChars = 0;
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
    }

    if (!inCodeFence && (line.startsWith("# ") || line.startsWith("## "))) {
      const matchedKey = matchTopLevelHeading(line);
      if (matchedKey !== null) {
        if (currentBlockChars > 0) {
          charCounts[currentKey] += currentBlockChars;
          currentBlockChars = 0;
        }
        currentKey = matchedKey;
      }
    }
    // line length + 1 for newline
    currentBlockChars += line.length + 1;
  }

  if (currentBlockChars > 0) {
    charCounts[currentKey] += currentBlockChars;
  }

  const breakdown: PromptTokenBreakdown = {
    spec: Math.ceil(charCounts.spec / 4),
    memory: Math.ceil(charCounts.memory / 4),
    ticket: Math.ceil(charCounts.ticket / 4),
    comments: Math.ceil(charCounts.comments / 4),
    findings: Math.ceil(charCounts.findings / 4),
    documents: Math.ceil(charCounts.documents / 4),
    system: Math.ceil(charCounts.system / 4),
    other: Math.ceil(charCounts.other / 4),
  };

  return {
    total: Math.ceil(prompt.length / 4),
    breakdown,
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
  const percentage = Math.round((maxTokens / total) * 100);

  return {
    key: maxKey,
    label: SECTION_LABELS[maxKey] ?? maxKey,
    tokens: maxTokens,
    percentage,
  };
}
