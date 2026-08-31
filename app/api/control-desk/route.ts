import { NextResponse } from "next/server";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  reviewComments,
  settings,
  ticketActivityLog,
  ticketComments,
  ticketDependencies,
  ticketReadCursors,
  userStories,
  deskDismissals,
} from "@/lib/db/schema";
import {
  autoModeEnabledSettingKey,
  parseAutoModeEnabled,
  AUTO_MODE_ENABLED_SETTING_KEY,
} from "@/lib/auto-mode/constants";
import { blocksMergeSql } from "@/lib/workflow/blocking-findings";
import { epicSessionFactsCte } from "@/lib/workflow/review-freshness";
import {
  CONFLICT_MARKERS_REASON_LIKE_PATTERNS,
  MERGE_CONFLICT_REASON_LIKE_PATTERNS,
  MERGE_FAILURE_REASON_LIKE_PATTERNS,
} from "@/lib/workflow/merge-failure";
import { isSessionStale } from "@/lib/agents/watchdog";
import { getSessionLastActivityAt } from "@/lib/agents/watchdog";
import type { TicketDependencyEdge } from "@/lib/types/kanban";
import {
  applyDeskDismissals,
  deriveAwaitingReply,
  deriveConflicts,
  deriveFailures,
  deriveProjects,
  deriveQueued,
  deriveReadyToLand,
  deriveToday,
  deriveUpNext,
  deriveWorking,
  type DeskDismissalRow,
  type EpicRow,
  type FailureSessionRow,
  type SessionRow,
} from "@/lib/control-desk/aggregate";
import {
  CONTROL_DESK_LOOKBACK_DAYS,
  LOG_LINE_LIMIT,
  type ControlDeskPayload,
} from "@/lib/control-desk/types";

/**
 * GET /api/control-desk — everything the "Now" desk shows, for every project.
 *
 * WHY ONE ROUTE. better-sqlite3 is synchronous on ONE shared connection
 * (lib/db/index.ts). Fanning out to the per-project board/session routes would
 * run N sequential board queries per poll and block the event loop for the
 * whole app — SSE heartbeats included. So the desk aggregates here, in the
 * shape `/api/inbox` already established: whole-table queries with a `projects`
 * join, derivations in JS from the shared pure helpers.
 *
 * WHY POLLING, NOT SSE. `lib/events/bus.ts` keeps a `Map<projectId, listeners>`
 * and `emit()` returns early for a project nobody listens to; there is no
 * wildcard room and only a per-project SSE endpoint. N EventSources would cost
 * one long-lived HTTP/1.1 connection per project and starve the page at ~6.
 * The client polls this route every few seconds instead.
 *
 * SCAN DISCIPLINE. Every query here carries a bound that an INDEX can use,
 * and the shape of the bound is chosen per table rather than copied:
 *
 * - `agent_sessions` has exactly two secondary indexes: `(project_id,
 *   created_at)` and `(epic_id)`. A bare `created_at >= cutoff` does NOT prune
 *   — `created_at` is the second column of a composite whose first column is
 *   unconstrained — so every time-bounded scan also carries `project_id IN
 *   (<the desk's projects>)`, which turns the full scan into one index range
 *   per project. Measured on the developer's 962 MB board (761 sessions,
 *   77 KB average prompt): `newestSessionAt` went 12.0 ms -> 0.26 ms from that
 *   one clause. The `project_id IN` list is every row of `projects`, so it
 *   removes no session — sessions carry a NOT NULL FK to a project.
 *
 * - the per-epic fact queries (latest comment, latest session, latest user
 *   comment, story counts) scan by `epic_id IN (<the epics this response
 *   renders>)`, which lands on `ticket_comments_epic_idx`,
 *   `agent_sessions_epic_idx` and `user_stories_epic_position_idx`. That is a
 *   TIGHTER bound than a time cutoff AND an exact one: the outer query joins
 *   those facts onto the same id set, so restricting them drops only rows the
 *   join would have thrown away. A time cutoff would not be exact — it would
 *   silence the unread badge on a three-week-old agent comment — and the desk
 *   must agree with `/api/inbox`, which computes the same two signals.
 *
 * - the merge-readiness scans by `epic_id IN (<to_merge epics>)`, tighter
 *   still. Exactness matters twice over there: those facts are MAX over an
 *   epic's whole history, and truncating it would make an old
 *   `changes_requested` verdict vanish and the ticket read as ready to merge.
 *
 * - the ONE deliberately unindexed scan is the running/queued session read.
 *   `status` carries no index, so it is a table scan — but it is the scan
 *   whose answer must not be truncated (a session queued three weeks ago is
 *   still queued, and hiding it is the bug), and it reads only narrow columns,
 *   so it costs ~0.1 ms on that same board.
 *
 * NEVER SELECT `prompt`. It averages 77 KB and reaches 5 MB on that board, and
 * this route is polled every 4 s from two pages. Nothing the desk renders
 * needs it: see `inferTaskType` in lib/control-desk/aggregate.ts for why the
 * dispatch role comes from `agent_type` / `orchestration_mode` / `mode`.
 */

/** Lexicographic floor for both timestamp shapes stored in these columns. */
function lookbackCutoff(now: Date): string {
  const at = new Date(now.getTime() - CONTROL_DESK_LOOKBACK_DAYS * 86_400_000);
  return at.toISOString();
}

/** 00:00 UTC of the current day, as a lexicographic floor. */
function startOfTodayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Characters of a ticket comment the SQL reads.
 *
 * `excerpt()` in lib/control-desk/aggregate.ts clips the quote to 200 after
 * collapsing whitespace, so twice that is more than the clip can ever consume
 * — and it keeps an uncapped comment body out of the poll.
 */
const COMMENT_EXCERPT_SCAN = 400;

/**
 * The `id DESC` half of an `ORDER BY created_at DESC, id DESC` tie-break.
 *
 * The per-epic fact queries take MAX(created_at) and join back, which can
 * return several rows when an epic's newest comment or session shares its
 * timestamp with a sibling. `true` when `candidate` outranks what is held.
 */
function keepLatest(held: string | undefined, candidate: string): boolean {
  return held === undefined || candidate > held;
}

export async function GET() {
  const queryStartedAt = Date.now();
  const now = new Date();
  const cutoff = lookbackCutoff(now);
  const todayFloor = startOfTodayUtc(now);

  /* ---- projects ---------------------------------------------------- */

  const projectRows = db
    .select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .all();

  /**
   * The `project_id IN (...)` bound every cross-project session scan carries.
   *
   * It is not a filter — `agent_sessions.project_id` is NOT NULL with a
   * cascading FK, so every session is in this list. It exists to give the
   * planner the leading column of `agent_sessions(project_id, created_at)`,
   * without which a `created_at >= cutoff` clause prunes nothing.
   */
  const projectIds = projectRows.map((row) => row.id);

  /* ---- WORKING / QUEUED -------------------------------------------- */

  // `last_non_empty_text` is UNCAPPED at the write side — a CLI emitting one
  // 4 MB line stores 4 MB, which is why the sessions LIST route reduces it to a
  // boolean. The desk actually prints the line, so it takes a substring in SQL
  // and never selects the raw column. `prompt` has the same shape and is not
  // selected at all — see the NEVER SELECT `prompt` note above.
  const activeRows = db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      epicId: agentSessions.epicId,
      userStoryId: agentSessions.userStoryId,
      status: agentSessions.status,
      mode: agentSessions.mode,
      agentType: agentSessions.agentType,
      orchestrationMode: agentSessions.orchestrationMode,
      provider: agentSessions.provider,
      namedAgentName: agentSessions.namedAgentName,
      batchRunId: agentSessions.batchRunId,
      startedAt: agentSessions.startedAt,
      endedAt: agentSessions.endedAt,
      completedAt: agentSessions.completedAt,
      createdAt: agentSessions.createdAt,
      lastLogLine: sql<
        string | null
      >`substr(${agentSessions.lastNonEmptyText}, 1, ${LOG_LINE_LIMIT})`.as(
        "last_log_line",
      ),
      epicTitle: epics.title,
      epicReadableId: epics.readableId,
      storyTitle: userStories.title,
    })
    .from(agentSessions)
    .leftJoin(epics, eq(agentSessions.epicId, epics.id))
    .leftJoin(userStories, eq(agentSessions.userStoryId, userStories.id))
    .where(inArray(agentSessions.status, ["running", "queued"]))
    .all();

  const sessionRows: SessionRow[] = activeRows.map((row) => ({
    ...row,
    // Same watchdog predicate the agent monitor uses, so the desk's stale
    // marker and the stall notification can never disagree.
    stale:
      row.status === "running" &&
      isSessionStale(getSessionLastActivityAt(row), row.agentType, now),
  }));

  const working = deriveWorking(sessionRows);
  const queued = deriveQueued(sessionRows);

  // Full Auto is PER PROJECT (app/api/projects/[projectId]/auto-mode). There is
  // no global flag, so the header pill reports "N/M projects on" and its
  // popover toggles them one by one.
  const autoModeSettings = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(sql`${settings.key} LIKE ${`${AUTO_MODE_ENABLED_SETTING_KEY}%`}`)
    .all();
  const autoModeByKey = new Map(autoModeSettings.map((row) => [row.key, row.value]));
  const globalAutoMode =
    parseAutoModeEnabled(autoModeByKey.get(AUTO_MODE_ENABLED_SETTING_KEY)) ?? false;

  // The rail's per-project agent count is `sessionRows` grouped, not its own
  // GROUP BY over `agent_sessions`: that query scanned the same table for the
  // same universe (`status = 'running'` is a subset of the rows just read) and
  // could disagree with the WORKING band if a session ended between the two.
  const activeAgentsByProject = new Map<string, number>();
  for (const row of sessionRows) {
    if (row.status !== "running") continue;
    activeAgentsByProject.set(
      row.projectId,
      (activeAgentsByProject.get(row.projectId) ?? 0) + 1,
    );
  }

  const deskProjects = deriveProjects(
    projectRows.map((row) => ({
      ...row,
      activeAgents: activeAgentsByProject.get(row.id) ?? 0,
      autoModeEnabled:
        parseAutoModeEnabled(autoModeByKey.get(autoModeEnabledSettingKey(row.id))) ??
        globalAutoMode,
    })),
  );

  /** Any session owning a ticket, queued included — the merge-suppression set. */
  const busyEpicIds = new Set(
    sessionRows.filter((row) => row.epicId).map((row) => row.epicId as string),
  );
  const runningEpicIds = new Set(
    sessionRows
      .filter((row) => row.status === "running" && row.epicId)
      .map((row) => row.epicId as string),
  );

  /* ---- epics (the /api/inbox shape, cross-project) ------------------ */

  // Phase 1: the epics themselves. The `projects` join plus
  // `epics_project_status_position_idx` keep this to the board's own rows, and
  // the id set it yields is the bound every per-epic fact query below carries.
  const baseEpicRows = db
    .select({
      id: epics.id,
      projectId: epics.projectId,
      title: epics.title,
      readableId: epics.readableId,
      status: epics.status,
      position: epics.position,
      priority: epics.priority,
      type: epics.type,
      branchName: epics.branchName,
      prNumber: epics.prNumber,
      lastReadAt: ticketReadCursors.lastReadAt,
    })
    .from(epics)
    .innerJoin(projects, eq(epics.projectId, projects.id))
    .leftJoin(ticketReadCursors, eq(epics.id, ticketReadCursors.epicId))
    .orderBy(epics.position)
    .all();

  const epicIds = baseEpicRows.map((row) => row.id);

  // Phase 2: the per-epic facts. These were LEFT JOINed subqueries, which made
  // each one a scan of its whole table on every 4 s poll; splitting them out
  // lets each carry `epic_id IN (<the ids above>)` and land on that table's
  // epic index. The join result is unchanged — the outer join kept only these
  // ids anyway.
  const latestCommentByEpic = new Map<
    string,
    {
      id: string;
      author: string | null;
      content: string | null;
      createdAt: string | null;
    }
  >();
  const latestSessionByEpic = new Map<
    string,
    { outcome: string | null; endedAt: string | null }
  >();
  const latestUserCommentByEpic = new Map<string, string | null>();
  const storyCountsByEpic = new Map<string, { usCount: number; usDone: number }>();

  if (epicIds.length > 0) {
    // `ticket_comments.content` is uncapped user/agent text — 5.5 MB across
    // 1657 rows on the developer's board — and the desk quotes at most
    // QUESTION_LENGTH characters of it. So the clip happens in SQL, the way
    // `last_non_empty_text` is already clipped above; the extra room is for the
    // leading whitespace `excerpt()` collapses before it counts characters.
    // A ROW_NUMBER window would rank every comment of every epic; this ranks
    // none. MAX(created_at) per epic is an index-driven aggregate, the join
    // then reads only the newest comment (or the handful sharing a timestamp),
    // and `keepLatest` applies the window's `id DESC` tie-break to those few.
    // Same answer, 6.2 ms -> 1.0 ms on the developer's board.
    const newestCommentAt = db
      .select({
        epicId: ticketComments.epicId,
        newestAt: sql<string>`MAX(${ticketComments.createdAt})`.as(
          "newest_comment_at",
        ),
      })
      .from(ticketComments)
      .where(inArray(ticketComments.epicId, epicIds))
      .groupBy(ticketComments.epicId)
      .as("newest_comment_at");

    const commentRows = db
      .select({
        epicId: ticketComments.epicId,
        latestCommentId: ticketComments.id,
        latestCommentAuthor: ticketComments.author,
        latestCommentContent: sql<
          string | null
        >`substr(${ticketComments.content}, 1, ${COMMENT_EXCERPT_SCAN})`.as(
          "latest_comment_content",
        ),
        latestCommentCreatedAt: ticketComments.createdAt,
      })
      .from(ticketComments)
      .innerJoin(
        newestCommentAt,
        and(
          eq(ticketComments.epicId, newestCommentAt.epicId),
          eq(ticketComments.createdAt, newestCommentAt.newestAt),
        ),
      )
      .where(inArray(ticketComments.epicId, epicIds))
      .all();

    for (const row of commentRows) {
      if (!row.epicId) continue;
      if (!keepLatest(latestCommentByEpic.get(row.epicId)?.id, row.latestCommentId)) {
        continue;
      }
      latestCommentByEpic.set(row.epicId, {
        id: row.latestCommentId,
        author: row.latestCommentAuthor,
        content: row.latestCommentContent,
        createdAt: row.latestCommentCreatedAt,
      });
    }

    // Latest session per epic, ANY age. No cutoff on purpose: `isAwaitingReply`
    // reads the verdict of the newest session whatever its date, and a cutoff
    // would drop a three-week-old unanswered question off ASKS YOU — and split
    // the desk from `/api/inbox`, which asks the same question unbounded.
    //
    // Same MAX-then-join shape as the comments above, for the same reason: the
    // ROW_NUMBER window ranked all 761 sessions and had to walk past each row's
    // 77 KB prompt to reach `outcome`. 13.1 ms -> 0.4 ms.
    const newestEpicSessionAt = db
      .select({
        epicId: agentSessions.epicId,
        newestAt: sql<string>`MAX(${agentSessions.createdAt})`.as(
          "newest_epic_session_at",
        ),
      })
      .from(agentSessions)
      .where(
        and(
          inArray(agentSessions.epicId, epicIds),
          inArray(agentSessions.projectId, projectIds),
        ),
      )
      .groupBy(agentSessions.epicId)
      .as("newest_epic_session_at");

    const sessionFactRows = db
      .select({
        epicId: agentSessions.epicId,
        sessionId: agentSessions.id,
        latestSessionOutcome: agentSessions.outcome,
        latestSessionEndedAt: sql<string | null>`COALESCE(
          ${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}
        )`.as("latest_session_ended_at"),
      })
      .from(agentSessions)
      .innerJoin(
        newestEpicSessionAt,
        and(
          eq(agentSessions.epicId, newestEpicSessionAt.epicId),
          eq(agentSessions.createdAt, newestEpicSessionAt.newestAt),
        ),
      )
      .where(
        and(
          inArray(agentSessions.epicId, epicIds),
          inArray(agentSessions.projectId, projectIds),
        ),
      )
      .all();

    const latestSessionIdByEpic = new Map<string, string>();
    for (const row of sessionFactRows) {
      if (!row.epicId) continue;
      if (!keepLatest(latestSessionIdByEpic.get(row.epicId), row.sessionId)) continue;
      latestSessionIdByEpic.set(row.epicId, row.sessionId);
      latestSessionByEpic.set(row.epicId, {
        outcome: row.latestSessionOutcome,
        endedAt: row.latestSessionEndedAt,
      });
    }

    const userCommentRows = db
      .select({
        epicId: ticketComments.epicId,
        latestUserCommentCreatedAt: sql<
          string | null
        >`MAX(${ticketComments.createdAt})`.as("latest_user_comment_created_at"),
      })
      .from(ticketComments)
      .where(
        and(
          inArray(ticketComments.epicId, epicIds),
          eq(ticketComments.author, "user"),
        ),
      )
      .groupBy(ticketComments.epicId)
      .all();

    for (const row of userCommentRows) {
      if (!row.epicId) continue;
      latestUserCommentByEpic.set(row.epicId, row.latestUserCommentCreatedAt);
    }

    const storyCountRows = db
      .select({
        epicId: userStories.epicId,
        usCount: sql<number>`COUNT(${userStories.id})`.as("us_count"),
        usDone:
          sql<number>`SUM(CASE WHEN ${userStories.status} = 'done' THEN 1 ELSE 0 END)`.as(
            "us_done",
          ),
      })
      .from(userStories)
      .where(inArray(userStories.epicId, epicIds))
      .groupBy(userStories.epicId)
      .all();

    for (const row of storyCountRows) {
      storyCountsByEpic.set(row.epicId, {
        usCount: Number(row.usCount ?? 0),
        usDone: Number(row.usDone ?? 0),
      });
    }
  }

  const epicRows = baseEpicRows.map((row) => {
    const comment = latestCommentByEpic.get(row.id);
    const session = latestSessionByEpic.get(row.id);
    const counts = storyCountsByEpic.get(row.id);
    return {
      ...row,
      usCount: counts?.usCount ?? 0,
      usDone: counts?.usDone ?? 0,
      latestCommentId: comment?.id ?? null,
      latestCommentAuthor: comment?.author ?? null,
      latestCommentContent: comment?.content ?? null,
      latestCommentCreatedAt: comment?.createdAt ?? null,
      latestSessionOutcome: session?.outcome ?? null,
      latestSessionEndedAt: session?.endedAt ?? null,
      latestUserCommentCreatedAt: latestUserCommentByEpic.get(row.id) ?? null,
    };
  });

  /* ---- merge readiness, for the `to_merge` slice only --------------- */

  const toMergeIds = epicRows
    .filter((row) => row.status === "to_merge")
    .map((row) => row.id);

  const mergeFactsById = new Map<
    string,
    {
      openFindings: number | null;
      lastCleanReviewAt: string | null;
      lastTerminalCodeAt: string | null;
      lastNegativeVerdictReviewAt: string | null;
      supersessionAt: string | null;
      lastMergeConflictAt: string | null;
      lastConflictMarkersAt: string | null;
    }
  >();

  if (toMergeIds.length > 0) {
    const epicSessionFacts = epicSessionFactsCte(db, null, { epicIds: toMergeIds });

    const openFindingCounts = db
      .select({
        epicId: reviewComments.epicId,
        openFindings: sql<number>`COUNT(*)`.as("open_findings"),
      })
      .from(reviewComments)
      .leftJoin(epicSessionFacts, eq(epicSessionFacts.epicId, reviewComments.epicId))
      .where(
        and(
          inArray(reviewComments.epicId, toMergeIds),
          eq(reviewComments.status, "open"),
          blocksMergeSql(epicSessionFacts.supersessionAt),
        ),
      )
      .groupBy(reviewComments.epicId)
      .as("open_finding_counts");

    // A failed merge writes no column anywhere: this same-state activity row is
    // the only durable trace (lib/workflow/merge-failure.ts). `reason` carries
    // no index and the table is never pruned, so the `epic_id IN (...)` bound
    // — served by `ticket_activity_log_epic_idx` — is what keeps the LIKEs off
    // a full-table string match.
    const latestMergeFailures = db
      .select({
        epicId: ticketActivityLog.epicId,
        lastMergeConflictAt: sql<string | null>`MAX(CASE WHEN ${or(
          ...MERGE_CONFLICT_REASON_LIKE_PATTERNS.map(
            (pattern) => sql`${ticketActivityLog.reason} LIKE ${pattern} ESCAPE '\\'`,
          ),
        )} THEN REPLACE(${ticketActivityLog.createdAt}, ' ', 'T') END)`.as(
          "last_merge_conflict_at",
        ),
        lastConflictMarkersAt: sql<string | null>`MAX(CASE WHEN ${or(
          ...CONFLICT_MARKERS_REASON_LIKE_PATTERNS.map(
            (pattern) => sql`${ticketActivityLog.reason} LIKE ${pattern} ESCAPE '\\'`,
          ),
        )} THEN REPLACE(${ticketActivityLog.createdAt}, ' ', 'T') END)`.as(
          "last_conflict_markers_at",
        ),
      })
      .from(ticketActivityLog)
      .where(
        and(
          inArray(ticketActivityLog.epicId, toMergeIds),
          or(
            ...MERGE_FAILURE_REASON_LIKE_PATTERNS.map(
              (pattern) => sql`${ticketActivityLog.reason} LIKE ${pattern} ESCAPE '\\'`,
            ),
          ),
        ),
      )
      .groupBy(ticketActivityLog.epicId)
      .as("latest_merge_failures");

    const factRows = db
      .with(epicSessionFacts)
      .select({
        id: epics.id,
        openFindings: openFindingCounts.openFindings,
        lastCleanReviewAt: epicSessionFacts.lastCleanReviewAt,
        lastTerminalCodeAt: epicSessionFacts.lastTerminalCodeAt,
        lastNegativeVerdictReviewAt: epicSessionFacts.lastNegativeVerdictReviewAt,
        supersessionAt: epicSessionFacts.supersessionAt,
        lastMergeConflictAt: latestMergeFailures.lastMergeConflictAt,
        lastConflictMarkersAt: latestMergeFailures.lastConflictMarkersAt,
      })
      .from(epics)
      .leftJoin(epicSessionFacts, eq(epics.id, epicSessionFacts.epicId))
      .leftJoin(openFindingCounts, eq(epics.id, openFindingCounts.epicId))
      .leftJoin(latestMergeFailures, eq(epics.id, latestMergeFailures.epicId))
      .where(inArray(epics.id, toMergeIds))
      .all();

    for (const row of factRows) {
      mergeFactsById.set(row.id, {
        openFindings: row.openFindings ?? 0,
        lastCleanReviewAt: row.lastCleanReviewAt ?? null,
        lastTerminalCodeAt: row.lastTerminalCodeAt ?? null,
        lastNegativeVerdictReviewAt: row.lastNegativeVerdictReviewAt ?? null,
        supersessionAt: row.supersessionAt ?? null,
        lastMergeConflictAt: row.lastMergeConflictAt ?? null,
        lastConflictMarkersAt: row.lastConflictMarkersAt ?? null,
      });
    }
  }

  const deskEpics: EpicRow[] = epicRows.map((row) => {
    const facts = mergeFactsById.get(row.id);
    return {
      ...row,
      openFindings: facts?.openFindings ?? null,
      lastCleanReviewAt: facts?.lastCleanReviewAt ?? null,
      lastTerminalCodeAt: facts?.lastTerminalCodeAt ?? null,
      lastNegativeVerdictReviewAt: facts?.lastNegativeVerdictReviewAt ?? null,
      supersessionAt: facts?.supersessionAt ?? null,
      lastMergeConflictAt: facts?.lastMergeConflictAt ?? null,
      lastConflictMarkersAt: facts?.lastConflictMarkersAt ?? null,
    };
  });
  const epicsById = new Map(deskEpics.map((epic) => [epic.id, epic]));

  /* ---- FAILED rows -------------------------------------------------- */

  // "Latest session wins" needs EVERY session sharing an epic's newest
  // created_at — that same-second tie group is what lets a retry created in the
  // same second as the failure clear the badge immediately. Older rows can
  // never win, so bounding the scan by the lookback cutoff only ever hides
  // failures the desk has no business shouting about.
  //
  // The `project_id IN` clause beside it changes no answer — it is the leading
  // column of `agent_sessions(project_id, created_at)`, and without it the
  // cutoff cannot be used as a range and the query degrades to a full scan
  // (12.0 ms -> 0.26 ms on the developer's board).
  const newestSessionAt = db
    .select({
      epicId: agentSessions.epicId,
      newestAt: sql<string>`MAX(${agentSessions.createdAt})`.as("newest_at"),
    })
    .from(agentSessions)
    .where(
      and(
        sql`${agentSessions.epicId} IS NOT NULL`,
        inArray(agentSessions.projectId, projectIds),
        sql`${agentSessions.createdAt} >= ${cutoff}`,
      ),
    )
    .groupBy(agentSessions.epicId)
    .as("newest_session_at");

  const failureRows = db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      epicId: agentSessions.epicId,
      status: agentSessions.status,
      error: agentSessions.error,
      agentType: agentSessions.agentType,
      provider: agentSessions.provider,
      namedAgentId: agentSessions.namedAgentId,
      namedAgentName: agentSessions.namedAgentName,
      userStoryId: agentSessions.userStoryId,
      // Never the raw column: the badge only needs "did it stream anything".
      producedOutput: sql<number>`CASE WHEN length(COALESCE(${agentSessions.lastNonEmptyText}, '')) > 0 THEN 1 ELSE 0 END`.as(
        "produced_output",
      ),
      createdAt: agentSessions.createdAt,
      endedAt: agentSessions.endedAt,
    })
    .from(agentSessions)
    .innerJoin(
      newestSessionAt,
      and(
        eq(agentSessions.epicId, newestSessionAt.epicId),
        eq(agentSessions.createdAt, newestSessionAt.newestAt),
      ),
    )
    // Repeating the subquery's bound on the OUTER side changes no answer — the
    // join already forces `created_at` to a value the subquery matched — but it
    // is what lets the outer side use the same index range instead of probing
    // `agent_sessions_epic_idx` and reading every session of every epic.
    // 14.4 ms -> 0.65 ms on the developer's board.
    .where(
      and(
        inArray(agentSessions.projectId, projectIds),
        sql`${agentSessions.createdAt} >= ${cutoff}`,
      ),
    )
    .all();

  const failureSessions: FailureSessionRow[] = failureRows.map((row) => ({
    id: row.id,
    kind: "agent_session",
    projectId: row.projectId,
    status: row.status ?? "",
    epicId: row.epicId,
    error: row.error,
    agentType: row.agentType,
    provider: row.provider,
    namedAgentId: row.namedAgentId,
    namedAgentName: row.namedAgentName,
    userStoryId: row.userStoryId,
    producedOutput: row.producedOutput === 1,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
  }));

  /* ---- TODAY -------------------------------------------------------- */

  // `to_status IN ('done','released')` in ticket_activity_log, not
  // /api/dashboard/summary's `yesterday`: that one is a ROLLING 24h count of
  // SESSIONS, which is neither calendar-today nor shipped tickets.
  const shipped = db
    .select({ shipped: sql<number>`COUNT(*)`.as("shipped") })
    .from(ticketActivityLog)
    .where(
      and(
        inArray(ticketActivityLog.projectId, projectIds),
        inArray(ticketActivityLog.toStatus, ["done", "released"]),
        sql`${ticketActivityLog.createdAt} >= ${todayFloor}`,
      ),
    )
    .get();

  const todaySessions = db
    .select({
      sessions: sql<number>`COUNT(*)`.as("sessions"),
      // COUNT over an empty range is 0; a bare SUM over the same empty range
      // is NULL, and the tile would print "— failed" beside "0 sessions" on a
      // quiet day. This figure is AVAILABLE and it is zero, so it is coalesced
      // — unlike `cost` below, where the NULL is the honest answer.
      failed:
        sql<number>`COALESCE(SUM(CASE WHEN ${agentSessions.status} = 'failed' THEN 1 ELSE 0 END), 0)`.as(
          "failed",
        ),
      // SUM answers NULL when nothing in range reported a cost. That NULL is
      // load-bearing: the tile renders an em-dash, never a zero.
      cost: sql<number | null>`SUM(${agentSessions.totalCostUsd})`.as("cost"),
      projects: sql<number>`COUNT(DISTINCT ${agentSessions.projectId})`.as("projects"),
    })
    .from(agentSessions)
    .where(
      and(
        inArray(agentSessions.projectId, projectIds),
        sql`${agentSessions.createdAt} >= ${todayFloor}`,
      ),
    )
    .get();

  /* ---- UP NEXT ------------------------------------------------------ */

  // Edges never cross projects (lib/dependencies/validation.ts raises
  // CrossProjectError), so per-project edge sets union safely: no global graph,
  // no global cycle check. The `project_id IN` bound is what makes that claim
  // structural rather than incidental, and it lands on
  // `ticket_dependencies_project_idx`.
  const edges: TicketDependencyEdge[] = db
    .select({
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
    })
    .from(ticketDependencies)
    .where(inArray(ticketDependencies.projectId, projectIds))
    .all();

  const { rows: readyToLand, heldBackCount } = deriveReadyToLand(deskEpics, busyEpicIds);

  /* ---- YOUR TURN ---------------------------------------------------- */

  // Bounded by the epics already in hand, so this stays one indexed lookup on
  // the (epic_id, kind) primary key rather than a scan of the whole table.
  const dismissals: DeskDismissalRow[] = deskEpics.length
    ? db
        .select({
          epicId: deskDismissals.epicId,
          kind: deskDismissals.kind,
          signalAt: deskDismissals.signalAt,
        })
        .from(deskDismissals)
        .where(
          inArray(
            deskDismissals.epicId,
            deskEpics.map((epic) => epic.id),
          ),
        )
        .all()
    : [];

  // Derive first, then subtract what the user has waved off: the dismissal is
  // a read-side filter and must never change how a signal is computed.
  const yourTurn = applyDeskDismissals(
    {
      awaitingReply: deriveAwaitingReply(deskEpics),
      failed: deriveFailures(failureSessions, epicsById, runningEpicIds),
      conflicts: deriveConflicts(deskEpics),
    },
    dismissals,
  );

  const payload: ControlDeskPayload = {
    generatedAt: now.toISOString(),
    projects: deskProjects,
    working,
    queued,
    today: deriveToday({
      ticketsShipped: shipped?.shipped ?? null,
      failedSessions: todaySessions?.failed ?? null,
      costUsd: todaySessions?.cost ?? null,
      projects: todaySessions?.projects ?? null,
      sessions: todaySessions?.sessions ?? null,
    }),
    yourTurn,
    readyToLand,
    heldBackCount,
    upNext: deriveUpNext(deskProjects, deskEpics, edges, busyEpicIds),
  };

  console.debug("[control-desk/GET] query profile", {
    projects: deskProjects.length,
    epics: deskEpics.length,
    working: working.length,
    queryMs: Date.now() - queryStartedAt,
  });

  return NextResponse.json({ data: payload });
}
