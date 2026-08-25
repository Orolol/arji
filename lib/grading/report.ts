/**
 * Client-safe grading report helpers shared by the pipeline and ticket UI.
 *
 * Reports are stored as one validated JSON array. Consumers still parse them
 * defensively: a legacy or manually-corrupted row must render as ungraded and
 * must never green-light an autonomous pipeline.
 */

export const GRADING_STATUSES = ["met", "partial", "missed"] as const;
export type GradingStatus = (typeof GRADING_STATUSES)[number];

export interface GradingEntry {
  storyId: string;
  criterion: string;
  status: GradingStatus;
  evidence: string;
}

export interface GradingReportData {
  id: string;
  epicId: string;
  agentSessionId: string | null;
  gradings: GradingEntry[];
  summary: string;
  createdAt: string | null;
}

export interface GradingFailureContext {
  reportId: string;
  summary: string;
  missed: GradingEntry[];
}

function isGradingEntry(value: unknown): value is GradingEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.storyId === "string" &&
    entry.storyId.trim().length > 0 &&
    typeof entry.criterion === "string" &&
    entry.criterion.trim().length > 0 &&
    GRADING_STATUSES.includes(entry.status as GradingStatus) &&
    typeof entry.evidence === "string" &&
    entry.evidence.trim().length > 0
  );
}

export function parseGradingEntries(value: unknown): GradingEntry[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || !parsed.every(isGradingEntry)) return null;
  return parsed;
}

/** missed dominates partial, which dominates met. Empty/malformed = ungraded. */
export function aggregateGradingStatus(
  entries: readonly GradingEntry[] | null | undefined,
): GradingStatus | null {
  if (!entries || entries.length === 0) return null;
  if (entries.some((entry) => entry.status === "missed")) return "missed";
  if (entries.some((entry) => entry.status === "partial")) return "partial";
  return "met";
}

/**
 * Acceptance criteria are authored as Markdown checklists, but old imports
 * may contain bullets, numbered lists, or one plain line. Keep each non-empty
 * line as one rubric item and strip only its list marker for presentation.
 */
export function parseAcceptanceCriteria(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim(),
    )
    .filter(Boolean);
}

/** Tolerates a grader preserving or omitting the Markdown list marker. */
export function normalizeCriterion(value: string): string {
  return (
    parseAcceptanceCriteria(value).join(" ") || value.trim()
  ).replace(/\s+/g, " ").toLocaleLowerCase();
}

export function findCriterionGrading(
  entries: readonly GradingEntry[] | null | undefined,
  storyId: string,
  criterion: string,
): GradingEntry | null {
  if (!entries) return null;
  const normalized = normalizeCriterion(criterion);
  return (
    entries.find(
      (entry) =>
        entry.storyId === storyId &&
        normalizeCriterion(entry.criterion) === normalized,
    ) ?? null
  );
}

/** Exact missed criteria and evidence injected into a grading-driven fix. */
export function buildGradingFixSection(
  context: GradingFailureContext,
): string {
  const lines = [
    "## Acceptance grading gaps",
    "",
    "The acceptance grader marked the following criteria as missed. Fix each concrete gap, run focused tests, and commit the result.",
    "",
  ];
  for (const entry of context.missed) {
    lines.push(`### Story \`${entry.storyId}\``);
    lines.push(`- **Criterion:** ${entry.criterion}`);
    lines.push(`- **Evidence / gap:** ${entry.evidence}`);
    lines.push("");
  }
  if (context.summary.trim()) {
    lines.push(`**Grader summary:** ${context.summary.trim()}`);
  }
  return lines.join("\n").trim();
}
