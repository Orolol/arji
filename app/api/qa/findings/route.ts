import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  agentSessions,
  customReviewAgents,
  epics,
  projects,
  qaReports,
  reviewComments,
  ticketActivityLog,
} from "@/lib/db/schema";
import { REVIEW_CHECKLISTS } from "@/lib/claude/prompt-sections";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import { sessionAtSql } from "@/lib/agent-sessions/session-time";
import { NON_TERMINAL_STATUSES } from "@/lib/agent-sessions/lifecycle-status";
import { BLOCKING_FINDING_PREFIXES } from "@/lib/review/finding-severity";
import {
  ORDINARY_REVIEW_AGENT_TYPES,
  isOrdinaryReviewAgentType,
  listUnverifiableReviewEpicIds,
} from "@/lib/pipeline/findings";
import { blocksMergeSql } from "@/lib/workflow/blocking-findings";
import { epicSessionFactsCte } from "@/lib/workflow/review-freshness";
import { isBuildableStatus } from "@/lib/types/kanban";
import {
  compareFindings,
  deriveChecks,
  deriveCoverage,
  deriveQueued,
  deriveRuns,
  deriveVerdicts,
  rubricItemsFromChecklist,
  severityOf,
  type QaVerdictCopy,
  stripSeverityPrefix,
  type QaFilingCounts,
  type QaSessionRow,
  type QaVerdictEpic,
  type QaVerdictSessionRow,
} from "@/lib/qa/aggregate";
import { resolveRequestUiLocale } from "@/lib/i18n/resolve-request-locale";
import { translatorFor } from "@/lib/i18n/translator";
import {
  QA_CHECK_LIMIT,
  QA_CHECK_SUMMARY_LIMIT,
  QA_COVERAGE_DAYS,
  QA_LOG_LINE_LIMIT,
  QA_VERDICT_DAYS,
  type QaFinding,
  type QaPayload,
  type QaReviewTarget,
} from "@/lib/qa/types";

/**
 * GET /api/qa/findings — everything frame 11b shows, for every project.
 *
 * WHY ONE ROUTE, AND WHY IT IS SHAPED LIKE THE DESK'S. better-sqlite3 is
 * synchronous on ONE shared connection (`lib/db/index.ts`): a slow query here
 * stalls SSE and every other request for the whole app. `app/api/control-desk/
 * route.ts` worked out the scan discipline for a cross-project read and this
 * route copies it rather than inventing a second one:
 *
 * - `agent_sessions` has exactly TWO secondary indexes, `(project_id,
 *   created_at)` and `(epic_id)`. A bare `created_at >= cutoff` prunes NOTHING
 *   — `created_at` is the second column of a composite whose first column is
 *   unconstrained — so the verdict scan carries `project_id IN (…)` beside its
 *   cutoff. Measured on the developer's board, that one clause is 12.0 ms ->
 *   0.26 ms.
 * - `review_comments` is indexed `(epic_id, file_path)` and `(agent_session_id)`
 *   and NOT on `status`, so `WHERE status = 'open'` alone is a table scan. Every
 *   read here is bounded by `epic_id IN (…)` or `agent_session_id IN (…)`.
 * - NEVER SELECT `agent_sessions.prompt`. It averages 77 KB and reaches 1.8 MB,
 *   and this route is polled. Nothing on 11b needs it.
 * - `last_non_empty_text` is UNCAPPED at the write side, so the log line is
 *   `substr(…, 1, QA_LOG_LINE_LIMIT)` IN SQL — never the raw column.
 *
 * The ONE deliberately unindexed scan is the running/queued session read, for
 * the reason the desk states: `status` carries no index, but the answer must
 * not be truncated and the projection is narrow.
 *
 * WHAT THIS ROUTE DOES NOT DECIDE. "Does this finding block?" is
 * `blocksMergeSql` (`lib/workflow/blocking-findings.ts`), evaluated in SQL over
 * the same supersession cutoff the board, Full Auto and the merge gate read. A
 * second copy of that rule in JavaScript is exactly how a card starts claiming
 * "clean" for a ticket the supervisor refuses.
 */

/** Lexicographic floor for both timestamp shapes stored in these columns. */
function cutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * `SUBSTR(body, 1, n) = '[critical]' OR …` — the blocking half of the severity
 * vocabulary, in SQL.
 *
 * This is the stamp-weight question ("how many of the rows this session filed
 * were heavy?"), not the merge question, so it is deliberately NOT
 * `blocksMergeSql`: that predicate needs a per-epic supersession cutoff and
 * answers about the epic's merge, while this counts what one live reviewer has
 * put on the table so far. Same case-sensitive prefixes, same COALESCE, so the
 * two can never disagree about what "[major]" is.
 */
function blockingPrefixSql(): SQL {
  const [first, ...rest] = BLOCKING_FINDING_PREFIXES.map(
    ({ prefix }) =>
      sql`SUBSTR(COALESCE(${reviewComments.body}, ''), 1, ${sql.raw(String(prefix.length))}) = ${prefix}`,
  );
  return rest.reduce<SQL>((acc, next) => sql`${acc} OR ${next}`, first);
}

/**
 * `1` when this `qa_reports` row is a check that is genuinely still going.
 *
 * The SQL twin of `isCheckLive` (`lib/qa/aggregate.ts`), and it must stay a
 * twin: the ordering, the row flag and the totals all read this one expression,
 * and a JavaScript answer that disagreed with the SQL one would sort the band
 * by a different rule than it paints it by. Requires the `agent_sessions` LEFT
 * JOIN to be in scope; a `NULL` session status fails the `IN` and yields `0`,
 * which is the wanted answer for a report whose session is gone.
 */
function liveCheckSql(): SQL<number> {
  return sql<number>`CASE WHEN ${qaReports.status} = 'running'
    AND ${agentSessions.status} IN (${sql.raw(NON_TERMINAL_SESSION_SQL)})
    THEN 1 ELSE 0 END`;
}

/** `'queued','running'` — `NON_TERMINAL_STATUSES` as a SQL list literal. */
const NON_TERMINAL_SESSION_SQL = NON_TERMINAL_STATUSES.map(
  (status) => `'${status}'`,
).join(",");

/** The empty answer, so a fresh install renders four folded label lines. */
function emptyPayload(now: Date): QaPayload {
  return {
    generatedAt: now.toISOString(),
    projects: [],
    runs: [],
    queued: [],
    findings: [],
    verdicts: [],
    rubric: {
      items: rubricItemsFromChecklist(REVIEW_CHECKLISTS.feature_review),
      projectRuleCount: 0,
    },
    reviewable: [],
    checks: [],
    checkTotals: {},
    checkableProjectIds: [],
    coveragePercent: null,
  };
}

export async function GET() {
  const queryStartedAt = Date.now();
  const now = new Date();
  const verdictCutoff = cutoff(now, QA_VERDICT_DAYS);
  const coverageCutoff = cutoff(now, QA_COVERAGE_DAYS);

  /* ---- 1. projects -------------------------------------------------- */

  const projectRows = db
    .select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
      // Not shown anywhere: it is the ONE fact that decides whether the "New
      // check" button may offer this project, because the check route is
      // `getProjectOr404(..., { requireGitRepo: true })` and 400s without it.
      gitRepoPath: projects.gitRepoPath,
    })
    .from(projects)
    .all();

  if (projectRows.length === 0) {
    return NextResponse.json({ data: emptyPayload(now) });
  }

  /**
   * The `project_id IN (…)` bound every cross-project session scan carries.
   * It is not a filter — `agent_sessions.project_id` is NOT NULL with a
   * cascading FK — it is the leading column of the one composite index.
   */
  const projectIds = projectRows.map((row) => row.id);

  /* ---- 2. epics ----------------------------------------------------- */

  const epicRows = db
    .select({
      id: epics.id,
      projectId: epics.projectId,
      title: epics.title,
      readableId: epics.readableId,
      status: epics.status,
    })
    .from(epics)
    .innerJoin(projects, eq(epics.projectId, projects.id))
    .all();

  const epicIds = epicRows.map((row) => row.id);
  const epicsById = new Map(epicRows.map((row) => [row.id, row]));

  /* ---- 3. open findings --------------------------------------------- */

  // `body` is capped at 2000 chars by submit_findings' zod schema, so it is
  // safe to select whole — unlike `ticket_comments.content`, which is uncapped.
  const findingRows =
    epicIds.length === 0
      ? []
      : db
          .select({
            id: reviewComments.id,
            epicId: reviewComments.epicId,
            filePath: reviewComments.filePath,
            lineNumber: reviewComments.lineNumber,
            body: reviewComments.body,
            author: reviewComments.author,
            agentSessionId: reviewComments.agentSessionId,
            createdAt: reviewComments.createdAt,
          })
          .from(reviewComments)
          .where(
            and(
              inArray(reviewComments.epicId, epicIds),
              eq(reviewComments.status, "open"),
            ),
          )
          .all();

  /* ---- 4. supersession, for the `blocking` flag only ----------------- */

  const factEpicIds = [...new Set(findingRows.map((row) => row.epicId))];
  const blockingFindingIds = new Set<string>();

  if (factEpicIds.length > 0) {
    const epicSessionFacts = epicSessionFactsCte(db, null, { epicIds: factEpicIds });
    const blockingRows = db
      .with(epicSessionFacts)
      .select({
        id: reviewComments.id,
        blocking:
          sql<number>`CASE WHEN ${blocksMergeSql(epicSessionFacts.supersessionAt)} THEN 1 ELSE 0 END`.as(
            "blocks_merge",
          ),
      })
      .from(reviewComments)
      .leftJoin(
        epicSessionFacts,
        eq(epicSessionFacts.epicId, reviewComments.epicId),
      )
      .where(
        and(
          inArray(reviewComments.epicId, factEpicIds),
          eq(reviewComments.status, "open"),
        ),
      )
      .all();

    for (const row of blockingRows) {
      if (Number(row.blocking) === 1) blockingFindingIds.add(row.id);
    }
  }

  /* ---- 5. the sessions that filed those findings --------------------- */

  const filingSessionIds = [
    ...new Set(
      findingRows
        .map((row) => row.agentSessionId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];

  const filingSessions =
    filingSessionIds.length === 0
      ? []
      : db
          .select({
            id: agentSessions.id,
            agentType: agentSessions.agentType,
            namedAgentName: agentSessions.namedAgentName,
          })
          .from(agentSessions)
          .where(inArray(agentSessions.id, filingSessionIds))
          .all();

  const filingSessionsById = new Map(filingSessions.map((row) => [row.id, row]));

  /* ---- 6. runs (the one deliberately unindexed scan) ----------------- */

  const activeRows = db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      epicId: agentSessions.epicId,
      status: agentSessions.status,
      agentType: agentSessions.agentType,
      namedAgentName: agentSessions.namedAgentName,
      startedAt: agentSessions.startedAt,
      createdAt: agentSessions.createdAt,
      lastLine: sql<
        string | null
      >`substr(${agentSessions.lastNonEmptyText}, 1, ${QA_LOG_LINE_LIMIT})`.as(
        "last_line",
      ),
      epicTitle: epics.title,
      epicReadableId: epics.readableId,
    })
    .from(agentSessions)
    .leftJoin(epics, eq(agentSessions.epicId, epics.id))
    .where(inArray(agentSessions.status, ["running", "queued"]))
    .all();

  // `review_second_opinion` is excluded on purpose: it is a Full Auto merge
  // gate with its own prose fail-safe, not a review. Same scope as every other
  // review gate in the app.
  const reviewRows: QaSessionRow[] = activeRows.filter((row) =>
    isOrdinaryReviewAgentType(row.agentType),
  );

  /** Any session owning a ticket, queued included — the review route 409s on it. */
  const busyEpicIds = new Set(
    activeRows
      .map((row) => row.epicId)
      .filter((id): id is string => typeof id === "string"),
  );

  /* ---- 8. verdicts (before 7, so one grouped count serves both) ------ */

  const verdictRows = db
    .select({
      id: agentSessions.id,
      epicId: agentSessions.epicId,
      projectId: agentSessions.projectId,
      reviewVerdict: agentSessions.reviewVerdict,
      // `sessionAtSql()` is typed `SQL<unknown>`; it normalises the two
      // timestamp shapes this column mixes and always yields text.
      at: sql<string | null>`${sessionAtSql()}`.as("session_at"),
    })
    .from(agentSessions)
    .where(
      and(
        inArray(agentSessions.projectId, projectIds),
        sql`${agentSessions.createdAt} >= ${verdictCutoff}`,
        eq(agentSessions.status, "completed"),
        inArray(agentSessions.agentType, [...ORDINARY_REVIEW_AGENT_TYPES]),
        sql`${agentSessions.userStoryId} IS NULL`,
      ),
    )
    .all();

  /* ---- 7. what each of those sessions filed -------------------------- */

  // One grouped read for both questions ("what has this live reviewer put on
  // the table" and "how many rows did this verdict's session file"), landing on
  // `review_comments_session_idx`, which exists for exactly this shape.
  const countableSessionIds = [
    ...new Set([
      ...reviewRows.filter((row) => row.status === "running").map((row) => row.id),
      ...verdictRows.map((row) => row.id),
    ]),
  ];

  const filingCounts = new Map<string, QaFilingCounts>();
  if (countableSessionIds.length > 0) {
    const countRows = db
      .select({
        sessionId: reviewComments.agentSessionId,
        findings: sql<number>`COUNT(*)`.as("findings_filed"),
        blocking:
          sql<number>`SUM(CASE WHEN ${blockingPrefixSql()} THEN 1 ELSE 0 END)`.as(
            "blocking_filed",
          ),
      })
      .from(reviewComments)
      .where(inArray(reviewComments.agentSessionId, countableSessionIds))
      .groupBy(reviewComments.agentSessionId)
      .all();

    for (const row of countRows) {
      if (!row.sessionId) continue;
      filingCounts.set(row.sessionId, {
        findings: Number(row.findings ?? 0),
        blocking: Number(row.blocking ?? 0),
      });
    }
  }

  /* ---- 9. the unverifiable set -------------------------------------- */

  const verdictEpicIds = [
    ...new Set(
      verdictRows
        .map((row) => row.epicId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];

  // `projectId: null` MUST be paired with `scope.epicIds` — the project is the
  // leading key of the one index on this table. Two queries, whatever the board
  // size.
  const unverifiableEpicIds =
    verdictEpicIds.length === 0
      ? new Set<string>()
      : listUnverifiableReviewEpicIds(null, db, { epicIds: verdictEpicIds });

  /* ---- 10. coverage -------------------------------------------------- */

  const shippedRows = db
    .select({ epicId: ticketActivityLog.epicId })
    .from(ticketActivityLog)
    .where(
      and(
        inArray(ticketActivityLog.projectId, projectIds),
        inArray(ticketActivityLog.toStatus, ["done", "released"]),
        sql`${ticketActivityLog.createdAt} >= ${coverageCutoff}`,
      ),
    )
    .groupBy(ticketActivityLog.epicId)
    .all();

  const shippedEpicIds = shippedRows.map((row) => row.epicId);

  const reviewedRow =
    shippedEpicIds.length === 0
      ? undefined
      : db
          .select({
            reviewed: sql<number>`COUNT(DISTINCT ${agentSessions.epicId})`.as(
              "reviewed",
            ),
          })
          .from(agentSessions)
          .where(
            and(
              inArray(agentSessions.epicId, shippedEpicIds),
              inArray(agentSessions.projectId, projectIds),
              eq(agentSessions.status, "completed"),
              inArray(agentSessions.agentType, [...ORDINARY_REVIEW_AGENT_TYPES]),
            ),
          )
          .get();

  /* ---- 10b. QA checks ------------------------------------------------ */

  /**
   * The exploratory QA-check history — tech checks, E2E passes and failure
   * digests. This is the surface the redesign orphaned: the nav's QA entry
   * points here, and until now this payload described only the review layer,
   * so `/qa` could neither start a check nor show one running.
   *
   * TWO COLUMNS OF THIS TABLE ARE NEVER SELECTED. `report_content` holds a
   * whole markdown QA report and `prompt_used` a whole composed prompt; both
   * are uncapped, and this route is polled every 8 s. `summary` IS capped at
   * 500 chars by the check route's `extractSummary`, but the cap lives in one
   * writer among several, so it is clipped in SQL like every other text column
   * this route ships.
   *
   * NO `project_id` BOUND ON THE SCAN, deliberately, and it is the one place
   * this route departs from its own discipline: `qa_reports` carries no
   * secondary index at all, so an `IN (…)` would prune nothing and only add a
   * predicate. What bounds the read is `LIMIT`, and the table grows one row per
   * QA check a human starts by hand — it is three orders of magnitude smaller
   * than `agent_sessions`.
   *
   * WHY THE JOIN. Liveness cannot be read from `qa_reports.status`: that column
   * has ONE writer, and three ordinary paths (restart, rejected launch,
   * cancelled queue entry) skip it and strand a row on `running` for good — see
   * `isCheckLive`. Since LIVE FIRST is in the ORDER BY, trusting the column
   * would let five stranded rows pin themselves to the top of a
   * `QA_CHECK_LIMIT`-row band and hide every real check: the ordering added to
   * protect a live check would be the thing that buries them all.
   *
   * The join is on `agent_sessions`' PRIMARY KEY, one B-tree probe per report
   * row, over a table already being scanned in full. `liveCheckSql()` is the
   * ONE expression behind the ordering, the row's `live` flag and the totals —
   * three places that must never answer differently.
   */
  const checkRows = db
    .select({
      id: qaReports.id,
      projectId: qaReports.projectId,
      status: qaReports.status,
      checkType: qaReports.checkType,
      summary: sql<
        string | null
      >`SUBSTR(${qaReports.summary}, 1, ${sql.raw(String(QA_CHECK_SUMMARY_LIMIT))})`,
      agentSessionId: qaReports.agentSessionId,
      sessionStatus: agentSessions.status,
      createdAt: qaReports.createdAt,
      completedAt: qaReports.completedAt,
    })
    .from(qaReports)
    .leftJoin(agentSessions, eq(qaReports.agentSessionId, agentSessions.id))
    .orderBy(desc(liveCheckSql()), desc(qaReports.createdAt))
    .limit(QA_CHECK_LIMIT)
    .all();

  /**
   * The band's meta counts EVERY report, not the `QA_CHECK_LIMIT` rows above.
   *
   * A capped slice rendered as a count saturates at the cap and understates
   * reality exactly when the user most needs it — several checks in flight at
   * once. The rows are a window; these are the totals, and `running` uses the
   * same `liveCheckSql()` the rows do, so the meta can never say "3 running"
   * over a band drawing one breathing dot.
   *
   * GROUPED BY PROJECT so the figure survives `filterQaPayload`: the screen
   * takes an optional `projectId`, and one workspace total would come through
   * that narrowing untouched and print every project's count over one
   * project's band. `sumCheckTotals` adds up whichever projects are in scope.
   */
  const checkTotalRows = db
    .select({
      projectId: qaReports.projectId,
      total: sql<number>`COUNT(*)`,
      running: sql<number>`SUM(${liveCheckSql()})`,
    })
    .from(qaReports)
    .leftJoin(agentSessions, eq(qaReports.agentSessionId, agentSessions.id))
    .groupBy(qaReports.projectId)
    .all();

  /* ---- 11. la rubrique ----------------------------------------------- */

  const projectRules = db
    .select({ rules: sql<number>`COUNT(*)`.as("project_rules") })
    .from(customReviewAgents)
    .where(eq(customReviewAgents.isEnabled, 1))
    .get();

  /* ---- assemble ------------------------------------------------------ */

  const findings: QaFinding[] = findingRows
    .map((row) => {
      const epic = epicsById.get(row.epicId);
      const stamp = severityOf(row.body, row.author);
      const session = row.agentSessionId
        ? filingSessionsById.get(row.agentSessionId)
        : undefined;
      return {
        findingId: row.id,
        epicId: row.epicId,
        projectId: epic?.projectId ?? "",
        readableId: epic?.readableId ?? null,
        ticketTitle: epic?.title ?? "",
        text: stripSeverityPrefix(row.body),
        filePath: row.filePath,
        lineNumber: row.lineNumber,
        severity: stamp.severity,
        severityLabel: stamp.severityLabel,
        tier: stamp.tier,
        blocking: blockingFindingIds.has(row.id),
        // No filing session (a human comment, or a row written before 0032)
        // reads as "—". Guessing a reviewer from timestamps would be a lie.
        reviewer: session?.namedAgentName ?? session?.agentType ?? null,
        reviewerAgentType: session?.agentType ?? null,
        filedAt: row.createdAt,
        fixable: isBuildableStatus(epic?.status),
        rawBody: row.body,
      } satisfies QaFinding;
    })
    .sort(compareFindings);

  const verdictEpics = new Map<string, QaVerdictEpic>(
    epicRows.map((row) => [
      row.id,
      { readableId: row.readableId, title: row.title, status: row.status ?? "" },
    ]),
  );

  const verdictSessions: QaVerdictSessionRow[] = verdictRows
    .filter((row): row is typeof row & { epicId: string } => row.epicId !== null)
    .map((row) => ({
      sessionId: row.id,
      epicId: row.epicId,
      projectId: row.projectId,
      reviewVerdict: row.reviewVerdict,
      at: row.at,
      findingsFiled: filingCounts.get(row.id)?.findings ?? 0,
    }));

  // The review route accepts `review | to_merge | done` and 409s when another
  // agent owns the epic. `done` is deliberately not offered: re-reviewing a
  // shipped ticket is not what this button is for, and listing every delivered
  // ticket would make the target list unusable.
  const reviewable: QaReviewTarget[] = epicRows
    .filter(
      (row) =>
        (row.status === "review" || row.status === "to_merge") &&
        !busyEpicIds.has(row.id),
    )
    .map((row) => ({
      epicId: row.id,
      projectId: row.projectId,
      readableId: row.readableId,
      title: row.title,
      status: row.status ?? "",
    }));

  /* The verdict lines are composed here rather than in `lib/qa/aggregate.ts`:
     the derivation is pure and this handler is the thing that knows the
     locale. `lib/i18n/catalogue.ts` calls this the API-route exception. */
  const t = translatorFor(await resolveRequestUiLocale(), "Qa");
  const verdictCopy: QaVerdictCopy = {
    unverifiable: t("verdicts.unverifiable"),
    changesRequested: (count) => t("verdicts.changesRequested", { count }),
    cleanNoFindings: t("verdicts.cleanNoFindings"),
    cleanWithFindings: (count) => t("verdicts.cleanWithFindings", { count }),
    noStructuredVerdict: t("verdicts.noStructuredVerdict"),
    outcomeLanded: t("verdicts.outcomeLanded"),
    outcomeReady: t("verdicts.outcomeReady"),
    outcomeYourTurn: t("verdicts.outcomeYourTurn"),
  };

  const payload: QaPayload = {
    generatedAt: now.toISOString(),
    // Reused, never re-derived: project identity colour is the position in
    // creation order, and a second derivation is how two screens start painting
    // one project two colours.
    projects: deriveProjects(projectRows),
    runs: deriveRuns(reviewRows, filingCounts),
    queued: deriveQueued(reviewRows),
    findings,
    verdicts: deriveVerdicts(verdictSessions, verdictEpics, unverifiableEpicIds, verdictCopy),
    rubric: {
      items: rubricItemsFromChecklist(REVIEW_CHECKLISTS.feature_review),
      projectRuleCount: Number(projectRules?.rules ?? 0),
    },
    reviewable,
    checks: deriveChecks(checkRows),
    checkTotals: Object.fromEntries(
      checkTotalRows.map((row) => [
        row.projectId,
        {
          // SUM over a group whose every row scores 0 still returns 0, but SUM
          // of NULLs is NULL — the standing SQL trap. A band must read
          // "0 running", never "NaN running".
          running: Number(row.running ?? 0),
          total: Number(row.total ?? 0),
        },
      ]),
    ),
    // A project with no `git_repo_path` is not offerable: the check route
    // refuses it with a 400 before it looks at anything else.
    checkableProjectIds: projectRows
      .filter((row) => Boolean(row.gitRepoPath))
      .map((row) => row.id),
    coveragePercent: deriveCoverage(
      Number(reviewedRow?.reviewed ?? 0),
      shippedEpicIds.length,
    ),
  };

  console.debug("[qa/findings/GET] query profile", {
    projects: payload.projects.length,
    epics: epicRows.length,
    findings: payload.findings.length,
    runs: payload.runs.length,
    checks: payload.checks.length,
    queryMs: Date.now() - queryStartedAt,
  });

  return NextResponse.json({ data: payload });
}
