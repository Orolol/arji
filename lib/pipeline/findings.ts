import { and, eq } from "drizzle-orm";
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import { agentSessions, reviewComments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { parseReviewReport } from "./parse-review-report";
import {
  blockingFindingSeverity,
  type BlockingFindingSeverity,
} from "@/lib/review/finding-severity";
import {
  isStructuredReviewVerdict,
  NEGATIVE_STRUCTURED_VERDICT,
  type StructuredReviewVerdict,
} from "@/lib/review/verdict";

/**
 * Review-verdict assessment shared by the pipeline's review stage
 * (lib/pipeline/stages.ts) and the review routes.
 *
 * THREE channels, in strict priority order.
 *
 * 1. STRUCTURED VERDICT — authoritative. The MCP `submit_findings` tool
 *    persists its `verdict` on the calling session row
 *    (agent_sessions.review_verdict, see app/api/mcp/submit-findings/route.ts).
 *    When the stage's review session carries one, it decides, and the prose
 *    scan is IGNORED — a reviewer that said `changes_requested` through the
 *    tool has requested changes even if its markdown reads like an approval,
 *    and vice versa.
 *
 * 2. BLOCKING FINDINGS — a veto, never an approval. `submit_findings` files
 *    each finding as a reviewComments row whose body is prefixed
 *    `[<severity>] ` with the vocabulary critical|major|minor|info. A finding
 *    BLOCKS when its row is
 *      - author 'agent',
 *      - status 'open',
 *      - created during the review-stage window (createdAt >= sinceIso), and
 *      - prefixed `[critical]` or `[major]`.
 *    minor/info-only reviews pass. An `approved` verdict filed ALONGSIDE an
 *    open [critical]/[major] finding stays BLOCKING: the reviewer contradicted
 *    itself, and the finding is the more specific, human-resolvable artifact —
 *    it also blocks review→done in the workflow engine, so approving here
 *    would only move the ticket to a state the approval gate refuses.
 *
 * 3. PROSE FALLBACK — last resort, unchanged. Only when the session filed NO
 *    structured verdict at all: the session output is scanned for the
 *    negative-verdict substrings the review routes already use ('changes
 *    requested' | 'not complete' | 'partially complete', lowercased). This
 *    channel is not legacy baggage — gemini-cli and the other providers
 *    without MCP injection cannot call `submit_findings`, and
 *    review_provider_segregation can route a review to exactly those.
 *
 * Retro-compatibility: a review session with no persisted verdict behaves
 * bit-for-bit as before this module gained channel 1.
 *
 * Timestamps are compared via Date.parse on BOTH sides so explicit ISO
 * strings (what submit_findings writes) and SQLite CURRENT_TIMESTAMP
 * defaults coexist. reviewComments is epic-keyed only, so the same queries
 * serve story-scoped runs.
 *
 * The pipeline never mutates reviewComments — no auto-resolve. A second
 * cycle's verdict is computed from the second stage's window; humans
 * bulk-resolve open rows at approve time.
 */

export interface BlockingFinding {
  id: string;
  filePath: string;
  lineNumber: number;
  body: string;
  severity: BlockingFindingSeverity;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

interface AgentReviewCommentRow {
  id: string;
  filePath: string;
  lineNumber: number;
  body: string;
  status: string;
  createdAt: string | null;
}

/**
 * All agent-authored reviewComments rows for the epic created at or after
 * `sinceIso` (any status). Rows whose createdAt cannot be parsed are treated
 * as outside the window — a finding we cannot date cannot be attributed to
 * the stage.
 */
function listAgentReviewCommentsSince(
  epicId: string,
  sinceIso: string,
  database: ArijDatabase
): AgentReviewCommentRow[] {
  const sinceMs = parseTimestamp(sinceIso);
  if (sinceMs === null) return [];

  return database
    .select({
      id: reviewComments.id,
      filePath: reviewComments.filePath,
      lineNumber: reviewComments.lineNumber,
      body: reviewComments.body,
      status: reviewComments.status,
      createdAt: reviewComments.createdAt,
    })
    .from(reviewComments)
    .where(
      and(eq(reviewComments.epicId, epicId), eq(reviewComments.author, "agent"))
    )
    .all()
    .filter((row) => {
      const createdMs = parseTimestamp(row.createdAt);
      return createdMs !== null && createdMs >= sinceMs;
    });
}

/**
 * Number of agent reviewComments rows filed in the stage window (any
 * status/severity). Zero enables the prose fallback.
 */
export function countAgentReviewCommentsSince(
  epicId: string,
  sinceIso: string,
  database: ArijDatabase = defaultDb
): number {
  return listAgentReviewCommentsSince(epicId, sinceIso, database).length;
}

/**
 * Open agent-authored [critical]/[major] findings created in the stage
 * window — the rows that block the pipeline's review verdict.
 */
export function collectBlockingFindings(
  epicId: string,
  sinceIso: string,
  database: ArijDatabase = defaultDb
): BlockingFinding[] {
  const findings: BlockingFinding[] = [];
  for (const row of listAgentReviewCommentsSince(epicId, sinceIso, database)) {
    if (row.status !== "open") continue;
    const severity = blockingFindingSeverity(row.body);
    if (!severity) continue;
    findings.push({
      id: row.id,
      filePath: row.filePath,
      lineNumber: row.lineNumber,
      body: row.body,
      severity,
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Channel 1 — the structured verdict                                  */
/* ------------------------------------------------------------------ */

/**
 * The verdict vocabulary now lives in lib/review/verdict.ts, so the workflow
 * engine can read it without importing the pipeline. Re-exported here because
 * this module has been its published home since the structured verdict
 * landed.
 */
export {
  STRUCTURED_REVIEW_VERDICTS,
  NEGATIVE_STRUCTURED_VERDICT,
  type StructuredReviewVerdict,
} from "@/lib/review/verdict";

/** Which channel produced a verdict, for the activity-log trail. */
export type ReviewVerdictSource = "structured" | "prose";

/**
 * The verdict a review session submitted through `submit_findings`, or null
 * when it never called the tool (no MCP channel, a crash before the call, or
 * a legacy row predating the column). The column is free text, so an
 * unrecognised value is treated as absent rather than trusted — a verdict the
 * decision table has no rule for must not silently pass as an approval.
 */
export function readStructuredReviewVerdict(
  sessionId: string | null | undefined,
  database: ArijDatabase = defaultDb
): StructuredReviewVerdict | null {
  if (!sessionId) return null;
  const row = database
    .select({ reviewVerdict: agentSessions.reviewVerdict })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  return isStructuredReviewVerdict(row?.reviewVerdict)
    ? row.reviewVerdict
    : null;
}

/**
 * Findings window for a review session dispatched outside the pipeline
 * runner (the review routes, which have no explicit stage clock): the moment
 * the session started running, falling back to its row creation. Null when
 * neither is readable — the caller then has no window and skips the findings
 * veto.
 */
export function readSessionFindingsWindow(
  sessionId: string | null | undefined,
  database: ArijDatabase = defaultDb
): string | null {
  if (!sessionId) return null;
  const row = database
    .select({
      startedAt: agentSessions.startedAt,
      createdAt: agentSessions.createdAt,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  return row?.startedAt ?? row?.createdAt ?? null;
}

/* ------------------------------------------------------------------ */
/* Channel 3 — the prose fallback                                      */
/* ------------------------------------------------------------------ */

/**
 * Byte-compatible with the review routes' verdict scan: the lowercased whole
 * output is checked for these substrings.
 */
export const NEGATIVE_VERDICT_SUBSTRINGS = [
  "changes requested",
  "not complete",
  "partially complete",
] as const;

export function isNegativeProseVerdict(output: string): boolean {
  const lower = output.toLowerCase();
  return NEGATIVE_VERDICT_SUBSTRINGS.some((substring) =>
    lower.includes(substring)
  );
}

/**
 * Recovers reviewComments rows from the review report when the reviewer filed
 * none through `submit_findings`.
 *
 * This is the repair for a channel that never carried anything: reviewComments
 * was empty for the whole life of the database because codex-cli does not
 * expose Arij's MCP server under `codex exec` (see parse-review-report.ts), so
 * builders were dispatched with zero knowledge of what review had found and
 * reviewers re-derived a fresh set of findings every cycle.
 *
 * Rows are written exactly as submit-findings writes them — author 'agent',
 * status 'open', body prefixed `[<severity>] ` — so collectBlockingFindings,
 * buildReviewFeedbackSection and get_ticket cannot tell the two sources apart.
 *
 * Naturally idempotent: it only runs when the window holds zero agent rows, so
 * a second call for the same window sees the rows it just wrote and no-ops.
 * Returns the number of rows created.
 */
export function ingestProseFindings(input: {
  epicId: string;
  sinceIso: string;
  sessionOutput: string;
  database?: ArijDatabase;
}): number {
  const database = input.database ?? defaultDb;

  if (
    countAgentReviewCommentsSince(input.epicId, input.sinceIso, database) > 0
  ) {
    return 0;
  }

  const parsed = parseReviewReport(input.sessionOutput);
  if (parsed.length === 0) return 0;

  const now = new Date().toISOString();
  for (const finding of parsed) {
    database
      .insert(reviewComments)
      .values({
        id: createId(),
        epicId: input.epicId,
        filePath: finding.filePath,
        lineNumber: finding.lineNumber,
        body: `[${finding.severity}] ${finding.body}`,
        author: "agent",
        status: "open",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  return parsed.length;
}

/* ------------------------------------------------------------------ */
/* The decision                                                        */
/* ------------------------------------------------------------------ */

export interface ReviewAssessment {
  /** True when the review outcome blocks the run (verdict, findings, prose). */
  blocking: boolean;
  blockingFindings: BlockingFinding[];
  /** Rows filed through `submit_findings` in the window (pre-ingestion). */
  agentCommentCount: number;
  /** True when the prose scan decided the verdict. */
  usedProseFallback: boolean;
  /** Result of the prose scan (informational when a structured verdict won). */
  proseNegative: boolean;
  /** Persisted submit_findings verdict of the review session, when any. */
  structuredVerdict: StructuredReviewVerdict | null;
  /** Which channel decided `blocking`, for the activity-log trail. */
  verdictSource: ReviewVerdictSource;
  /** Rows recovered from the report by ingestProseFindings. */
  proseIngestedCount: number;
}

/**
 * Full review-stage verdict.
 *
 * `reviewSessionId` is the stage's review session — omit it (or pass null)
 * and the assessment degrades to the pre-structured behaviour, which is what
 * makes callers that have no session id safe.
 *
 * `verdictSource` is `structured` only when the persisted verdict decided.
 * The findings-row path is reported as `prose` because it is the same
 * pre-existing fallback branch, not a channel an agent chose deliberately.
 */
export function assessReviewOutcome(input: {
  epicId: string;
  sinceIso: string;
  sessionOutput: string;
  reviewSessionId?: string | null;
  database?: ArijDatabase;
}): ReviewAssessment {
  const database = input.database ?? defaultDb;
  const agentCommentCount = countAgentReviewCommentsSince(
    input.epicId,
    input.sinceIso,
    database
  );
  const proseNegative = isNegativeProseVerdict(input.sessionOutput);
  const usedProseFallback = agentCommentCount === 0;

  // Recover anchored findings from the report BEFORE collecting, so a
  // prose-only review still hands the next builder file+line context.
  //
  // Ingestion deliberately does NOT move the verdict: when the tool channel
  // stayed silent, the reviewer's own "**Overall Verdict: …**" line remains
  // authoritative, exactly as before. Severity extraction is a heuristic, and
  // letting it flip a run green (a report whose findings all parse as minor)
  // would be a semantic change smuggled in behind a context fix.
  const proseIngestedCount = usedProseFallback
    ? ingestProseFindings({
        epicId: input.epicId,
        sinceIso: input.sinceIso,
        sessionOutput: input.sessionOutput,
        database,
      })
    : 0;

  const blockingFindings = collectBlockingFindings(
    input.epicId,
    input.sinceIso,
    database
  );
  const structuredVerdict = readStructuredReviewVerdict(
    input.reviewSessionId,
    database
  );

  if (structuredVerdict) {
    return {
      blocking:
        structuredVerdict === NEGATIVE_STRUCTURED_VERDICT ||
        blockingFindings.length > 0,
      blockingFindings,
      agentCommentCount,
      usedProseFallback: false,
      proseNegative,
      structuredVerdict,
      verdictSource: "structured",
      proseIngestedCount,
    };
  }

  return {
    blocking: usedProseFallback ? proseNegative : blockingFindings.length > 0,
    blockingFindings,
    agentCommentCount,
    usedProseFallback,
    proseNegative,
    structuredVerdict: null,
    verdictSource: "prose",
    proseIngestedCount,
  };
}

export interface ReviewVerdictDecision {
  /** True when the review asks for the ticket to go back to in_progress. */
  negative: boolean;
  /** Which channel decided, for the activity-log trail. */
  source: ReviewVerdictSource;
  structuredVerdict: StructuredReviewVerdict | null;
  blockingFindings: BlockingFinding[];
  proseNegative: boolean;
}

/**
 * Session-scoped verdict for the revert drivers — the review routes and the
 * pipeline's review terminal handler, which decide whether a finished review
 * sends its ticket back to `in_progress`.
 *
 * Differs from {@link assessReviewOutcome} in its fallback ONLY: with no
 * structured verdict this is a pure prose scan, because these call sites
 * never consulted findings rows and retro-compatibility is bit-for-bit. With
 * a structured verdict, the findings veto applies over the session's own
 * window (`sinceIso`, defaulted from the session row).
 */
export function resolveReviewVerdict(input: {
  epicId: string;
  reviewSessionId: string | null;
  sessionOutput: string;
  /** Findings window; defaults to the review session's start. */
  sinceIso?: string | null;
  database?: ArijDatabase;
}): ReviewVerdictDecision {
  const database = input.database ?? defaultDb;
  const proseNegative = isNegativeProseVerdict(input.sessionOutput);
  const structuredVerdict = readStructuredReviewVerdict(
    input.reviewSessionId,
    database
  );

  if (!structuredVerdict) {
    return {
      negative: proseNegative,
      source: "prose",
      structuredVerdict: null,
      blockingFindings: [],
      proseNegative,
    };
  }

  const sinceIso =
    input.sinceIso ??
    readSessionFindingsWindow(input.reviewSessionId, database);
  const blockingFindings = sinceIso
    ? collectBlockingFindings(input.epicId, sinceIso, database)
    : [];

  return {
    negative:
      structuredVerdict === NEGATIVE_STRUCTURED_VERDICT ||
      blockingFindings.length > 0,
    source: "structured",
    structuredVerdict,
    blockingFindings,
    proseNegative,
  };
}
