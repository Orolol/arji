/**
 * The payload of `GET /api/qa/findings` — the one read frame 11b makes.
 *
 * 11b is the cross-project review layer: which review passes are running,
 * which open findings still need a human verdict, what the last week of
 * reviews concluded, and the checklist the reviewers are handed. Every field
 * here is cross-project by construction, exactly like the control desk.
 *
 * Nothing in this module touches the database: it is the contract shared by
 * `lib/qa/aggregate.ts` (which derives it), `app/api/qa/findings/route.ts`
 * (which feeds that derivation) and `hooks/useQaFindings.ts` (which polls it).
 *
 * DATA-GAP RULE, everywhere in here: a figure that does not exist is `null`,
 * never `0`. The screen renders `null` as an em-dash, and a zero would be a
 * lie the rest of the app does not tell. `coveragePercent` is the one that
 * matters most: 0% review coverage and "nothing shipped in the window" are
 * different facts and must not print the same glyph.
 *
 * NAMING: this is NOT the exploratory QA-check agent
 * (`app/projects/[projectId]/qa`, `qa_prompts`, `hooks/useQaReports.ts`).
 * That surface is unrelated and untouched; everything here is prefixed `Qa…`
 * only because the screen is called QA.
 */

import type { DeskProject } from "@/lib/control-desk/types";

/** The frame's "· 30j" — the window the coverage stat measures. */
export const QA_COVERAGE_DAYS = 30;

/** The frame's "7 jours" — the window VERDICTS RÉCENTS reaches back over. */
export const QA_VERDICT_DAYS = 7;

/** Max characters of `agent_sessions.last_non_empty_text` this route ships. */
export const QA_LOG_LINE_LIMIT = 200;

/** VERDICTS RÉCENTS is `shrink-0`; past this the band would push the split off. */
export const QA_VERDICT_LIMIT = 6;

/**
 * The stamp weight a finding is drawn at.
 *
 * NOT the same question as {@link QaFinding.blocking}: `tier` is the word and
 * the pill colour (the reviewer's own vocabulary), `blocking` is the merge
 * gate's answer. They can legitimately disagree — a `[major]` superseded by a
 * later clean verdict is drawn MAJOR and is not blocking — and that
 * disagreement is the correct answer, not a bug.
 */
export type QaSeverityTier = "blocking" | "major" | "minor";

export interface QaFinding {
  /** `review_comments.id`. */
  findingId: string;
  epicId: string;
  projectId: string;
  readableId: string | null;
  ticketTitle: string;
  /** The reviewer's text with the `[severity] ` prefix stripped. */
  text: string;
  filePath: string;
  lineNumber: number;
  /** critical | major | minor | info | "unclassified" | "human". */
  severity: string;
  /** Stamp word: BLOCKING | MAJOR | MINOR | INFO | UNCLASSIFIED | HUMAN. */
  severityLabel: string;
  tier: QaSeverityTier;
  /** `blocksMergeSql`'s answer for this row. Drives the counter + the filter. */
  blocking: boolean;
  /** `named_agent_name` of the filing session, else its agent_type, else null. */
  reviewer: string | null;
  /** review_security | review_code | … | null (rows with no filing session). */
  reviewerAgentType: string | null;
  filedAt: string | null;
  /** The build route refuses non-buildable statuses; never offer a refused button. */
  fixable: boolean;
  /**
   * The finding's body as stored, prefix included. The "Fix with agent"
   * dispatch reproduces `ReviewActions`' markdown byte-for-byte, and that
   * markdown quotes the raw body — the builder's prompt has seen that shape
   * since long before this screen existed.
   */
  rawBody: string;
}

export interface QaRun {
  sessionId: string;
  projectId: string;
  epicId: string | null;
  readableId: string | null;
  title: string;
  agentName: string | null;
  /** ISO/SQLite timestamp the chrono counts from. */
  startedAt: string;
  /** `substr(last_non_empty_text, 1, QA_LOG_LINE_LIMIT)` — never the raw column. */
  lastLine: string | null;
  /** Rows this session has filed so far. `null` when it has filed none yet. */
  findingsFiled: number | null;
  blockingFiled: number | null;
}

export interface QaQueuedRun {
  sessionId: string;
  projectId: string;
  epicId: string | null;
  readableId: string | null;
  title: string;
}

export interface QaVerdict {
  epicId: string;
  projectId: string;
  readableId: string | null;
  title: string;
  /** "review clean · 0 findings", "changes requested · 3 findings", … */
  verdictText: string;
  kind: "clean" | "attention";
  /** "→ landed" | "→ ready" | "→ your turn". */
  outcome: string;
  at: string | null;
}

export interface QaRubric {
  /** The bold headings of the feature-review checklist, in order. */
  items: string[];
  /** Enabled `custom_review_agents` rows — the "+ N règles projet" chip. */
  projectRuleCount: number;
}

/**
 * A ticket "Run QA pass" may legally target.
 *
 * Derived server-side rather than in the client so the button can never offer
 * a dispatch the route would refuse: the review route accepts only
 * `review | to_merge | done` and 409s when another agent owns the epic.
 */
export interface QaReviewTarget {
  epicId: string;
  projectId: string;
  readableId: string | null;
  title: string;
  status: string;
}

export interface QaPayload {
  generatedAt: string;
  /** Reused from the desk — one derivation, so project colours cannot disagree. */
  projects: DeskProject[];
  runs: QaRun[];
  queued: QaQueuedRun[];
  findings: QaFinding[];
  verdicts: QaVerdict[];
  rubric: QaRubric;
  reviewable: QaReviewTarget[];
  /** 0..100, or `null` when nothing shipped in the window. NEVER 0-as-unknown. */
  coveragePercent: number | null;
}
