import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  reviewComments,
  ticketComments,
  userStories,
} from "@/lib/db/schema";
import {
  findTicketsBlockedByDependencies,
  loadProjectGraph,
} from "@/lib/dependencies/validation";
import { isAwaitingReply } from "@/lib/kanban/awaiting-reply";
import { isPipelineRunActive } from "@/lib/pipeline/constants";
import { listPipelineRunsByProject } from "@/lib/pipeline/registry";
import { dagBatchRegistry } from "@/lib/agents/dag-batch-registry";
import { nightRunRegistry } from "@/lib/night/registry";
import { autoModeRegistry } from "./registry";

/**
 * Candidate selection for Full Auto Mode: which tickets may be built,
 * reviewed and merged right now.
 *
 * This module lives in lib/auto-mode/ rather than lib/kanban/ because it
 * queries the database — lib/kanban/ is client-safe by convention. It does
 * import the pure `isAwaitingReply` predicate from there, which is exactly
 * what that split is for.
 *
 * Every selector shares one board snapshot built from a FIXED number of
 * queries (ten), never one lookup per ticket: the sweep runs every 15s on a
 * board that can hold hundreds of tickets, so an N+1 here would be a
 * per-sweep table scan storm.
 *
 * The exclusions, in the order they matter:
 *
 *   busy         an active (queued|running) session on the ticket — the same
 *                condition `getRunningSessionForTarget` refuses on, evaluated
 *                in bulk. For a story this includes sessions on the PARENT
 *                epic, mirroring lib/agents/concurrency.ts:65-70, which is
 *                what serialises stories of one epic.
 *   owned        the ticket belongs to a live pipeline run, DAG wave batch or
 *                night run — the three conflicts the batch route already
 *                refuses on (build/route.ts:742-775).
 *   awaiting     the ticket is holding an unanswered agent question. An
 *                `asked_question` session leaves the ticket in `in_progress`
 *                exactly like a ticket bounced back from review, so without
 *                this guard the supervisor would bulldoze the question.
 *   parked       the supervisor already failed on this ticket three times.
 *   delivered    the epic is done/released — nothing to schedule.
 */

/* ------------------------------------------------------------------ */
/* Status vocabularies                                                 */
/* ------------------------------------------------------------------ */

const ACTIVE_SESSION_STATUSES = ["queued", "running"];

/**
 * Epic statuses the supervisor may dispatch a build for. Backlog is NOT
 * buildable: the board's To Do / In Progress columns are the only execution
 * queue, and a backlog ticket is not in the queue. Position — not priority —
 * is the queue's order (see compareEpics); "Sort by priority" makes
 * priority visible in the order by rewriting positions in bulk.
 */
const BUILDABLE_EPIC_STATUSES = new Set(["todo", "in_progress"]);

/** Story statuses the supervisor may dispatch a build for. */
const BUILDABLE_STORY_STATUSES = new Set(["todo", "in_progress"]);

/** Epics past the finish line — never candidates for anything. */
const DELIVERED_EPIC_STATUSES = new Set(["done", "released"]);

/**
 * Agent types that constitute "a review happened". Same family the workflow
 * engine's `hasCompletedReview` recognises (lib/workflow/context.ts:42-51).
 */
const REVIEW_AGENT_TYPES_SQL =
  "'review_security','review_code','review_compliance','review_feature'";

/**
 * Agent types that constitute "the code changed". `merge` counts: a
 * merge-fix agent rewrites the branch, so a review that predates it is stale.
 */
const CODE_AGENT_TYPES_SQL = "'build','ticket_build','team_build','merge'";

const TERMINAL_STATUSES_SQL = "'completed','failed','cancelled'";

/**
 * Session timestamps mix ISO-8601 (`2026-08-16T09:00:00.000Z`, written by
 * routes) and SQLite CURRENT_TIMESTAMP (`2026-08-16 09:00:00`). Normalising
 * the separator makes lexicographic MAX/compare chronologically correct —
 * the same normalisation lib/kanban/awaiting-reply.ts does in JS.
 */
const SESSION_AT_SQL = sql`REPLACE(COALESCE(${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}), ' ', 'T')`;

/** JS-side twin of the SQL normalisation above, for comparing timestamps. */
export function normalizeAt(value: string): string {
  return value.includes("T") ? value : value.replace(" ", "T");
}

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

export interface AutoBuildCandidate {
  scope: "epic" | "story";
  epicId: string;
  userStoryId: string | null;
  /** Parking / logging key: the story id for story scope, else the epic id. */
  ticketId: string;
  title: string;
  readableId: string | null;
}

export interface AutoReviewCandidate {
  epicId: string;
  ticketId: string;
  title: string;
  readableId: string | null;
}

export interface AutoMergeCandidate {
  epicId: string;
  ticketId: string;
  branchName: string;
  title: string;
  readableId: string | null;
}

/* ------------------------------------------------------------------ */
/* Board snapshot                                                      */
/* ------------------------------------------------------------------ */

interface EpicRow {
  id: string;
  status: string | null;
  position: number | null;
  branchName: string | null;
  title: string;
  readableId: string | null;
}

interface StoryRow {
  id: string;
  epicId: string;
  status: string | null;
  position: number | null;
  title: string;
}

interface SessionFacts {
  /**
   * Newest EPIC-SCOPED review session that completed with an actual verdict
   * (`outcome = 'answered'`). ONE signal drives both directions: an epic is
   * reviewable when there is no such session newer than its last code change,
   * and mergeable when there is. They are exact complements, which is what
   * makes "reviewed exactly once, then merged" true by construction.
   *
   * Everything else is NOT a review, and every one of them is bounded by the
   * engine's parking ladder rather than by this guard:
   *   - `failed` / `cancelled` — no review ran;
   *   - `silent` — the reviewer produced no verdict to act on. The engine
   *     charges it as a failure, so three silent reviews park the epic
   *     instead of leaving it neither reviewable nor mergeable;
   *   - `asked_question` — the reviewer asked rather than approved.
   *     `isAwaitingReply` holds the epic until the user answers, so the
   *     re-review that follows always has a human in the loop;
   *   - NULL — a legacy row from before outcomes were classified. Treating it
   *     as clean would auto-merge on a verdict nobody ever recorded, so it
   *     earns exactly one fresh, properly classified review.
   */
  lastCleanReviewAt: string | null;
  /**
   * Newest terminal code-writing session, story-scoped ones INCLUDED: a story
   * build commits to the epic's branch, so a review that predates it is stale.
   */
  lastTerminalCodeAt: string | null;
}

interface AwaitingFacts {
  latestSessionOutcome: string | null;
  latestSessionEndedAt: string | null;
  latestUserCommentCreatedAt: string | null;
}

export interface AutoModeBoard {
  projectId: string;
  epics: EpicRow[];
  storiesByEpic: Map<string, StoryRow[]>;
  busyEpicIds: Set<string>;
  busyStoryIds: Set<string>;
  blockedEpicIds: Set<string>;
  /** True when a DAG wave batch owns the whole project (no per-epic list). */
  projectBlocked: boolean;
  sessionFactsByEpic: Map<string, SessionFacts>;
  awaitingByEpic: Map<string, AwaitingFacts>;
  awaitingByStory: Map<string, AwaitingFacts>;
  /**
   * Newest USER comment per ticket, independent of whether an agent ever ran
   * on it. `awaiting*` carries the same timestamp but only for tickets that
   * HAVE a session, so the un-park ("the user touched it") check reads these
   * instead — a ticket parked on repeated dispatch failures has no session
   * row at all.
   */
  lastUserCommentByEpic: Map<string, string>;
  lastUserCommentByStory: Map<string, string>;
  openReviewCommentsByEpic: Map<string, number>;
  parkedTicketIds: Set<string>;
  /**
   * Epics whose merge is on a short backoff after a conflict nobody could be
   * dispatched to repair. Merge-only: they stay buildable and reviewable.
   */
  mergeDeferredEpicIds: Set<string>;
  /**
   * Dependency graph for the build selector's prerequisite gate: ticket →
   * its direct prerequisites. The schema's FKs scope both ends to epics
   * (epic-to-epic only), so a story's own prerequisites never block a
   * build — the parent epic's prerequisites already cover its stories.
   */
  dependencyGraph: Map<string, Set<string>>;
}

/**
 * Live in-memory owners of a ticket. Pipeline runs and night runs carry the
 * epics they own, so exclusion is per epic. A DAG wave batch does not
 * (DagBatchSnapshot has counts, not an epic list), so an active one blocks
 * the whole project — the same project-wide stance the batch route takes
 * when it refuses to start a night run over a live batch.
 */
function loadRegistryExclusions(projectId: string): {
  blockedEpicIds: Set<string>;
  projectBlocked: boolean;
} {
  const blockedEpicIds = new Set<string>();

  for (const run of listPipelineRunsByProject(projectId)) {
    if (isPipelineRunActive(run.state)) blockedEpicIds.add(run.epicId);
  }

  const night = nightRunRegistry.getActiveByProject(projectId);
  if (night) {
    for (const entry of night.epics) blockedEpicIds.add(entry.epicId);
  }

  return {
    blockedEpicIds,
    projectBlocked: dagBatchRegistry.listByProject(projectId).length > 0,
  };
}

/**
 * One board snapshot per sweep. Ten queries, all bounded by the project —
 * never one per ticket.
 */
export function loadAutoModeBoard(projectId: string): AutoModeBoard {
  // 1. Epics.
  const epicRows = db
    .select({
      id: epics.id,
      status: epics.status,
      position: epics.position,
      branchName: epics.branchName,
      title: epics.title,
      readableId: epics.readableId,
    })
    .from(epics)
    .where(eq(epics.projectId, projectId))
    .all();

  // 2. Stories (scoped through the parent epic — stories carry no projectId).
  const storyRows = db
    .select({
      id: userStories.id,
      epicId: userStories.epicId,
      status: userStories.status,
      position: userStories.position,
      title: userStories.title,
    })
    .from(userStories)
    .innerJoin(epics, eq(userStories.epicId, epics.id))
    .where(eq(epics.projectId, projectId))
    .all();

  const storiesByEpic = new Map<string, StoryRow[]>();
  for (const story of storyRows) {
    const list = storiesByEpic.get(story.epicId) ?? [];
    list.push(story);
    storiesByEpic.set(story.epicId, list);
  }
  for (const list of storiesByEpic.values()) {
    list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  // 3. Active sessions — the bulk form of getRunningSessionForTarget.
  const activeRows = db
    .select({
      epicId: agentSessions.epicId,
      userStoryId: agentSessions.userStoryId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        inArray(agentSessions.status, ACTIVE_SESSION_STATUSES)
      )
    )
    .all();

  const busyEpicIds = new Set<string>();
  const busyStoryIds = new Set<string>();
  for (const row of activeRows) {
    if (row.epicId) busyEpicIds.add(row.epicId);
    if (row.userStoryId) busyStoryIds.add(row.userStoryId);
  }

  // 4. Review/code freshness facts per epic (conditional aggregation).
  //
  // The review branches are EPIC-SCOPED (`user_story_id IS NULL`): reviews
  // and merges are epic-level by design, so a story review must never
  // satisfy the epic's merge gate. The code branch deliberately keeps story
  // sessions — they commit to the same branch.
  //
  // A review that answered through submit_findings with `changes_requested`
  // is NOT clean, findings or no findings: the verdict is the authoritative
  // channel (lib/pipeline/findings.ts), so an explicit NO must never satisfy
  // the merge gate. NULL stays clean — that is every MCP-less provider,
  // whose only verdict signal is the prose scan this gate never read. Any
  // other stored value (e.g. 'approved') keeps today's behaviour; unknown
  // values are treated as absent, matching readStructuredReviewVerdict.
  const factRows = db
    .select({
      epicId: agentSessions.epicId,
      lastCleanReviewAt: sql<string | null>`MAX(CASE
        WHEN ${agentSessions.status} = 'completed'
         AND ${agentSessions.userStoryId} IS NULL
         AND ${agentSessions.agentType} IN (${sql.raw(REVIEW_AGENT_TYPES_SQL)})
         AND ${agentSessions.outcome} = 'answered'
         AND (${agentSessions.reviewVerdict} IS NULL
              OR ${agentSessions.reviewVerdict} <> 'changes_requested')
        THEN ${SESSION_AT_SQL} END)`,
      lastTerminalCodeAt: sql<string | null>`MAX(CASE
        WHEN ${agentSessions.status} IN (${sql.raw(TERMINAL_STATUSES_SQL)})
         AND ${agentSessions.agentType} IN (${sql.raw(CODE_AGENT_TYPES_SQL)})
        THEN ${SESSION_AT_SQL} END)`,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        sql`${agentSessions.epicId} IS NOT NULL`
      )
    )
    .groupBy(agentSessions.epicId)
    .all();

  const sessionFactsByEpic = new Map<string, SessionFacts>();
  for (const row of factRows) {
    if (!row.epicId) continue;
    sessionFactsByEpic.set(row.epicId, {
      lastCleanReviewAt: row.lastCleanReviewAt ?? null,
      lastTerminalCodeAt: row.lastTerminalCodeAt ?? null,
    });
  }

  // 5 + 6. Latest session per epic / per story (the awaiting-reply verdict).
  //
  // Epic-scoped only (`user_story_id IS NULL`). A story session that asked a
  // question is the STORY's business: ranking it here would hold the parent
  // epic hostage, and the epic's own comment thread is not where a story
  // question is necessarily answered.
  const rankedEpicSessions = db
    .select({
      epicId: agentSessions.epicId,
      outcome: agentSessions.outcome,
      endedAt: sql<string | null>`COALESCE(
        ${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}
      )`.as("latest_session_ended_at"),
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${agentSessions.epicId}
        ORDER BY ${agentSessions.createdAt} DESC, ${agentSessions.id} DESC
      )`.as("session_row_num"),
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        sql`${agentSessions.epicId} IS NOT NULL`,
        sql`${agentSessions.userStoryId} IS NULL`
      )
    )
    .as("ranked_epic_sessions");

  const latestEpicSessions = db
    .select({
      epicId: rankedEpicSessions.epicId,
      outcome: rankedEpicSessions.outcome,
      endedAt: rankedEpicSessions.endedAt,
    })
    .from(rankedEpicSessions)
    .where(eq(rankedEpicSessions.rowNum, 1))
    .all();

  const rankedStorySessions = db
    .select({
      userStoryId: agentSessions.userStoryId,
      outcome: agentSessions.outcome,
      endedAt: sql<string | null>`COALESCE(
        ${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}
      )`.as("latest_story_session_ended_at"),
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${agentSessions.userStoryId}
        ORDER BY ${agentSessions.createdAt} DESC, ${agentSessions.id} DESC
      )`.as("story_session_row_num"),
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        sql`${agentSessions.userStoryId} IS NOT NULL`
      )
    )
    .as("ranked_story_sessions");

  const latestStorySessions = db
    .select({
      userStoryId: rankedStorySessions.userStoryId,
      outcome: rankedStorySessions.outcome,
      endedAt: rankedStorySessions.endedAt,
    })
    .from(rankedStorySessions)
    .where(eq(rankedStorySessions.rowNum, 1))
    .all();

  // 7 + 8. Latest USER comment per epic / per story (a reply to the question).
  const latestEpicUserComments = db
    .select({
      epicId: ticketComments.epicId,
      at: sql<string | null>`MAX(${ticketComments.createdAt})`,
    })
    .from(ticketComments)
    .innerJoin(epics, eq(ticketComments.epicId, epics.id))
    .where(
      and(eq(epics.projectId, projectId), eq(ticketComments.author, "user"))
    )
    .groupBy(ticketComments.epicId)
    .all();

  const latestStoryUserComments = db
    .select({
      userStoryId: ticketComments.userStoryId,
      at: sql<string | null>`MAX(${ticketComments.createdAt})`,
    })
    .from(ticketComments)
    .innerJoin(userStories, eq(ticketComments.userStoryId, userStories.id))
    .innerJoin(epics, eq(userStories.epicId, epics.id))
    .where(
      and(eq(epics.projectId, projectId), eq(ticketComments.author, "user"))
    )
    .groupBy(ticketComments.userStoryId)
    .all();

  const epicUserCommentAt = new Map<string, string>();
  for (const row of latestEpicUserComments) {
    if (row.epicId && row.at) epicUserCommentAt.set(row.epicId, row.at);
  }
  const storyUserCommentAt = new Map<string, string>();
  for (const row of latestStoryUserComments) {
    if (row.userStoryId && row.at) {
      storyUserCommentAt.set(row.userStoryId, row.at);
    }
  }

  const awaitingByEpic = new Map<string, AwaitingFacts>();
  for (const row of latestEpicSessions) {
    if (!row.epicId) continue;
    awaitingByEpic.set(row.epicId, {
      latestSessionOutcome: row.outcome ?? null,
      latestSessionEndedAt: row.endedAt ?? null,
      latestUserCommentCreatedAt: epicUserCommentAt.get(row.epicId) ?? null,
    });
  }

  const awaitingByStory = new Map<string, AwaitingFacts>();
  for (const row of latestStorySessions) {
    if (!row.userStoryId) continue;
    const story = storyRows.find((s) => s.id === row.userStoryId);
    // A story question notifies with a deep link to the EPIC
    // (handleAskedQuestionOutcome → buildEpicTargetUrl), so the user's reply
    // usually lands on the epic thread. Either thread counts as the answer.
    const replies = [
      storyUserCommentAt.get(row.userStoryId),
      story ? epicUserCommentAt.get(story.epicId) : undefined,
    ].filter((value): value is string => typeof value === "string");
    awaitingByStory.set(row.userStoryId, {
      latestSessionOutcome: row.outcome ?? null,
      latestSessionEndedAt: row.endedAt ?? null,
      latestUserCommentCreatedAt:
        replies.length > 0
          ? replies.reduce((a, b) => (normalizeAt(a) >= normalizeAt(b) ? a : b))
          : null,
    });
  }

  // 9. Open review comments per epic — the merge gate's blocking findings.
  const openReviewRows = db
    .select({
      epicId: reviewComments.epicId,
      openCount: sql<number>`COUNT(*)`,
    })
    .from(reviewComments)
    .innerJoin(epics, eq(reviewComments.epicId, epics.id))
    .where(
      and(eq(epics.projectId, projectId), eq(reviewComments.status, "open"))
    )
    .groupBy(reviewComments.epicId)
    .all();

  const openReviewCommentsByEpic = new Map<string, number>();
  for (const row of openReviewRows) {
    openReviewCommentsByEpic.set(row.epicId, Number(row.openCount ?? 0));
  }

  // 10. The dependency graph, for the build selector's prerequisite gate:
  // findTicketsBlockedByDependencies walks it in memory, applying the same
  // stop-at-delivered rule the batch route applies — with no query per
  // candidate.
  const dependencyGraph = loadProjectGraph(projectId);

  const { blockedEpicIds, projectBlocked } = loadRegistryExclusions(projectId);

  // An epic with merge work outstanding is off-limits to EVERY selector: git
  // is not transactional, and a merge (plus any conflict-agent retry) owns the
  // branch until it settles.
  for (const epicId of autoModeRegistry.mergingEpicIds(projectId)) {
    blockedEpicIds.add(epicId);
  }

  return {
    projectId,
    epics: epicRows,
    storiesByEpic,
    busyEpicIds,
    busyStoryIds,
    blockedEpicIds,
    projectBlocked,
    sessionFactsByEpic,
    awaitingByEpic,
    awaitingByStory,
    lastUserCommentByEpic: epicUserCommentAt,
    lastUserCommentByStory: storyUserCommentAt,
    openReviewCommentsByEpic,
    parkedTicketIds: autoModeRegistry.parkedTicketIds(projectId),
    mergeDeferredEpicIds: autoModeRegistry.mergeDeferredEpicIds(projectId),
    dependencyGraph,
  };
}

/* ------------------------------------------------------------------ */
/* Shared predicates                                                   */
/* ------------------------------------------------------------------ */

/** Epic-level exclusions every selector applies before looking at status. */
function isEpicSelectable(board: AutoModeBoard, epic: EpicRow): boolean {
  if (board.projectBlocked) return false;
  if (DELIVERED_EPIC_STATUSES.has(epic.status ?? "")) return false;
  if (board.blockedEpicIds.has(epic.id)) return false;
  if (board.busyEpicIds.has(epic.id)) return false;
  if (board.parkedTicketIds.has(epic.id)) return false;
  const awaiting = board.awaitingByEpic.get(epic.id);
  if (awaiting && isAwaitingReply(awaiting)) return false;
  return true;
}

/**
 * Board order: position ASC — the column's visual reading order. Position is
 * the single source of truth for execution order: what the user sees is what
 * the supervisor runs (WYSIWYG). Priority stays a badge and a filter, never
 * a scheduling criterion; the "Sort by priority" button makes it visible in
 * the order by rewriting positions in bulk.
 */
function compareEpics(a: EpicRow, b: EpicRow): number {
  return (a.position ?? 0) - (b.position ?? 0);
}

/**
 * The infinite-re-review guard.
 *
 * A review that PASSES leaves the epic in `review` (the pipeline never
 * auto-approves), so a naive "everything in review" selector would review the
 * same epic forever. The gate is temporal at its core — "has a review been
 * attempted since the last terminal code change?" is a fact, not a guess —
 * plus one verdict rule: since agent_sessions.review_verdict exists, a review
 * that answered `changes_requested` through submit_findings is not clean and
 * earns a fresh one (see lastCleanReviewAt). The prose fallback for MCP-less
 * providers is deliberately NOT parsed here; their rows stay NULL.
 *
 * "A review" means a completed, epic-scoped review that delivered a verdict —
 * see SessionFacts.lastCleanReviewAt for what is deliberately excluded and
 * why each exclusion cannot spin.
 */
export function needsReview(facts: SessionFacts | undefined): boolean {
  return !hasFreshCleanReview(facts);
}

/**
 * The merge gate's freshness half: a review that COMPLETED WITH A VERDICT
 * after the last code change.
 *
 * Stricter than the workflow engine's `hasCompletedReview` on both axes —
 * the engine accepts any completed review session ever, including one that
 * merely asked a question or produced nothing. That laxity is exactly what
 * this compensates for; the engine's guard stays the floor, not the ceiling.
 */
export function hasFreshCleanReview(facts: SessionFacts | undefined): boolean {
  if (!facts?.lastCleanReviewAt) return false;
  if (!facts.lastTerminalCodeAt) return true;
  return facts.lastCleanReviewAt > facts.lastTerminalCodeAt;
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

/**
 * Tickets a build agent may be dispatched onto, in board order.
 *
 * Granularity rule (git is the constraint — one worktree and one branch per
 * epic): an epic WITH stories yields at most ONE story candidate, because
 * `getRunningSessionForTarget` in story scope also matches the parent epic's
 * sessions, so two stories of one epic can never run in parallel anyway.
 * An epic WITHOUT stories yields itself, epic-scoped.
 *
 * Prerequisite gate: a candidate whose direct or transitive prerequisite is
 * not done/released is skipped this sweep. The decision is the shared walk
 * in lib/dependencies/validation.ts, run in memory over the snapshot's
 * graph + status map — one sweep, no query per candidate. A prerequisite
 * missing from the status map blocks conservatively.
 */
export function selectBuildCandidates(
  projectId: string,
  board: AutoModeBoard = loadAutoModeBoard(projectId)
): AutoBuildCandidate[] {
  const candidates: AutoBuildCandidate[] = [];

  // Prerequisite gate, pre-computed once for the whole sweep. Statuses come
  // from the snapshot itself — the board already read them in query 1.
  const statusOf = new Map<string, string | null>(
    board.epics.map((epic) => [epic.id, epic.status ?? null])
  );
  const blockedByDeps = findTicketsBlockedByDependencies(
    board.dependencyGraph,
    statusOf,
    board.epics.map((epic) => epic.id)
  );

  for (const epic of [...board.epics].sort(compareEpics)) {
    if (!isEpicSelectable(board, epic)) continue;
    if (blockedByDeps.has(epic.id)) continue;

    const stories = board.storiesByEpic.get(epic.id) ?? [];

    // The epic itself must be in the execution queue. This covers both
    // branches: a story-scoped dispatch would otherwise pull a Backlog epic
    // into the queue through the shared dispatch transition.
    if (!BUILDABLE_EPIC_STATUSES.has(epic.status ?? "")) continue;

    if (stories.length === 0) {
      candidates.push({
        scope: "epic",
        epicId: epic.id,
        userStoryId: null,
        ticketId: epic.id,
        title: epic.title,
        readableId: epic.readableId,
      });
      continue;
    }

    // Story scope: the first buildable story by position. The parent may
    // start in todo; the shared dispatch transition moves both parent and
    // story to in_progress before the queued session row is created.
    const next = stories.find((story) => {
      if (!BUILDABLE_STORY_STATUSES.has(story.status ?? "")) return false;
      if (board.busyStoryIds.has(story.id)) return false;
      if (board.parkedTicketIds.has(story.id)) return false;
      const awaiting = board.awaitingByStory.get(story.id);
      if (awaiting && isAwaitingReply(awaiting)) return false;
      return true;
    });
    if (!next) continue;

    candidates.push({
      scope: "story",
      epicId: epic.id,
      userStoryId: next.id,
      ticketId: next.id,
      title: next.title,
      readableId: epic.readableId,
    });
  }

  return candidates;
}

/**
 * Epics whose branch is ready for a review pass: sitting in `review` and not
 * reviewed since the last code change. Reviews are ALWAYS epic-scoped — the
 * branch is the integration unit, and reviewing each story then the epic
 * would pay twice for the same diff.
 */
export function selectReviewCandidates(
  projectId: string,
  board: AutoModeBoard = loadAutoModeBoard(projectId)
): AutoReviewCandidate[] {
  return [...board.epics]
    .sort(compareEpics)
    .filter((epic) => epic.status === "review")
    .filter((epic) => isEpicSelectable(board, epic))
    .filter((epic) => needsReview(board.sessionFactsByEpic.get(epic.id)))
    .map((epic) => ({
      epicId: epic.id,
      ticketId: epic.id,
      title: epic.title,
      readableId: epic.readableId,
    }));
}

/**
 * Epics whose review came back clean and whose branch can land: in `review`,
 * with a branch, reviewed since the last code change, and with zero open
 * review comments.
 *
 * This is the supervisor's own gate, and it is STRICTER than the workflow
 * engine's `→ done` guards on purpose. The engine still has the last word —
 * `applyTransition` refuses unless `hasCompletedReview` and no open comments
 * — but the engine's freshness is lax, so the temporal check above is what
 * makes "review is OK" mean something without inventing a new boolean.
 */
export function selectMergeCandidates(
  projectId: string,
  board: AutoModeBoard = loadAutoModeBoard(projectId)
): AutoMergeCandidate[] {
  return [...board.epics]
    .sort(compareEpics)
    .filter((epic) => epic.status === "review")
    .filter((epic) => !!epic.branchName)
    .filter((epic) => isEpicSelectable(board, epic))
    .filter((epic) => !board.mergeDeferredEpicIds.has(epic.id))
    .filter((epic) => hasFreshCleanReview(board.sessionFactsByEpic.get(epic.id)))
    .filter((epic) => (board.openReviewCommentsByEpic.get(epic.id) ?? 0) === 0)
    .map((epic) => ({
      epicId: epic.id,
      ticketId: epic.id,
      branchName: epic.branchName!,
      title: epic.title,
      readableId: epic.readableId,
    }));
}
