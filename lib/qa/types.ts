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
 * TWO FAMILIES LIVE IN HERE, and keeping them apart is the point of the names.
 * `QaRun` / `QaFinding` / `QaVerdict` are the REVIEW layer: sessions bound to a
 * ticket, and the findings they file. `QaCheck` is the exploratory QA-check
 * agent (`qa_reports`, `app/projects/[projectId]/qa`, `hooks/useQaReports.ts`)
 * — a project-wide tech check, E2E pass or failure digest with no ticket at
 * all. The redesign gave the nav's QA entry to the first family only, which is
 * how "run a tech check" stopped being reachable; `checks` and
 * `checkableProjectIds` are what put it back on this screen.
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

/**
 * How many `qa_reports` rows the QA CHECKS band carries.
 *
 * The band is `shrink-0` on a screen whose coral findings band owns the
 * leftover height, so this is a HEIGHT budget, not a page size: five rows plus
 * the header is about the most the band can take without pushing the bottom
 * split off a laptop. The full history is `/projects/:id/qa`, one click away on
 * every row.
 */
export const QA_CHECK_LIMIT = 5;

/** Max characters of `qa_reports.summary` this route ships. */
export const QA_CHECK_SUMMARY_LIMIT = 200;

/**
 * The three exploratory QA passes a human can dispatch by hand.
 *
 * `qa_reports.check_type` is free-form TEXT with a `tech_check` default, so a
 * row can legally hold something else; every consumer here therefore treats an
 * unknown value as its own word rather than narrowing the column to this union.
 */
export type QaCheckType = "tech_check" | "e2e_test" | "failure_digest";

/**
 * One `qa_reports` row, as the QA CHECKS band draws it.
 *
 * NOT a {@link QaRun}. A run is a REVIEW session bound to a ticket; a check is
 * the project-wide QA agent (tech check, E2E, failure digest) and has no epic
 * at all. They share the screen and nothing else — which is exactly why the
 * redesign lost the checks: the band above only ever listed review sessions.
 *
 * `reportContent` and `promptUsed` are deliberately absent. They are the two
 * multi-megabyte columns of this table and this payload is polled every 8 s.
 */
export interface QaCheck {
  /** `qa_reports.id` — also the `?reportId=` deep link into the report. */
  reportId: string;
  projectId: string;
  /** As stored. `tech_check` | `e2e_test` | `failure_digest` | anything else. */
  checkType: string;
  /** Stamp word: TECH | E2E | DIGEST, or the raw value upper-cased. */
  checkLabel: string;
  /**
   * The word the row prints: the report's own `running | completed | failed |
   * cancelled`, EXCEPT that a report still claiming `running` behind a session
   * that has already ended reads `interrupted`. That value is derived and never
   * stored — see `checkStatusLabel`.
   */
  status: string;
  /**
   * Is the check still going? NOT `status === "running"`: `qa_reports.status`
   * has one writer and three ordinary paths strand it. Read from the session
   * behind the report — see `isCheckLive`.
   */
  live: boolean;
  /** `SUBSTR(summary, 1, QA_CHECK_SUMMARY_LIMIT)` — never the raw column. */
  summary: string | null;
  /** The session behind it, or `null` for the no-op digest that launched none. */
  agentSessionId: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

/** Cross-project counts behind the QA CHECKS band's meta. */
export interface QaCheckTotals {
  /** Reports that are genuinely still going. */
  running: number;
  /** Every `qa_reports` row, whatever its state. */
  total: number;
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
  /** The most recent QA checks, live ones first. See {@link QaCheck}. */
  checks: QaCheck[];
  /**
   * Totals over EVERY report, keyed by project — not over the `checks` window
   * above.
   *
   * `checks` is capped at `QA_CHECK_LIMIT`, so counting it would saturate at
   * the cap and understate exactly when several checks are in flight. `running`
   * uses the same liveness rule the rows do, so the meta cannot claim more live
   * checks than the band draws breathing dots.
   *
   * PER PROJECT rather than one workspace figure, because the screen takes an
   * optional `projectId` and `filterQaPayload` narrows the rows. A single total
   * would survive that narrowing unchanged and print a workspace count over one
   * project's band — a worse lie than the capped slice it replaces. Projects
   * with no report at all are simply absent; `sumCheckTotals` reads a missing
   * key as zero.
   */
  checkTotals: Record<string, QaCheckTotals>;
  /**
   * Projects a QA check may be dispatched against — those with a
   * `git_repo_path`, because `POST /api/projects/{p}/qa/check` 400s without
   * one. Derived server-side for the same reason `reviewable` is: the button
   * must never offer a dispatch the route would refuse.
   */
  checkableProjectIds: string[];
  /** 0..100, or `null` when nothing shipped in the window. NEVER 0-as-unknown. */
  coveragePercent: number | null;
}
