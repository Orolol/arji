/**
 * Builds TransitionContext from database state for workflow validation.
 */

import { db } from "@/lib/db";
import { agentSessions, reviewComments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { CODE_PRODUCING_AGENT_TYPES } from "@/lib/agent-config/constants";
import type { KanbanStatus } from "@/lib/types/kanban";
import type { TransitionContext } from "./engine";

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

  // Check for open review comments
  const openComments = db
    .select()
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.epicId, epicId),
        eq(reviewComments.status, "open")
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

  return {
    epicId,
    fromStatus,
    toStatus,
    hasOpenReviewComments: openComments.length > 0,
    hasCompletedReview: completedReviewSessions.length > 0,
    requireCompletedReview,
    requireResolvedComments,
    hasRunningSession: runningSessions.length > 0,
    // The acting session owns the ticket only when it is the sole live
    // code-producing session on it — a second concurrent build keeps the
    // lock in place (e.g. the epic while a sibling story is still building).
    // A story-scoped session's ownership stops at its story: on an
    // epic-scoped context (no userStoryId) it must never unlock the parent
    // epic, or a story agent could promote the epic past the sibling-story
    // rule that transitionBuildCompleted enforces.
    ownsInProgress:
      sessionId !== undefined &&
      runningSessions.length === 1 &&
      runningSessions[0].id === sessionId &&
      (userStoryId !== undefined || !runningSessions[0].userStoryId),
    actor,
  };
}
