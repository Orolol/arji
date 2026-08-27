import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import { agentSessions, reviewComments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { sessionAtSql } from "@/lib/agent-sessions/session-time";
import {
  isMcpToolsEnabled,
  MCP_CAPABLE_PROVIDERS,
  MCP_CHANNEL_INJECTED,
  MCP_CHANNEL_UNAVAILABLE,
  parseMcpChannelRecord,
  providerSupportsMcp,
} from "@/lib/claude/mcp-injection";
import { parseReviewReport } from "./parse-review-report";

/**
 * Review-verdict assessment shared by the pipeline's review stage
 * (lib/pipeline/stages.ts) and the review routes.
 *
 * THREE channels, in strict priority order — plus one rule about SILENCE on
 * the first of them (see UNVERIFIABLE REVIEWS at the bottom).
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
 * UNVERIFIABLE REVIEWS. Channels 2 and 3 both read "the reviewer filed
 * nothing" as "the reviewer found nothing" — which is only sound when the
 * reviewer had no way to file. When the reviewer's provider DOES have the
 * structured channel (providerSupportsMcp + the mcp_tools_enabled toggle),
 * ran to a verdict, and NOTHING of it reached the database — no verdict on the session row and
 * no review_comments rows attributed to it — its silence is missing
 * evidence, not an approval: the tool call may have been rejected (a stale or
 * never-delivered MCP token 401s every call — see
 * lib/mcp/review-channel-failure.ts), or the reviewer may never have called
 * it. Either way the review is UNVERIFIABLE and blocks, because the
 * alternative is what this module was changed to stop: a review whose
 * findings never reached the database counting as clean and unlocking the
 * merge. A session that DID file rows proved its channel works, so it keeps
 * channels 2 and 3 verbatim.
 *
 * Retro-compatibility: a review session on a provider WITHOUT the channel —
 * or any session judged while `mcp_tools_enabled` is off — behaves
 * bit-for-bit as before this module gained channel 1. That is the whole
 * reason the prose fallback still exists.
 *
 * Timestamps are compared via Date.parse on BOTH sides so explicit ISO
 * strings (what submit_findings writes) and SQLite CURRENT_TIMESTAMP
 * defaults coexist. reviewComments is epic-keyed only, so the same queries
 * serve story-scoped runs.
 *
 * Finding RESOLUTION has two agent channels and one terminal one. The
 * reviewer of cycle N+1 is asked to verify each prior finding and report
 * `{id, status: "fixed"}` through `submit_findings.prior_findings` (the
 * structured channel, app/api/mcp/submit-findings/route.ts) — and to echo
 * `[RC:id] FIXED` lines in its report, which
 * {@link resolvePriorFindingsFromProse} parses when the structured channel
 * was unavailable. Whatever remains open at merge time is resolved by the
 * merge itself (lib/workflow/merge-approval.ts): the merge IS the approval.
 */

export interface BlockingFinding {
  id: string;
  filePath: string;
  lineNumber: number;
  body: string;
  severity: "critical" | "major";
}

/** Body prefixes (as written by submit-findings) that block the pipeline. */
const BLOCKING_PREFIXES: ReadonlyArray<{
  prefix: string;
  severity: BlockingFinding["severity"];
}> = [
  { prefix: "[critical]", severity: "critical" },
  { prefix: "[major]", severity: "major" },
];

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
    const match = BLOCKING_PREFIXES.find(({ prefix }) =>
      row.body.startsWith(prefix)
    );
    if (!match) continue;
    findings.push({
      id: row.id,
      filePath: row.filePath,
      lineNumber: row.lineNumber,
      body: row.body,
      severity: match.severity,
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Channel 1 — the structured verdict                                  */
/* ------------------------------------------------------------------ */

/**
 * The `verdict` vocabulary of the submit_findings tool, verbatim (the enum
 * lives in app/api/mcp/submit-findings/route.ts and bin/arij-mcp.mjs).
 */
export const STRUCTURED_REVIEW_VERDICTS = [
  "approved",
  "approved_with_minor_issues",
  "changes_requested",
] as const;

export type StructuredReviewVerdict =
  (typeof STRUCTURED_REVIEW_VERDICTS)[number];

/** The only verdict that blocks on its own. */
export const NEGATIVE_STRUCTURED_VERDICT: StructuredReviewVerdict =
  "changes_requested";

/**
 * Which channel produced a verdict, for the activity-log trail.
 *
 * `unverifiable` is not a channel the reviewer used — it is the ABSENCE of
 * the structured one on a provider that had it.
 */
export type ReviewVerdictSource = "structured" | "prose" | "unverifiable";

function isStructuredReviewVerdict(
  value: string | null | undefined
): value is StructuredReviewVerdict {
  return (
    typeof value === "string" &&
    (STRUCTURED_REVIEW_VERDICTS as readonly string[]).includes(value)
  );
}

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

/* ------------------------------------------------------------------ */
/* The silence rule — unverifiable reviews                             */
/* ------------------------------------------------------------------ */

/**
 * The agent types that ARE a review for gate purposes — the same four the
 * Full Auto merge gate counts (lib/auto-mode/select.ts). Deliberately not the
 * looser `includes("review")` the workflow context uses for its floor guard,
 * and deliberately without `review_second_opinion`, which is a merge gate
 * with its own prose fail-safe.
 */
export const ORDINARY_REVIEW_AGENT_TYPES = [
  "review_security",
  "review_code",
  "review_compliance",
  "review_feature",
] as const;

/** `['a','b']` → `'a','b'`, for the SQL `IN (…)` lists below. */
function sqlLiteralList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(",");
}

/** True for the four agent types the review gates count. */
export function isOrdinaryReviewAgentType(
  agentType: string | null | undefined
): boolean {
  return (
    typeof agentType === "string" &&
    (ORDINARY_REVIEW_AGENT_TYPES as readonly string[]).includes(agentType)
  );
}

/** Structured verdicts that let a review pass on its own. */
export const POSITIVE_STRUCTURED_VERDICTS: ReadonlyArray<StructuredReviewVerdict> =
  ["approved", "approved_with_minor_issues"];

/**
 * What the structured channel was worth for one review session.
 *
 * `mcpCapable` is the question the whole rule turns on: could this session
 * have called `submit_findings` at all?
 *
 * The answer comes from `agent_sessions.mcp_channel` — what Arij RECORDED at
 * spawn time (migration 0041) — and only falls back to re-deriving it from
 * the provider list when the row has no record. That order matters: injection
 * degrades silently in two places (processManager.start catches every
 * injection error, prepareClaudeSpawn drops --mcp-config on a temp-file
 * failure), and in both the child never reaches the HTTP route, so no 401
 * fires either. Reconstructing from the provider would judge such a review
 * unverifiable and tell the operator its reviewer "filed no verdict" — for a
 * tool that session was never handed.
 *
 * The fallback for rows with no record (every session from before 0041) is
 * the provider's injection surface AND the global `mcp_tools_enabled`
 * toggle, exactly the two conditions lib/claude/mcp-injection.ts applies
 * when it decides whether to wire the channel up. Reading the toggle at
 * judgement time rather than persisting it per session is deliberate there:
 * an operator who turns the channel off must not find every RECORDLESS epic
 * suddenly unmergeable for want of a verdict nobody can produce any more.
 *
 * That escape does NOT reach rows carrying a record, and should not: a
 * session recorded `injected` genuinely had the tool when it ran, whatever
 * the toggle says today. Turning the channel off therefore unblocks future
 * work (new sessions record `unavailable`) rather than retroactively
 * absolving past silence — the only way to clear an epic already judged is to
 * review it again.
 *
 * `provedChannelWithRows` is the escape hatch that keeps the rule about the
 * CHANNEL rather than about the reviewer's manners. A session with
 * review_comments rows of its own has proved the channel worked for it; a
 * missing verdict is then the reviewer's own omission, and the pre-existing
 * findings veto and prose fallback are exactly the right tools for it. Only
 * total silence — no verdict AND no rows — is evidence that nothing got
 * through.
 *
 * It is only ever computed on the no-verdict path, and says so in its name:
 * a review that filed a verdict is not asked the question, because nothing
 * downstream needs the answer. Reading it as "this session filed rows" would
 * be wrong for every healthy review.
 *
 * `isOrdinaryReview` bounds the rule to the four review types the gates count.
 * `review_second_opinion` is deliberately outside it: that session is a Full
 * Auto merge gate with its own PROSE fail-safe (`readSecondOpinionState`
 * accepts an `Overall Verdict:` line), so an APPROVING gate routinely carries
 * no structured verdict and no findings rows — the exact shape this rule
 * refuses. Judging it here would charge an approving gate as a failure and
 * park the epic it had just cleared. The exemption lives in the rule rather
 * than in each caller because it has already been missed once that way.
 *
 * `delivered` bounds the rule to reviews that actually RAN to a verdict:
 * `status = completed` and `outcome = answered`. A failed, cancelled, silent
 * or still-running review never claimed to have found nothing in the first
 * place — it is already handled as a failed attempt by the retry ladder and
 * already excluded from the merge gate — so calling it unverifiable would
 * only add a second, redundant refusal on top. Legacy rows with a NULL
 * outcome predate classification and keep their pre-existing treatment.
 */
export interface ReviewChannelState {
  sessionId: string;
  provider: string;
  structuredVerdict: StructuredReviewVerdict | null;
  /** The agent type is one of the four the gates count as a review. */
  isOrdinaryReview: boolean;
  /** The session had a structured channel to file its verdict on. */
  mcpCapable: boolean;
  /**
   * What Arij recorded at spawn time, or null for a row that predates the
   * column. `unavailable` is the case the rule must NOT punish.
   */
  channelRecord: "injected" | "unavailable" | null;
  /**
   * Only meaningful on the no-verdict path: true when the session filed
   * review_comments rows of its own, which proves its channel worked. False
   * everywhere else INCLUDING for reviews that filed a verdict — the query
   * is skipped there because no caller needs it.
   */
  provedChannelWithRows: boolean;
  /** The session ran to a verdict: completed AND outcome `answered`. */
  delivered: boolean;
  /**
   * Had the channel and got nothing through it — no verdict, no rows. The
   * silence that must not read as "reviewed, found nothing".
   */
  unverifiable: boolean;
}

/**
 * The channel state of a review session, or null when there is no session to
 * judge (no id, or a row that no longer exists). A null return means "no
 * opinion" and leaves every caller on its pre-existing path.
 *
 * The provider column defaults to 'claude-code' in the schema and is NULL on
 * rows old enough to predate it; both are read as claude-code so a legacy
 * row is judged the way the session that wrote it actually ran.
 */
export function readReviewChannelState(
  sessionId: string | null | undefined,
  database: ArijDatabase = defaultDb
): ReviewChannelState | null {
  if (!sessionId) return null;
  const row = database
    .select({
      provider: agentSessions.provider,
      reviewVerdict: agentSessions.reviewVerdict,
      status: agentSessions.status,
      outcome: agentSessions.outcome,
      mcpChannel: agentSessions.mcpChannel,
      agentType: agentSessions.agentType,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  if (!row) return null;

  const provider = row.provider ?? "claude-code";
  const isOrdinaryReview = isOrdinaryReviewAgentType(row.agentType);
  const delivered = row.status === "completed" && row.outcome === "answered";
  const structuredVerdict = isStructuredReviewVerdict(row.reviewVerdict)
    ? row.reviewVerdict
    : null;
  const channelRecord = parseMcpChannelRecord(row.mcpChannel);
  const mcpCapable =
    channelRecord === null
      ? providerSupportsMcp(provider) && isMcpToolsEnabled(database)
      : channelRecord === MCP_CHANNEL_INJECTED;
  const provedChannelWithRows =
    isOrdinaryReview && mcpCapable && delivered && structuredVerdict === null
      ? database
          .select({ id: reviewComments.id })
          .from(reviewComments)
          .where(eq(reviewComments.agentSessionId, sessionId))
          .get() !== undefined
      : false;

  return {
    sessionId,
    provider,
    structuredVerdict,
    isOrdinaryReview,
    mcpCapable,
    channelRecord,
    provedChannelWithRows,
    delivered,
    unverifiable:
      isOrdinaryReview &&
      mcpCapable &&
      delivered &&
      structuredVerdict === null &&
      !provedChannelWithRows,
  };
}

/** The session columns the rule needs — what a caller usually already holds. */
export interface ReviewChannelRow {
  id: string;
  provider: string | null;
  reviewVerdict: string | null;
  status: string | null;
  outcome: string | null;
  mcpChannel: string | null;
  agentType: string | null;
}

/**
 * Batch form of the rule, for callers that already hold the session rows.
 *
 * The per-session helper costs three queries each (the row, the settings
 * toggle, and sometimes the review_comments probe), which a caller looping
 * over an epic's reviews pays over and over against tables with no useful
 * index — agent_sessions has none, and review_comments is indexed on
 * (epic_id, file_path), not agent_session_id. This reads the toggle once and
 * probes review_comments once for the whole set.
 *
 * Returns the ids of the rows that are unverifiable; everything else is
 * verifiable by elimination.
 */
export function selectUnverifiableReviewSessionIds(
  rows: ReviewChannelRow[],
  database: ArijDatabase = defaultDb
): Set<string> {
  if (rows.length === 0) return new Set();

  // Read once, and only if a row actually needs the fallback — a board whose
  // sessions all carry a channel record never touches the settings table.
  let toggle: boolean | null = null;
  const mcpToolsEnabled = () => (toggle ??= isMcpToolsEnabled(database));

  const candidates = rows.filter((row) => {
    if (!isOrdinaryReviewAgentType(row.agentType)) return false;
    if (row.status !== "completed" || row.outcome !== "answered") return false;
    if (isStructuredReviewVerdict(row.reviewVerdict)) return false;
    const record = parseMcpChannelRecord(row.mcpChannel);
    if (record !== null) return record === MCP_CHANNEL_INJECTED;
    return (
      providerSupportsMcp(row.provider ?? "claude-code") && mcpToolsEnabled()
    );
  });
  if (candidates.length === 0) return new Set();

  const provedChannel = new Set(
    database
      .select({ agentSessionId: reviewComments.agentSessionId })
      .from(reviewComments)
      .where(
        inArray(
          reviewComments.agentSessionId,
          candidates.map((row) => row.id)
        )
      )
      .all()
      .map((row) => row.agentSessionId)
      .filter((id): id is string => id !== null)
  );

  return new Set(
    candidates.filter((row) => !provedChannel.has(row.id)).map((row) => row.id)
  );
}

/**
 * Convenience predicate for callers that only need the verdict of the rule
 * (the workflow context, the board's Review column).
 */
export function isReviewSessionUnverifiable(
  sessionId: string | null | undefined,
  database: ArijDatabase = defaultDb
): boolean {
  return readReviewChannelState(sessionId, database)?.unverifiable ?? false;
}

/**
 * The gating predicate as SQL: "is this review row CLEAN?".
 *
 * The JS side of this rule ({@link readReviewChannelState}) cannot serve the
 * Full Auto merge gate, which asks the question of every session row of a
 * project inside one conditional aggregation. So the predicate has a second
 * expression — and the two disagreeing is not a cosmetic problem. When
 * findings.ts says "verifiable" and the merge gate says "not clean", nothing
 * charges the review (`reconcileInFlight` only charges an unverifiable one)
 * and `needsReview` stays true every sweep: a reviewer dispatched forever on
 * an epic that never parks. That is exactly what `mcp_channel = 'unavailable'`
 * produced while only findings.ts read the column.
 *
 * The invariant, pinned by __tests__/review-gate-consistency.test.ts:
 *
 *     clean  ==  !unverifiable  &&  verdict != 'changes_requested'
 *
 * so the SQL below is the negation of the same four conditions the JS side
 * applies — ordinary review type, channel actually had, no structured
 * verdict, no findings rows of its own — with the explicit `changes_requested`
 * no on top.
 */
export function cleanReviewVerdictSql(database: ArijDatabase = defaultDb) {
  const mcpToolsEnabled = isMcpToolsEnabled(database);

  // Same precedence as readReviewChannelState: the recorded wiring first, the
  // provider reconstruction only for rows written before the column existed.
  const hadChannel = sql`(CASE
    WHEN ${agentSessions.mcpChannel} = ${MCP_CHANNEL_INJECTED} THEN 1
    WHEN ${agentSessions.mcpChannel} = ${MCP_CHANNEL_UNAVAILABLE} THEN 0
    WHEN ${mcpToolsEnabled ? sql`1` : sql`0`} = 1
     AND COALESCE(${agentSessions.provider}, 'claude-code')
         IN (${sql.raw(sqlLiteralList(MCP_CAPABLE_PROVIDERS))}) THEN 1
    ELSE 0
  END)`;

  // COALESCE, not a bare IN: a NULL verdict makes `IN (…)` NULL, and SQLite
  // would then propagate NULL through the whole conjunction. The final answer
  // happens to come out right today because NULL reads as falsy in the CASE
  // above it — but "no verdict" must be an explicit FALSE here, or the next
  // term added to this expression inherits an accident.
  const hasStructuredVerdict = sql`COALESCE(${agentSessions.reviewVerdict} IN (${sql.raw(
    sqlLiteralList(STRUCTURED_REVIEW_VERDICTS)
  )}), 0) = 1`;

  // The escape hatch, correlated on the session: rows of its own prove the
  // channel worked for it. Open ones still block the merge separately, via
  // the board's open-review-comment count.
  const provedChannelWithRows = sql`EXISTS (
    SELECT 1 FROM ${reviewComments}
    WHERE ${reviewComments.agentSessionId} = ${agentSessions.id}
  )`;

  // COALESCE'd for the same reason as the verdict term above: a NULL
  // agent_type would make this NULL, NULL through the conjunction, and the
  // whole predicate NULL — which the enclosing CASE reads as "not clean".
  // Latent while the only caller pre-filters by agent type, but this is an
  // exported predicate and the next caller inherits whatever is written here.
  const isOrdinaryReview = sql`COALESCE(${agentSessions.agentType} IN (${sql.raw(
    sqlLiteralList(ORDINARY_REVIEW_AGENT_TYPES)
  )}), 0) = 1`;

  const unverifiable = sql`(${isOrdinaryReview}
    AND ${hadChannel} = 1
    AND NOT ${hasStructuredVerdict}
    AND NOT ${provedChannelWithRows})`;

  return sql`(NOT ${unverifiable}
    AND (${agentSessions.reviewVerdict} IS NULL
         OR ${agentSessions.reviewVerdict} <> ${NEGATIVE_STRUCTURED_VERDICT}))`;
}

/**
 * The epics of a project whose LATEST delivered review is unverifiable —
 * the board's read model for the Review column's blocking reason.
 *
 * Latest, not any: an epic re-reviewed after a broken round is no longer
 * blocked by the broken one, and the column should say so the moment the
 * channel comes back. Note the deliberate asymmetry with the workflow
 * engine's guard, which accepts ANY verifiable completed review ever: an epic
 * reviewed cleanly and then re-reviewed on a broken channel shows the badge
 * while `review → done` still passes. The badge speaks for the merge gate and
 * for what Full Auto will do next, which is what the Review column is about;
 * it is not a restatement of the approval guard.
 *
 * Scoped to the four ORDINARY review types. `review_second_opinion` is a
 * Full Auto merge gate, not a review: the merge gate does not count it
 * (lib/auto-mode/select.ts), and it is allowed to answer through a prose
 * fail-safe, so judging it by the structured channel would badge
 * "unverifiable" on an epic the merge gate is perfectly happy to land.
 *
 * Two queries regardless of board size, which is why this exists instead of
 * calling {@link readReviewChannelState} per epic: one window-function scan
 * for the newest delivered epic-scoped review per epic, and one `IN` lookup
 * that drops the sessions which did file rows. Callers that already hold a
 * single session id should still use readReviewChannelState.
 */
export function listUnverifiableReviewEpicIds(
  projectId: string,
  database: ArijDatabase = defaultDb
): Set<string> {
  const mcpToolsEnabled = isMcpToolsEnabled(database);

  const ranked = database
    .select({
      epicId: agentSessions.epicId,
      sessionId: agentSessions.id,
      provider: agentSessions.provider,
      reviewVerdict: agentSessions.reviewVerdict,
      mcpChannel: agentSessions.mcpChannel,
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${agentSessions.epicId}
        ORDER BY ${sessionAtSql()} DESC, ${agentSessions.id} DESC
      )`.as("review_row_num"),
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        sql`${agentSessions.epicId} IS NOT NULL`,
        sql`${agentSessions.userStoryId} IS NULL`,
        eq(agentSessions.status, "completed"),
        eq(agentSessions.outcome, "answered"),
        inArray(agentSessions.agentType, [...ORDINARY_REVIEW_AGENT_TYPES])
      )
    )
    .as("ranked_reviews");

  const latest = database
    .select({
      epicId: ranked.epicId,
      sessionId: ranked.sessionId,
      provider: ranked.provider,
      reviewVerdict: ranked.reviewVerdict,
      mcpChannel: ranked.mcpChannel,
    })
    .from(ranked)
    .where(eq(ranked.rowNum, 1))
    .all();

  // Same capability rule readReviewChannelState applies, row by row: the
  // recorded wiring first, the provider reconstruction only where there is
  // no record.
  const candidates = latest.filter((row) => {
    if (row.epicId === null) return false;
    if (isStructuredReviewVerdict(row.reviewVerdict)) return false;
    const record = parseMcpChannelRecord(row.mcpChannel);
    if (record !== null) return record === MCP_CHANNEL_INJECTED;
    return mcpToolsEnabled && providerSupportsMcp(row.provider ?? "claude-code");
  });
  if (candidates.length === 0) return new Set();

  // A session with rows of its own proved the channel worked — same escape
  // hatch readReviewChannelState applies.
  const filed = new Set(
    database
      .select({ agentSessionId: reviewComments.agentSessionId })
      .from(reviewComments)
      .where(
        inArray(
          reviewComments.agentSessionId,
          candidates.map((row) => row.sessionId)
        )
      )
      .all()
      .map((row) => row.agentSessionId)
      .filter((id): id is string => id !== null)
  );

  return new Set(
    candidates
      .filter((row) => !filed.has(row.sessionId))
      .map((row) => row.epicId as string)
  );
}

/**
 * The single sentence every unverifiable-review refusal shows. It names the
 * tool because that is the actionable part: the reviewer's `submit_findings`
 * call never landed, so there is nothing to trust and the fix is another
 * review, not another opinion.
 */
export const UNVERIFIABLE_REVIEW_REASON =
  "the reviewer filed no structured verdict through submit_findings, so its review cannot be verified";

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
  /**
   * The review session the report came from. Recorded on the recovered rows
   * so the session "proves its channel" exactly like a submit_findings call
   * would — without it the review stayed `unverifiable` even though its
   * findings were recovered, and telescope/dreaming could not attribute them.
   */
  sessionId?: string | null;
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

  // Dedup against rows from EARLIER windows: a reviewer that repeats an
  // unfixed finding verbatim on cycle N+1 must not mint a second open row —
  // that was the duplicate-accumulation path nothing ever resolved.
  const existingOpen = new Set(
    database
      .select({
        filePath: reviewComments.filePath,
        lineNumber: reviewComments.lineNumber,
        body: reviewComments.body,
      })
      .from(reviewComments)
      .where(
        and(
          eq(reviewComments.epicId, input.epicId),
          eq(reviewComments.author, "agent"),
          eq(reviewComments.status, "open")
        )
      )
      .all()
      .map((row) => `${row.filePath}:${row.lineNumber}:${row.body}`)
  );

  const now = new Date().toISOString();
  let created = 0;
  for (const finding of parsed) {
    const body = `[${finding.severity}] ${finding.body}`;
    const key = `${finding.filePath}:${finding.lineNumber}:${body}`;
    if (existingOpen.has(key)) continue;
    existingOpen.add(key);
    database
      .insert(reviewComments)
      .values({
        id: createId(),
        epicId: input.epicId,
        filePath: finding.filePath,
        lineNumber: finding.lineNumber,
        body,
        author: "agent",
        status: "open",
        agentSessionId: input.sessionId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    created += 1;
  }

  return created;
}

/**
 * `[RC:id] FIXED` / `[RC:id] STILL OPEN` lines in a review report — the
 * prose fallback of the structured `submit_findings.prior_findings` channel.
 * The prior-findings prompt section (lib/pipeline/stages.ts) asks the
 * reviewer for both; a reviewer on an MCP-less provider only produces this
 * one. Backticks and simple separators around the token are tolerated.
 */
const PRIOR_FINDING_VERDICT_RE =
  /\[RC:([A-Za-z0-9_-]+)\]`?\s*(?:[-—:*]+\s*)?\**(FIXED|STILL OPEN)\**/gi;

/**
 * Resolve the epic's prior findings a review report declares FIXED.
 *
 * Only open, agent-authored rows of THIS epic are touched, so a hallucinated
 * or stale id no-ops. Rows already resolved through the structured channel
 * are skipped by the same status filter. Returns the resolved ids.
 */
export function resolvePriorFindingsFromProse(input: {
  epicId: string;
  sessionOutput: string;
  database?: ArijDatabase;
}): string[] {
  const database = input.database ?? defaultDb;
  const fixedIds = new Set<string>();
  for (const match of input.sessionOutput.matchAll(PRIOR_FINDING_VERDICT_RE)) {
    if (match[2].toUpperCase() === "FIXED") fixedIds.add(match[1]);
  }
  if (fixedIds.size === 0) return [];

  const now = new Date().toISOString();
  const resolved: string[] = [];
  for (const id of fixedIds) {
    const row = database
      .select({
        id: reviewComments.id,
        epicId: reviewComments.epicId,
        status: reviewComments.status,
        author: reviewComments.author,
      })
      .from(reviewComments)
      .where(eq(reviewComments.id, id))
      .get();
    if (!row || row.epicId !== input.epicId) continue;
    if (row.author !== "agent" || row.status !== "open") continue;
    database
      .update(reviewComments)
      .set({ status: "resolved", updatedAt: now })
      .where(eq(reviewComments.id, id))
      .run();
    resolved.push(id);
  }
  return resolved;
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
  /**
   * True when the reviewer had the structured channel and filed no verdict
   * on it — the review is unverifiable and blocks for that reason alone.
   */
  unverifiable: boolean;
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
 * pre-existing fallback branch, not a channel an agent chose deliberately;
 * `unverifiable` means no channel decided at all and the silence itself did.
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

  // Prior findings the report declares FIXED are resolved first — the prose
  // fallback of submit_findings.prior_findings. Scoped to pre-window rows by
  // construction (an [RC:id] token only exists for a finding the prompt
  // listed), so this never touches the verdict below.
  resolvePriorFindingsFromProse({
    epicId: input.epicId,
    sessionOutput: input.sessionOutput,
    database,
  });

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
        sessionId: input.reviewSessionId ?? null,
        database,
      })
    : 0;

  const blockingFindings = collectBlockingFindings(
    input.epicId,
    input.sinceIso,
    database
  );
  const channel = readReviewChannelState(input.reviewSessionId, database);
  const structuredVerdict = channel?.structuredVerdict ?? null;

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
      unverifiable: false,
      verdictSource: "structured",
      proseIngestedCount,
    };
  }

  // The reviewer could have spoken through the tool and did not. Neither the
  // findings veto nor the prose scan can distinguish that from "found
  // nothing", so neither gets to decide: the review blocks as unverifiable
  // and the run earns a fresh one. Any recovered findings still ride along —
  // they are the next builder's context even though they did not decide.
  if (channel?.unverifiable) {
    return {
      blocking: true,
      blockingFindings,
      agentCommentCount,
      usedProseFallback: false,
      proseNegative,
      structuredVerdict: null,
      unverifiable: true,
      verdictSource: "unverifiable",
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
    unverifiable: false,
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
  /** The reviewer had the structured channel and filed no verdict on it. */
  unverifiable: boolean;
}

/**
 * Session-scoped verdict for the revert drivers — the review routes and the
 * pipeline's review terminal handler, which decide whether a finished review
 * sends its ticket back to `in_progress`.
 *
 * Differs from {@link assessReviewOutcome} in its fallback ONLY: with no
 * structured verdict AND no structured channel, this is a pure prose scan,
 * because these call sites never consulted findings rows and
 * retro-compatibility is bit-for-bit. With a structured verdict, the
 * findings veto applies over the session's own window (`sinceIso`,
 * defaulted from the session row).
 *
 * An UNVERIFIABLE review is reported (`unverifiable: true`) but is NOT
 * negative. These call sites are the revert drivers: negative means "send the
 * ticket back to in_progress", i.e. dispatch a code agent. An unverifiable
 * review says nothing about the code — no finding was filed — so bouncing it
 * would put a builder on a branch nothing faulted, and the completed session
 * would clear the failure streak on the way past. The ticket stays in Review,
 * un-mergeable (the merge gate and `review → done` both refuse it), and earns
 * another REVIEW: the pipeline's stage ladder re-runs it, Full Auto's
 * needsReview re-dispatches it, and Full Auto's reconciler charges it so
 * three of them park the epic instead of looping.
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
  const channel = readReviewChannelState(input.reviewSessionId, database);
  const structuredVerdict = channel?.structuredVerdict ?? null;

  if (!structuredVerdict) {
    if (channel?.unverifiable) {
      return {
        negative: false,
        source: "unverifiable",
        structuredVerdict: null,
        blockingFindings: [],
        proseNegative,
        unverifiable: true,
      };
    }
    return {
      negative: proseNegative,
      source: "prose",
      structuredVerdict: null,
      blockingFindings: [],
      proseNegative,
      unverifiable: false,
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
    unverifiable: false,
  };
}
