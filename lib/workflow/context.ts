/**
 * Builds TransitionContext from database state for workflow validation.
 */

import { db } from "@/lib/db";
import { agentSessions, reviewComments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { KanbanStatus } from "@/lib/types/kanban";
import type { TransitionContext } from "./engine";

export function buildTransitionContext(opts: {
  epicId: string;
  userStoryId?: string;
  fromStatus: KanbanStatus;
  toStatus: KanbanStatus;
  actor: "user" | "agent" | "system";
  requireCompletedReview?: boolean;
}): TransitionContext {
  const {
    epicId,
    userStoryId,
    fromStatus,
    toStatus,
    actor,
    requireCompletedReview = true,
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
  const activeBuildTypes = new Set(["build", "ticket_build", "team_build"]);
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
    hasRunningSession: runningSessions.length > 0,
    actor,
  };
}
