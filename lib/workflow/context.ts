/**
 * Builds TransitionContext from database state for workflow validation.
 */

import { db } from "@/lib/db";
import { agentSessions, reviewComments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { CODE_PRODUCING_AGENT_TYPES } from "@/lib/agent-config/constants";
import type { KanbanStatus } from "@/lib/types/kanban";
import type { TransitionContext } from "./engine";
import {
  blocksMergeSql,
  readReviewVerdictWindow,
} from "./blocking-findings";
import { hasStandingNegativeVerdict } from "@/lib/kanban/merge-readiness";

export function buildTransitionContext(opts: {
  epicId: string;
  userStoryId?: string;
  fromStatus: KanbanStatus;
  toStatus: KanbanStatus;
  actor: "user" | "agent" | "system";
  /**
   * The ACTING session — the one performing this transition. Besides
   * activity-log provenance it is the engine's owning-session exemption
   * input (lib/workflow/engine.ts): never pass a session id for
   * traceability alone.
   */
  sessionId?: string;
  requireCompletedReview?: boolean;
  requireResolvedComments?: boolean;
}): TransitionContext {
  const {
    epicId,
    userStoryId,
    fromStatus,
    toStatus,
    actor,
    sessionId,
    requireCompletedReview = true,
    requireResolvedComments = true,
  } = opts;

  // Open review comments that still stand in the way of `review -> done`.
  //
  // "Still" is the whole point: nothing resolves a review_comments row until
  // a human approves, so counting every open row kept an epic whose newest
  // review APPROVED it permanently unapprovable — over a [minor] that
  // reviewer filed itself, or a [major] an earlier round raised and a later
  // verdict did not re-report. `blocksMergeSql` is the one definition the
  // board and Full Auto's merge selector read too; a looser gate here than
  // there would make Full Auto merge and then roll itself back.
  //
  // One epic, so the windows are read as scalars rather than joined — the
  // grouped callers hoist them into a subquery instead (see
  // lib/workflow/blocking-findings.ts).
  const verdictWindow = readReviewVerdictWindow(db, epicId);
  const openComments = db
    .select()
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.epicId, epicId),
        eq(reviewComments.status, "open"),
        blocksMergeSql(verdictWindow.lastCleanVerdictReviewAt ?? "")
      )
    )
    .all();

  // Check for completed review sessions
  const completedReviewSessions = db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.epicId, epicId),
        userStoryId ? eq(agentSessions.userStoryId, userStoryId) : undefined,
        eq(agentSessions.status, "completed")
      )
    )
    .all()
    .filter((s) => {
      const agentType = s.agentType ?? "";
      return (
        agentType.includes("review") ||
        agentType === "security_reviewer" ||
        agentType === "code_reviewer" ||
        agentType === "compliance_reviewer" ||
        agentType === "feature_reviewer"
      );
    });

  // Only code-producing sessions own the in_progress column. Review, chat,
  // merge and other auxiliary sessions legitimately run in other columns.
  const activeBuildTypes = new Set<string>(CODE_PRODUCING_AGENT_TYPES);
  const runningSessions = db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.epicId, epicId),
        userStoryId ? eq(agentSessions.userStoryId, userStoryId) : undefined
      )
    )
    .all()
    .filter(
      (session) =>
        (session.status === "queued" || session.status === "running") &&
        activeBuildTypes.has(session.agentType ?? "")
    );

  // The acting session owns the ticket only when it is the sole live
  // code-producing session on it — a second concurrent build keeps the
  // lock in place (e.g. the epic while a sibling story is still building).
  // A story-scoped session's ownership stops at its story: on an
  // epic-scoped context (no userStoryId) it must never unlock the parent
  // epic, or a story agent could promote the epic past the sibling-story
  // rule that transitionBuildCompleted enforces.
  const soleActingSession =
    sessionId !== undefined &&
    runningSessions.length === 1 &&
    runningSessions[0].id === sessionId;

  // Is a `changes_requested` verdict still the epic's latest word?
  //
  // Read from the SAME two aggregates the board and `selectMergeCandidates`
  // read, and compared by the SAME function — an earlier cut of this sorted
  // session rows in JavaScript instead, which is a second implementation of
  // the fact that decides whether a merge lands. The board offering Full Auto
  // a candidate the engine then refuses costs a real merge and a rollback per
  // sweep, so the two must be one definition.
  //
  // Epic-scoped only: a story carries its own review decision, so the
  // parent's verdict must not speak for it.
  const hasNegativeReviewVerdict =
    userStoryId === undefined && hasStandingNegativeVerdict(verdictWindow);

  return {
    epicId,
    fromStatus,
    toStatus,
    hasOpenReviewComments: openComments.length > 0,
    hasCompletedReview: completedReviewSessions.length > 0,
    hasNegativeReviewVerdict,
    requireCompletedReview,
    requireResolvedComments,
    hasRunningSession: runningSessions.length > 0,
    storyOwnershipBoundary:
      soleActingSession &&
      userStoryId === undefined &&
      runningSessions[0].userStoryId !== null,
    ownsInProgress:
      soleActingSession &&
      (userStoryId !== undefined || !runningSessions[0].userStoryId),
    actor,
  };
}
