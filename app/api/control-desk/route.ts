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
  deriveAwaitingReply,
  deriveConflicts,
  deriveFailures,
  deriveProjects,
  deriveQueued,
  deriveReadyToLand,
  deriveToday,
  deriveUpNext,
  deriveWorking,
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
 * SCAN DISCIPLINE. Every query that drops the project filter is bounded:
 * - the session scans by `created_at >= cutoff` (14 days), so
 *   `agent_sessions(project_id, created_at)` still prunes;
 * - the merge-readiness scans by `epic_id IN (<to_merge epics>)`, which is a
 *   TIGHTER bound than a time cutoff and lands on `agent_sessions_epic_idx` /
 *   `ticket_activity_log_epic_idx`. It also keeps the answers exact: those
 *   facts are MAX over an epic's whole history, and truncating the history
 *   would make an old `changes_requested` verdict vanish and the ticket read
 *   as ready to merge.
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

export async function GET() {
  const queryStartedAt = Date.now();
  const now = new Date();
  const cutoff = lookbackCutoff(now);
  const todayFloor = startOfTodayUtc(now);

  /* ---- projects ---------------------------------------------------- */

  const activeAgentCounts = db
    .select({
      projectId: agentSessions.projectId,
      activeAgents: sql<number>`COUNT(*)`.as("active_agents"),
    })
    .from(agentSessions)
    .where(eq(agentSessions.status, "running"))
    .groupBy(agentSessions.projectId)
    .as("active_agent_counts");

  const projectRows = db
    .select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
      activeAgents: sql<number>`COALESCE(${activeAgentCounts.activeAgents}, 0)`,
    })
    .from(projects)
    .leftJoin(activeAgentCounts, eq(projects.id, activeAgentCounts.projectId))
    .all();

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

  const deskProjects = deriveProjects(
    projectRows.map((row) => ({
      ...row,
      autoModeEnabled:
        parseAutoModeEnabled(autoModeByKey.get(autoModeEnabledSettingKey(row.id))) ??
        globalAutoMode,
    })),
  );

  /* ---- WORKING / QUEUED -------------------------------------------- */

  // `last_non_empty_text` is UNCAPPED at the write side — a CLI emitting one
  // 4 MB line stores 4 MB, which is why the sessions LIST route reduces it to a
  // boolean. The desk actually prints the line, so it takes a substring in SQL
  // and never selects the raw column.
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
      prompt: agentSessions.prompt,
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

  const rankedComments = db
    .select({
      epicId: ticketComments.epicId,
      latestCommentId: ticketComments.id,
      latestCommentAuthor: ticketComments.author,
      latestCommentContent: ticketComments.content,
      latestCommentCreatedAt: ticketComments.createdAt,
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${ticketComments.epicId}
        ORDER BY ${ticketComments.createdAt} DESC, ${ticketComments.id} DESC
      )`.as("row_num"),
    })
    .from(ticketComments)
    .where(sql`${ticketComments.epicId} IS NOT NULL`)
    .as("ranked_comments");

  const latestComments = db
    .select({
      epicId: rankedComments.epicId,
      latestCommentId: rankedComments.latestCommentId,
      latestCommentAuthor: rankedComments.latestCommentAuthor,
      latestCommentContent: rankedComments.latestCommentContent,
      latestCommentCreatedAt: rankedComments.latestCommentCreatedAt,
    })
    .from(rankedComments)
    .where(eq(rankedComments.rowNum, 1))
    .as("latest_comments");

  const rankedSessions = db
    .select({
      epicId: agentSessions.epicId,
      latestSessionOutcome: agentSessions.outcome,
      latestSessionEndedAt: sql<string | null>`COALESCE(
        ${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}
      )`.as("latest_session_ended_at"),
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${agentSessions.epicId}
        ORDER BY ${agentSessions.createdAt} DESC, ${agentSessions.id} DESC
      )`.as("session_row_num"),
    })
    .from(agentSessions)
    .where(sql`${agentSessions.epicId} IS NOT NULL`)
    .as("ranked_sessions");

  const latestSessions = db
    .select({
      epicId: rankedSessions.epicId,
      latestSessionOutcome: rankedSessions.latestSessionOutcome,
      latestSessionEndedAt: rankedSessions.latestSessionEndedAt,
    })
    .from(rankedSessions)
    .where(eq(rankedSessions.rowNum, 1))
    .as("latest_sessions");

  const latestUserComments = db
    .select({
      epicId: ticketComments.epicId,
      latestUserCommentCreatedAt: sql<
        string | null
      >`MAX(${ticketComments.createdAt})`.as("latest_user_comment_created_at"),
    })
    .from(ticketComments)
    .where(
      and(
        sql`${ticketComments.epicId} IS NOT NULL`,
        eq(ticketComments.author, "user"),
      ),
    )
    .groupBy(ticketComments.epicId)
    .as("latest_user_comments");

  const storyCounts = db
    .select({
      epicId: userStories.epicId,
      usCount: sql<number>`COUNT(${userStories.id})`.as("us_count"),
      usDone:
        sql<number>`SUM(CASE WHEN ${userStories.status} = 'done' THEN 1 ELSE 0 END)`.as(
          "us_done",
        ),
    })
    .from(userStories)
    .groupBy(userStories.epicId)
    .as("story_counts");

  const epicRows = db
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
      usCount: sql<number>`COALESCE(${storyCounts.usCount}, 0)`,
      usDone: sql<number>`COALESCE(${storyCounts.usDone}, 0)`,
      latestCommentId: latestComments.latestCommentId,
      latestCommentAuthor: latestComments.latestCommentAuthor,
      latestCommentContent: latestComments.latestCommentContent,
      latestCommentCreatedAt: latestComments.latestCommentCreatedAt,
      latestSessionOutcome: latestSessions.latestSessionOutcome,
      latestSessionEndedAt: latestSessions.latestSessionEndedAt,
      latestUserCommentCreatedAt: latestUserComments.latestUserCommentCreatedAt,
      lastReadAt: ticketReadCursors.lastReadAt,
    })
    .from(epics)
    .innerJoin(projects, eq(epics.projectId, projects.id))
    .leftJoin(storyCounts, eq(epics.id, storyCounts.epicId))
    .leftJoin(latestComments, eq(epics.id, latestComments.epicId))
    .leftJoin(latestSessions, eq(epics.id, latestSessions.epicId))
    .leftJoin(latestUserComments, eq(epics.id, latestUserComments.epicId))
    .leftJoin(ticketReadCursors, eq(epics.id, ticketReadCursors.epicId))
    .orderBy(epics.position)
    .all();

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
  const newestSessionAt = db
    .select({
      epicId: agentSessions.epicId,
      newestAt: sql<string>`MAX(${agentSessions.createdAt})`.as("newest_at"),
    })
    .from(agentSessions)
    .where(
      and(
        sql`${agentSessions.epicId} IS NOT NULL`,
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
        inArray(ticketActivityLog.toStatus, ["done", "released"]),
        sql`${ticketActivityLog.createdAt} >= ${todayFloor}`,
      ),
    )
    .get();

  const todaySessions = db
    .select({
      sessions: sql<number>`COUNT(*)`.as("sessions"),
      failed: sql<number>`SUM(CASE WHEN ${agentSessions.status} = 'failed' THEN 1 ELSE 0 END)`.as(
        "failed",
      ),
      // SUM answers NULL when nothing in range reported a cost. That NULL is
      // load-bearing: the tile renders an em-dash, never a zero.
      cost: sql<number | null>`SUM(${agentSessions.totalCostUsd})`.as("cost"),
      projects: sql<number>`COUNT(DISTINCT ${agentSessions.projectId})`.as("projects"),
    })
    .from(agentSessions)
    .where(sql`${agentSessions.createdAt} >= ${todayFloor}`)
    .get();

  /* ---- UP NEXT ------------------------------------------------------ */

  // Edges never cross projects (lib/dependencies/validation.ts raises
  // CrossProjectError), so per-project edge sets union safely: no global graph,
  // no global cycle check.
  const edges: TicketDependencyEdge[] = db
    .select({
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
    })
    .from(ticketDependencies)
    .all();

  const { rows: readyToLand, heldBackCount } = deriveReadyToLand(deskEpics, busyEpicIds);

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
    yourTurn: {
      awaitingReply: deriveAwaitingReply(deskEpics),
      failed: deriveFailures(failureSessions, epicsById, runningEpicIds),
      conflicts: deriveConflicts(deskEpics),
    },
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
