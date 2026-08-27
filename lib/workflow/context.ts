/**
 * Builds TransitionContext from database state for workflow validation.
 */

import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { CODE_PRODUCING_AGENT_TYPES } from "@/lib/agent-config/constants";
import { selectUnverifiableReviewSessionIds } from "@/lib/pipeline/findings";
import type { KanbanStatus } from "@/lib/types/kanban";
import type { TransitionContext } from "./engine";

export function buildTransitionContext(opts: {
  epicId: string;
  userStoryId?: string;
  fromStatus: KanbanStatus;
  toStatus: KanbanStatus;
  actor: "user" | "agent" | "system";
  /** Which state machine this transition runs on (default "epic"). */
  targetKind?: "epic" | "story";
  /**
   * The ACTING session — the one performing this transition. Besides
   * activity-log provenance it is the engine's owning-session exemption
   * input (lib/workflow/engine.ts): never pass a session id for
   * traceability alone.
   */
  sessionId?: string;
  requireCompletedReview?: boolean;
}): TransitionContext {
  const {
    epicId,
    userStoryId,
    fromStatus,
    toStatus,
    actor,
    targetKind = "epic",
    sessionId,
    requireCompletedReview = true,
  } = opts;

  // Check for completed review sessions.
  //
  // "Completed" is necessary but not sufficient: a review whose provider had
  // the structured channel and filed no verdict on it delivered no evidence
  // (lib/pipeline/findings.ts). Counting it here is what let a broken
  // findings channel unlock the merge boundary (review → to_merge) — the
  // reviewer's 401'd findings never became review_comments rows. Such a
  // session is tracked separately as `hasUnverifiableReview` so the engine
  // can say WHY it refuses instead of claiming no review ever ran.
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

  // Batched on purpose: the per-session helper costs three queries each, and
  // four review types over a few rounds turns one guarded transition into
  // dozens of unindexed reads. The rows are already in hand above.
  const unverifiableReviewIds = selectUnverifiableReviewSessionIds(
    completedReviewSessions
  );
  const verifiableReviewSessions = completedReviewSessions.filter(
    (session) => !unverifiableReviewIds.has(session.id)
  );

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

  return {
    epicId,
    fromStatus,
    toStatus,
    targetKind,
    hasCompletedReview: verifiableReviewSessions.length > 0,
    hasUnverifiableReview:
      verifiableReviewSessions.length === 0 &&
      completedReviewSessions.length > 0,
    requireCompletedReview,
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
