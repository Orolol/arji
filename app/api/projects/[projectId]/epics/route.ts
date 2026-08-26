import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  frictions,
  gradingReports,
  reviewComments,
  ticketComments,
  ticketActivityLog,
  ticketReadCursors,
  userStories,
} from "@/lib/db/schema";
import { count, eq, or, sql, and, inArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { tryExportArjiJson } from "@/lib/sync/export";
import { createDependencies } from "@/lib/dependencies/crud";
import {
  CycleError,
  CrossProjectError,
  validateDagIntegrity,
} from "@/lib/dependencies/validation";
import {
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { createEpicSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { generateReadableId } from "@/lib/db/readable-id";
import { emitTicketCreated } from "@/lib/events/emit";
import { resolveOptionalMcpToken } from "@/lib/mcp/http-auth";
import {
  buildMcpCreateBugActivityReason,
  MCP_CREATE_BUG_ACTION_HEADER,
  MCP_CREATE_BUG_SOURCE_TICKET_HEADER,
} from "@/lib/mcp/create-bug-contract";
import {
  findOpenDuplicateBug,
  type OpenBugDuplicate,
} from "@/lib/mcp/create-bug";
import {
  aggregateGradingStatus,
  parseGradingEntries,
} from "@/lib/grading/report";
import { OPEN_FRICTION_STATUSES } from "@/lib/frictions/constants";
import { evaluateMergeReadiness } from "@/lib/kanban/merge-readiness";
import { MERGE_FAILURE_REASON_LIKE_PATTERNS } from "@/lib/workflow/merge-failure";
import {
  lastCleanReviewAtSql,
  lastTerminalCodeAtSql,
} from "@/lib/workflow/review-freshness";

class FrictionConversionConflict extends Error {}

/** Optional prose: blank is absence, so it is stored as NULL, not `""`. */
function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

class DuplicateMcpBugError extends Error {
  constructor(readonly existingBug: OpenBugDuplicate) {
    super(
      `An open bug with the same normalized title already exists: ${existingBug.readableId ?? existingBug.id}.`
    );
    this.name = "DuplicateMcpBugError";
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const queryStartedAt = Date.now();

  const storyCounts = db
    .select({
      epicId: userStories.epicId,
      usCount: count(userStories.id).as("us_count"),
      usDone:
        sql<number>`SUM(CASE WHEN ${userStories.status} = 'done' THEN 1 ELSE 0 END)`.as(
          "us_done"
        ),
    })
    .from(userStories)
    .groupBy(userStories.epicId)
    .as("story_counts");

  const rankedEpicComments = db
    .select({
      epicId: ticketComments.epicId,
      latestCommentId: ticketComments.id,
      latestCommentAuthor: ticketComments.author,
      latestCommentCreatedAt: ticketComments.createdAt,
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${ticketComments.epicId}
        ORDER BY ${ticketComments.createdAt} DESC, ${ticketComments.id} DESC
      )`.as("row_num"),
    })
    .from(ticketComments)
    .where(sql`${ticketComments.epicId} IS NOT NULL`)
    .as("ranked_epic_comments");

  const latestEpicComments = db
    .select({
      epicId: rankedEpicComments.epicId,
      latestCommentId: rankedEpicComments.latestCommentId,
      latestCommentAuthor: rankedEpicComments.latestCommentAuthor,
      latestCommentCreatedAt: rankedEpicComments.latestCommentCreatedAt,
    })
    .from(rankedEpicComments)
    .where(eq(rankedEpicComments.rowNum, 1))
    .as("latest_epic_comments");

  // Latest agent session per epic (any status) — carries the delivery
  // verdict driving the card's "awaiting reply" signal.
  const rankedEpicSessions = db
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
    .as("ranked_epic_sessions");

  const latestEpicSessions = db
    .select({
      epicId: rankedEpicSessions.epicId,
      latestSessionOutcome: rankedEpicSessions.latestSessionOutcome,
      latestSessionEndedAt: rankedEpicSessions.latestSessionEndedAt,
    })
    .from(rankedEpicSessions)
    .where(eq(rankedEpicSessions.rowNum, 1))
    .as("latest_epic_sessions");

  // Cumulative agent cost per epic — the sum of its sessions' reported
  // total_cost_usd. NULL (not 0) when no session ever reported a cost.
  const epicSessionCosts = db
    .select({
      epicId: agentSessions.epicId,
      sessionsCostUsd: sql<number | null>`SUM(${agentSessions.totalCostUsd})`.as(
        "sessions_cost_usd"
      ),
    })
    .from(agentSessions)
    .where(sql`${agentSessions.epicId} IS NOT NULL`)
    .groupBy(agentSessions.epicId)
    .as("epic_session_costs");

  const rankedGradingReports = db
    .select({
      epicId: gradingReports.epicId,
      latestGradingEntries: gradingReports.gradings,
      latestGradingSummary: gradingReports.summary,
      latestGradingCreatedAt: gradingReports.createdAt,
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${gradingReports.epicId}
        ORDER BY ${gradingReports.createdAt} DESC, ${gradingReports.id} DESC
      )`.as("grading_row_num"),
    })
    .from(gradingReports)
    .as("ranked_grading_reports");

  const latestGradingReports = db
    .select({
      epicId: rankedGradingReports.epicId,
      latestGradingEntries: rankedGradingReports.latestGradingEntries,
      latestGradingSummary: rankedGradingReports.latestGradingSummary,
      latestGradingCreatedAt: rankedGradingReports.latestGradingCreatedAt,
    })
    .from(rankedGradingReports)
    .where(eq(rankedGradingReports.rowNum, 1))
    .as("latest_grading_reports");

  // ---- Merge readiness ------------------------------------------------
  // The three facts lib/kanban/merge-readiness.ts turns into the board's
  // "Ready to merge" signal. They ride along in THIS query rather than a
  // follow-up call: the board polls, and one extra round trip per poll for a
  // per-card badge is the kind of cost that only shows up on a big board.

  // Open review findings per epic — the merge gate's blocking half.
  const openFindingCounts = db
    .select({
      epicId: reviewComments.epicId,
      openFindings: sql<number>`COUNT(*)`.as("open_findings"),
    })
    .from(reviewComments)
    .where(eq(reviewComments.status, "open"))
    .groupBy(reviewComments.epicId)
    .as("open_finding_counts");

  // Review/code freshness — the same aggregates Full Auto's sweep reads.
  const reviewFreshness = db
    .select({
      epicId: agentSessions.epicId,
      lastCleanReviewAt: lastCleanReviewAtSql().as("last_clean_review_at"),
      lastTerminalCodeAt: lastTerminalCodeAtSql().as("last_terminal_code_at"),
    })
    .from(agentSessions)
    .where(sql`${agentSessions.epicId} IS NOT NULL`)
    .groupBy(agentSessions.epicId)
    .as("review_freshness");

  // Newest "the branch could not land" activity entry. A failed merge writes
  // no column anywhere, so this same-state log row is the only durable trace
  // (see lib/workflow/merge-failure.ts for why the patterns are derived).
  const latestMergeFailures = db
    .select({
      epicId: ticketActivityLog.epicId,
      lastMergeFailureAt:
        sql<string | null>`MAX(REPLACE(${ticketActivityLog.createdAt}, ' ', 'T'))`.as(
          "last_merge_failure_at"
        ),
    })
    .from(ticketActivityLog)
    .where(
      and(
        // Scoped FIRST so `ticket_activity_log_project_idx` bounds the scan:
        // this table takes a row per transition AND per guard refusal across
        // every project, is never pruned, and the LIKEs below run against an
        // un-indexed column. The join to `epics` already scopes the result,
        // so this only narrows what SQLite has to string-match — on an
        // endpoint the board re-fetches on every `session:*` event.
        eq(ticketActivityLog.projectId, projectId),
        or(
          // Spelled out rather than composed from drizzle's `like()` so the
          // ESCAPE clause lands on the LIKE itself, whatever grouping the
          // helper decides to emit around its operands.
          ...MERGE_FAILURE_REASON_LIKE_PATTERNS.map(
            (pattern) =>
              sql`${ticketActivityLog.reason} LIKE ${pattern} ESCAPE '\\'`
          )
        )
      )
    )
    .groupBy(ticketActivityLog.epicId)
    .as("latest_merge_failures");

  // Latest user-authored comment per epic — a user comment newer than the
  // asked_question session counts as the reply.
  const latestUserComments = db
    .select({
      epicId: ticketComments.epicId,
      latestUserCommentCreatedAt: sql<string | null>`MAX(${ticketComments.createdAt})`.as(
        "latest_user_comment_created_at"
      ),
    })
    .from(ticketComments)
    .where(
      and(
        sql`${ticketComments.epicId} IS NOT NULL`,
        eq(ticketComments.author, "user")
      )
    )
    .groupBy(ticketComments.epicId)
    .as("latest_user_epic_comments");

  const result = db
    .select({
      id: epics.id,
      projectId: epics.projectId,
      title: epics.title,
      description: epics.description,
      priority: epics.priority,
      status: epics.status,
      position: epics.position,
      branchName: epics.branchName,
      prNumber: epics.prNumber,
      prUrl: epics.prUrl,
      prStatus: epics.prStatus,
      confidence: epics.confidence,
      evidence: epics.evidence,
      createdAt: epics.createdAt,
      updatedAt: epics.updatedAt,
      type: epics.type,
      linkedEpicId: epics.linkedEpicId,
      images: epics.images,
      readableId: epics.readableId,
      releaseId: epics.releaseId,
      usCount: sql<number>`COALESCE(${storyCounts.usCount}, 0)`,
      usDone: sql<number>`COALESCE(${storyCounts.usDone}, 0)`,
      latestCommentId: latestEpicComments.latestCommentId,
      latestCommentAuthor: latestEpicComments.latestCommentAuthor,
      latestCommentCreatedAt: latestEpicComments.latestCommentCreatedAt,
      latestSessionOutcome: latestEpicSessions.latestSessionOutcome,
      latestSessionEndedAt: latestEpicSessions.latestSessionEndedAt,
      latestUserCommentCreatedAt: latestUserComments.latestUserCommentCreatedAt,
      sessionsCostUsd: epicSessionCosts.sessionsCostUsd,
      latestGradingEntries: latestGradingReports.latestGradingEntries,
      gradingSummary: latestGradingReports.latestGradingSummary,
      gradingCreatedAt: latestGradingReports.latestGradingCreatedAt,
      // Per-epic read cursor (ticket_read_cursors) — the client derives the
      // "unread AI comment" dot from latestComment* vs this timestamp.
      lastReadAt: ticketReadCursors.lastReadAt,
      openFindings: openFindingCounts.openFindings,
      lastCleanReviewAt: reviewFreshness.lastCleanReviewAt,
      lastTerminalCodeAt: reviewFreshness.lastTerminalCodeAt,
      lastMergeFailureAt: latestMergeFailures.lastMergeFailureAt,
    })
    .from(epics)
    .leftJoin(storyCounts, eq(epics.id, storyCounts.epicId))
    .leftJoin(latestEpicComments, eq(epics.id, latestEpicComments.epicId))
    .leftJoin(latestEpicSessions, eq(epics.id, latestEpicSessions.epicId))
    .leftJoin(latestUserComments, eq(epics.id, latestUserComments.epicId))
    .leftJoin(epicSessionCosts, eq(epics.id, epicSessionCosts.epicId))
    .leftJoin(latestGradingReports, eq(epics.id, latestGradingReports.epicId))
    .leftJoin(ticketReadCursors, eq(epics.id, ticketReadCursors.epicId))
    .leftJoin(openFindingCounts, eq(epics.id, openFindingCounts.epicId))
    .leftJoin(reviewFreshness, eq(epics.id, reviewFreshness.epicId))
    .leftJoin(latestMergeFailures, eq(epics.id, latestMergeFailures.epicId))
    .where(eq(epics.projectId, projectId))
    .orderBy(epics.position)
    .all();

  console.debug("[epics/GET] query profile", {
    projectId,
    rowCount: result.length,
    queryMs: Date.now() - queryStartedAt,
  });

  // The readiness facts are inputs, not board data: they are folded into the
  // one derived signal the client consumes and dropped from the payload, so
  // no component can start re-deriving "ready" from a subset of them.
  const data = result.map(
    ({
      latestGradingEntries,
      openFindings,
      lastCleanReviewAt,
      lastTerminalCodeAt,
      lastMergeFailureAt,
      ...epic
    }) => ({
      ...epic,
      gradingStatus: aggregateGradingStatus(
        parseGradingEntries(latestGradingEntries),
      ),
      mergeReadiness: evaluateMergeReadiness({
        status: epic.status,
        branchName: epic.branchName,
        openFindings,
        lastCleanReviewAt,
        lastTerminalCodeAt,
        lastMergeFailureAt,
      }),
    }),
  );

  return NextResponse.json({ data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(createEpicSchema, request);
  if (isValidationError(validated)) return validated;

  const body = validated.data;

  // create_bug still enters through this exact UI route. A valid short-lived
  // MCP token upgrades its creation audit from an ordinary UI write to a
  // session-attributed agent write. Unauthenticated/spoofed headers are
  // ignored, so callers cannot impersonate an agent session.
  const optionalMcpAuth = resolveOptionalMcpToken(request);
  const isAttributedAgentBug =
    body.type === "bug" &&
    request.headers.get(MCP_CREATE_BUG_ACTION_HEADER) === "create_bug" &&
    optionalMcpAuth?.projectId === projectId &&
    optionalMcpAuth.agentType !== "chat";

  let sourceTicketForAudit: { id: string; readableId: string | null } | null = null;
  if (isAttributedAgentBug) {
    const sourceTicketId = request.headers.get(
      MCP_CREATE_BUG_SOURCE_TICKET_HEADER,
    );
    if (sourceTicketId) {
      sourceTicketForAudit =
        db
          .select({ id: epics.id, readableId: epics.readableId })
          .from(epics)
          .where(
            and(
              eq(epics.id, sourceTicketId),
              eq(epics.projectId, projectId),
            ),
          )
          .get() ?? null;
    }
  }

  const foundProject = getProjectOr404(projectId);
  if (isErrorResponse(foundProject)) return foundProject;
  const { project } = foundProject;

  const sourceFriction = body.frictionId
    ? db
        .select({ id: frictions.id, status: frictions.status })
        .from(frictions)
        .where(
          and(
            eq(frictions.id, body.frictionId),
            eq(frictions.projectId, projectId),
          ),
        )
        .get()
    : null;

  if (body.frictionId && !sourceFriction) {
    return NextResponse.json({ error: "Friction not found" }, { status: 404 });
  }
  if (
    sourceFriction &&
    !OPEN_FRICTION_STATUSES.includes(
      sourceFriction.status as (typeof OPEN_FRICTION_STATUSES)[number],
    )
  ) {
    return NextResponse.json(
      { error: "Only an open friction can be converted", code: "FRICTION_CLOSED" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();

  // Every story the caller sent gets inserted. `userStoryInput` already
  // rejected untitled ones, so there is nothing left to filter here — and
  // filtering is precisely what must not happen: silently dropping a member and
  // still answering 201 makes partial persistence look like success.
  const normalizedUserStories = (body.userStories ?? []).map((story) => ({
    title: story.title,
    description: trimmedOrNull(story.description),
    acceptanceCriteria: trimmedOrNull(story.acceptanceCriteria),
  }));

  // Friction conversions always enter through the ordinary backlog feature
  // path, even if a caller tries to smuggle another board status or type.
  const targetStatus = body.frictionId ? "backlog" : body.status || "backlog";
  const targetType = body.frictionId ? "feature" : body.type || "feature";

  const maxPos = db
    .select({ max: sql<number>`COALESCE(MAX(position), -1)` })
    .from(epics)
    .where(and(eq(epics.projectId, projectId), eq(epics.status, targetStatus)))
    .get();

  const id = createId();

  const storiesToInsert = normalizedUserStories.map((story, index) => ({
    id: createId(),
    epicId: id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    status: "todo",
    position: index,
    createdAt: now,
  }));

  // Normalize dependency edges provided by the generation agent, replacing
  // placeholder "$self" references with the newly created epic ID.
  let dependencyEdges = (Array.isArray(body.dependencies) ? body.dependencies : [])
    .filter(
      (dep) =>
        typeof dep?.ticketId === "string" &&
        typeof dep?.dependsOnTicketId === "string"
    )
    .map((dep) => ({
      ticketId: dep.ticketId === "$self" ? id : dep.ticketId,
      dependsOnTicketId:
        dep.dependsOnTicketId === "$self" ? id : dep.dependsOnTicketId,
    }));

  // Validate dependency edges BEFORE inserting the epic so semantic
  // dependency errors (cycle / cross-project) reject the request without
  // leaving a half-created epic behind.
  if (dependencyEdges.length > 0) {
    try {
      const referencedIds = new Set<string>();
      for (const edge of dependencyEdges) {
        referencedIds.add(edge.ticketId);
        referencedIds.add(edge.dependsOnTicketId);
      }
      // The new epic isn't inserted yet — skip its own id.
      referencedIds.delete(id);
      for (const referencedId of referencedIds) {
        const referenced = db
          .select({ id: epics.id, projectId: epics.projectId })
          .from(epics)
          .where(eq(epics.id, referencedId))
          .get();
        if (!referenced) {
          throw new Error(`Ticket "${referencedId}" not found`);
        }
        if (referenced.projectId !== projectId) {
          const edge = dependencyEdges.find(
            (e) =>
              e.ticketId === referencedId || e.dependsOnTicketId === referencedId
          );
          throw new CrossProjectError(
            edge?.ticketId ?? referencedId,
            edge?.dependsOnTicketId ?? referencedId
          );
        }
      }
      validateDagIntegrity(projectId, dependencyEdges);
    } catch (error) {
      if (error instanceof CycleError) {
        return NextResponse.json(
          { error: error.message, code: "CYCLE_DETECTED", cycle: error.cycle },
          { status: 422 }
        );
      }
      if (error instanceof CrossProjectError) {
        return NextResponse.json(
          { error: error.message, code: "CROSS_PROJECT_DEPENDENCY" },
          { status: 422 }
        );
      }
      // Non-critical (e.g. a referenced ticket doesn't exist): log and skip
      // dependency creation, but still create the epic.
      console.error("[epics/POST] Skipping invalid dependencies:", error);
      dependencyEdges = [];
    }
  }

  try {
    db.transaction((tx) => {
      if (isAttributedAgentBug) {
        const duplicate = findOpenDuplicateBug(projectId, body.title, tx);
        if (duplicate) throw new DuplicateMcpBugError(duplicate);
      }

      // Inside the transaction on purpose: this bumps `projects.ticket_counter`,
      // so run outside it the increment would survive a rolled-back insert and
      // burn a readable id on an epic that never existed — a permanent gap in
      // E-<slug>-NNN. `generateReadableId` asks its callers for exactly this.
      const readableId = generateReadableId(
        projectId,
        project.name,
        targetType as "feature" | "bug"
      );
      tx.insert(epics)
        .values({
          id,
          projectId,
          title: body.title,
          description: body.description || null,
          priority: body.priority ?? 0,
          status: targetStatus,
          position: (maxPos?.max ?? -1) + 1,
          branchName: body.branchName || null,
          confidence: body.confidence ?? null,
          evidence: body.evidence || null,
          createdAt: now,
          updatedAt: now,
          type: targetType,
          linkedEpicId: body.linkedEpicId || null,
          images: body.images ? JSON.stringify(body.images) : null,
          readableId: readableId || null,
        })
        .run();
      if (storiesToInsert.length > 0) {
        tx.insert(userStories).values(storiesToInsert).run();
      }
      if (body.frictionId) {
        const result = tx
          .update(frictions)
          .set({ status: "converted", epicId: id })
          .where(
            and(
              eq(frictions.id, body.frictionId),
              eq(frictions.projectId, projectId),
              inArray(frictions.status, [...OPEN_FRICTION_STATUSES]),
            ),
          )
          .run();
        if (result.changes !== 1) {
          throw new FrictionConversionConflict();
        }
      }
      if (isAttributedAgentBug && optionalMcpAuth) {
        const sourceTicketRef =
          sourceTicketForAudit?.readableId ??
          sourceTicketForAudit?.id ??
          "project-scoped session";
        tx.insert(ticketActivityLog)
          .values({
            id: createId(),
            projectId,
            epicId: id,
            fromStatus: body.status || "backlog",
            toStatus: body.status || "backlog",
            actor: "agent",
            reason: buildMcpCreateBugActivityReason({
              sourceTicketRef,
              sourceStoryId: optionalMcpAuth.userStoryId,
              sessionId: optionalMcpAuth.sessionId,
            }),
            sessionId: optionalMcpAuth.sessionId,
            createdAt: now,
          })
          .run();
      }
    });
  } catch (error) {
    if (error instanceof FrictionConversionConflict) {
      return NextResponse.json(
        { error: "Friction is no longer open", code: "FRICTION_CLOSED" },
        { status: 409 },
      );
    }
    if (error instanceof DuplicateMcpBugError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "DUPLICATE_BUG",
          existing_bug: {
            id: error.existingBug.id,
            readable_id: error.existingBug.readableId,
            title: error.existingBug.title,
            status: error.existingBug.status,
          },
        },
        { status: 409 }
      );
    }
    console.error("[epics/POST] Failed to create epic transaction:", error);
    return NextResponse.json({ error: "Failed to create epic" }, { status: 500 });
  }

  // Persist dependency edges (already validated above, before the insert)
  let dependenciesCreated = 0;
  if (dependencyEdges.length > 0) {
    try {
      const created = createDependencies(projectId, dependencyEdges);
      dependenciesCreated = created.length;
    } catch (error) {
      // Non-critical: validation ran before the insert, so anything thrown
      // here is unexpected — log but don't fail the epic creation.
      console.error("[epics/POST] Failed to create dependencies:", error);
    }
  }

  const epic = db.select().from(epics).where(eq(epics.id, id)).get();
  emitTicketCreated(projectId, id, body.title);
  tryExportArjiJson(projectId);
  return NextResponse.json(
    {
      data: {
        ...epic,
        userStoriesCreated: storiesToInsert.length,
        dependenciesCreated,
      },
    },
    { status: 201 },
  );
}
