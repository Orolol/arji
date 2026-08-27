/**
 * Unified transition service — single entry point for all epic status changes.
 *
 * Centralises: context building, validation, DB update, event emission, and
 * activity logging so that every route uses the same pipeline.
 */

import { db } from "@/lib/db";
import { epics, userStories } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { KanbanStatus } from "@/lib/types/kanban";
import type { TransitionContext } from "./engine";
import { validateTransition } from "./engine";
import { buildTransitionContext } from "./context";
import { emitTicketMoved } from "@/lib/events/emit";
import { logTransition } from "./log";

export interface ApplyTransitionOpts {
  projectId: string;
  epicId: string;
  fromStatus: KanbanStatus;
  toStatus: KanbanStatus;
  actor: TransitionContext["actor"];
  source: NonNullable<TransitionContext["source"]>;
  reason?: string;
  /**
   * The ACTING session — the one performing this transition. Besides
   * activity-log provenance it is the engine's owning-session exemption
   * input (lib/workflow/engine.ts): never pass a session id for
   * traceability alone.
   */
  sessionId?: string;
  /** When true, only validate — skip DB update, emit, and log. */
  validateOnly?: boolean;
  /** Buffer the ticket:moved event in the caller until its transaction commits. */
  deferEvent?: boolean;
  /**
   * When true, validate as if every open review comment were already
   * resolved. For the approve flow's pre-merge check: approval bulk-resolves
   * comments and closes the ticket in one action, but must validate BEFORE
   * writing anything — the comment resolution included.
   */
  assumeReviewCommentsResolved?: boolean;
}

export interface ApplyTransitionResult {
  valid: boolean;
  error?: string;
  /** Stories deliberately left unchanged while their parent reached Done. */
  skippedStories?: SkippedStory[];
}

export interface SkippedStory {
  id: string;
  title: string;
  status: string;
}

export type StoryStatus = "todo" | "in_progress" | "review" | "done";

export interface ApplyStoryTransitionOpts {
  projectId: string;
  epicId: string;
  userStoryId: string;
  fromStatus: StoryStatus;
  toStatus: StoryStatus;
  actor: TransitionContext["actor"];
  source: NonNullable<TransitionContext["source"]>;
  reason: string;
  /**
   * The ACTING session — see ApplyTransitionOpts.sessionId; the engine's
   * owning-session exemption input as well as the activity-log provenance.
   */
  sessionId?: string;
  validateOnly?: boolean;
  /** Epic approval may synchronize child stories using the epic review. */
  reviewScope?: "story" | "epic";
  /** Explicit human story approval does not require a separate review-agent session. */
  requireCompletedReview?: boolean;
  /** Epic-scoped findings stay open when one child story is approved. */
  requireResolvedComments?: boolean;
  /**
   * Validate as if every open review comment were already resolved — for the
   * approve flow, which bulk-resolves them as part of the same action.
   */
  assumeReviewCommentsResolved?: boolean;
  /**
   * Whether this story's move gets an activity row of its own. Default true.
   *
   * Pass `false` for the child writes of an epic-scoped cascade — a build
   * start, a review promotion, a rejection or an approval that carries every
   * story along with its parent. There the epic's single entry IS the
   * movement, and one echo per story turns the ticket feed into N identical
   * "moved In Progress → Review" lines. Refusals are logged either way: a
   * refused child aborts the cascade, which is exactly what the trail needs
   * to say. Use `applyEpicCascadeTransition` for the parent write so the
   * movement keeps its line even when the epic's own status write is a no-op.
   */
  logActivity?: boolean;
}

export interface CompleteReviewedStoriesOpts {
  projectId: string;
  epicId: string;
  actor: TransitionContext["actor"];
  source: NonNullable<TransitionContext["source"]>;
  reason: string;
  sessionId?: string;
  validateOnly?: boolean;
  assumeReviewCommentsResolved?: boolean;
}

function logRefusedTransition(opts: {
  projectId: string;
  epicId: string;
  fromStatus: string;
  toStatus: string;
  actor: TransitionContext["actor"];
  error: string;
  reason?: string;
  sessionId?: string;
  target?: string;
}) {
  logTransition({
    projectId: opts.projectId,
    epicId: opts.epicId,
    fromStatus: opts.fromStatus,
    toStatus: opts.fromStatus,
    actor: opts.actor,
    reason: [
      opts.target,
      opts.reason,
      `Transition ${opts.fromStatus} → ${opts.toStatus} refused: ${opts.error}`,
    ]
      .filter(Boolean)
      .join(" — "),
    sessionId: opts.sessionId,
  });
}

/**
 * Validate and apply an epic status transition.
 *
 * 1. Builds transition context from DB state.
 * 2. Validates via the workflow engine.
 * 3. Updates the epic row.
 * 4. Emits a `ticket:moved` SSE event.
 * 5. Logs the transition to the activity log.
 */
export function applyTransition(opts: ApplyTransitionOpts): ApplyTransitionResult {
  const {
    projectId,
    epicId,
    fromStatus,
    toStatus,
    actor,
    source,
    reason,
    sessionId,
    validateOnly,
    deferEvent,
    assumeReviewCommentsResolved,
  } = opts;

  // Same-status is a no-op (reorder within column)
  if (fromStatus === toStatus) {
    return { valid: true };
  }

  // 1. Build context & validate. The acting session id feeds the engine's
  //  owning-session exemption: a live build may move the ticket it owns
  //  itself, while every concurrent actor stays locked out.
  const ctx = buildTransitionContext({
    epicId,
    fromStatus,
    toStatus,
    actor,
    sessionId,
  });
  ctx.source = source;
  if (assumeReviewCommentsResolved) {
    ctx.hasOpenReviewComments = false;
  }
  const result = validateTransition(ctx);
  if (!result.valid) {
    logRefusedTransition({
      projectId,
      epicId,
      fromStatus,
      toStatus,
      actor,
      error: result.error ?? "Unknown workflow guard failure",
      reason,
      sessionId,
    });
    return { valid: false, error: result.error };
  }

  // An epic cannot reach Done while reviewed child work remains stranded in
  // Review. Keeping this in the shared transition service is the safety net
  // for every completion path: approval, manual merge, Full Auto merge,
  // Resolve Merge and both merge-fix retries. The helper validates every
  // eligible child before writing any of them, and runs before the parent
  // write so a refused story transition can never leave a Done epic behind.
  const storyCompletion =
    toStatus === "done"
      ? completeReviewedStories({
          projectId,
          epicId,
          actor,
          source,
          reason: reason ?? "Parent epic completed",
          ...(sessionId ? { sessionId } : {}),
          validateOnly,
          assumeReviewCommentsResolved,
        })
      : { valid: true as const };
  if (!storyCompletion.valid) {
    return storyCompletion;
  }

  // In validate-only mode, stop after validation
  if (validateOnly) {
    return {
      valid: true,
      ...(storyCompletion.skippedStories
        ? { skippedStories: storyCompletion.skippedStories }
        : {}),
    };
  }

  // 2. DB update
  db.update(epics)
    .set({ status: toStatus, updatedAt: new Date().toISOString() })
    .where(eq(epics.id, epicId))
    .run();

  // 3. Emit SSE event
  if (!deferEvent) {
    emitTicketMoved(projectId, epicId, fromStatus, toStatus);
  }

  // 4. Log to activity log
  logTransition({
    projectId,
    epicId,
    fromStatus,
    toStatus,
    actor,
    reason,
    sessionId,
  });

  return {
    valid: true,
    ...(storyCompletion.skippedStories
      ? { skippedStories: storyCompletion.skippedStories }
      : {}),
  };
}

/**
 * Validate and apply a user-story transition through the same state machine.
 * Story activity is recorded on its parent epic (the activity schema is
 * epic-scoped), with the story id embedded in the reason for traceability.
 */
export function applyStoryTransition(
  opts: ApplyStoryTransitionOpts
): ApplyTransitionResult {
  const {
    projectId,
    epicId,
    userStoryId,
    fromStatus,
    toStatus,
    actor,
    source,
    reason,
    sessionId,
    validateOnly,
    reviewScope = "story",
    requireCompletedReview = true,
    requireResolvedComments = true,
    assumeReviewCommentsResolved,
    logActivity = true,
  } = opts;

  if (fromStatus === toStatus) return { valid: true };

  const ctx = buildTransitionContext({
    epicId,
    ...(reviewScope === "story" ? { userStoryId } : {}),
    fromStatus,
    toStatus,
    actor,
    sessionId,
    requireCompletedReview,
    requireResolvedComments,
  });
  ctx.source = source;
  if (assumeReviewCommentsResolved) {
    ctx.hasOpenReviewComments = false;
  }
  const result = validateTransition(ctx);
  if (!result.valid) {
    logRefusedTransition({
      projectId,
      epicId,
      fromStatus,
      toStatus,
      actor,
      error: result.error ?? "Unknown workflow guard failure",
      reason,
      sessionId,
      target: `Story ${userStoryId}`,
    });
    return { valid: false, error: result.error };
  }

  if (validateOnly) return { valid: true };

  db.update(userStories)
    .set({ status: toStatus })
    .where(eq(userStories.id, userStoryId))
    .run();
  if (logActivity) {
    logTransition({
      projectId,
      epicId,
      fromStatus,
      toStatus,
      actor,
      reason: `Story ${userStoryId} — ${reason}`,
      sessionId,
    });
  }

  return { valid: true };
}

/**
 * Close the reviewed stories that belong to an epic completion.
 *
 * Non-review stories are intentionally not coerced: work added late or still
 * being built keeps its status and is reported in one same-state activity
 * entry. Reviewed stories each receive their own transition-service activity
 * row so the detail view can account for every child that actually closed.
 */
export function completeReviewedStories(
  opts: CompleteReviewedStoriesOpts
): ApplyTransitionResult {
  const stories = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, opts.epicId))
    .all();
  const reviewedStories = stories.filter((story) => story.status === "review");
  const skippedStories: SkippedStory[] = stories
    .filter((story) => story.status !== "review")
    .map((story) => ({
      id: story.id,
      title: story.title,
      status: story.status ?? "todo",
    }));

  // Validate the complete set before changing one child. Epic-scoped review
  // evidence authorizes the synchronized review → done moves.
  for (const story of reviewedStories) {
    const validation = applyStoryTransition({
      projectId: opts.projectId,
      epicId: opts.epicId,
      userStoryId: story.id,
      fromStatus: "review",
      toStatus: "done",
      actor: opts.actor,
      source: opts.source,
      reason: opts.reason,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      reviewScope: "epic",
      validateOnly: true,
      assumeReviewCommentsResolved: opts.assumeReviewCommentsResolved,
    });
    if (!validation.valid) {
      return {
        ...validation,
        ...(skippedStories.length > 0 ? { skippedStories } : {}),
      };
    }
  }

  if (opts.validateOnly) {
    return {
      valid: true,
      ...(skippedStories.length > 0 ? { skippedStories } : {}),
    };
  }

  for (const story of reviewedStories) {
    const transition = applyStoryTransition({
      projectId: opts.projectId,
      epicId: opts.epicId,
      userStoryId: story.id,
      fromStatus: "review",
      toStatus: "done",
      actor: opts.actor,
      source: opts.source,
      reason: opts.reason,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      reviewScope: "epic",
      assumeReviewCommentsResolved: opts.assumeReviewCommentsResolved,
    });
    if (!transition.valid) {
      return {
        ...transition,
        ...(skippedStories.length > 0 ? { skippedStories } : {}),
      };
    }
  }

  if (skippedStories.length > 0) {
    logWorkflowDecision({
      projectId: opts.projectId,
      epicId: opts.epicId,
      status: "done",
      actor: opts.actor,
      reason: `Epic completed; ${skippedStories.length} non-review ${skippedStories.length === 1 ? "story was" : "stories were"} left unchanged (${skippedStories.map((story) => `${story.id}:${story.status}`).join(", ")})`,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    });
  }

  return {
    valid: true,
    ...(skippedStories.length > 0 ? { skippedStories } : {}),
  };
}

/**
 * The parent write of an epic-scoped cascade: one activity line for the whole
 * movement, children included.
 *
 * Identical to `applyTransition` except when the epic is already sitting in
 * the target column — `applyTransition` treats that as a reorder no-op and
 * logs nothing. That is right for a lone epic write, but here the children
 * moved and their rows were folded away (`logActivity: false`), so returning
 * silently would erase the movement from the trail. A same-state entry keeps
 * it visible: the epic promoted by its own owning session through MCP, then
 * completing with its stories, is the case that hits this.
 */
export function applyEpicCascadeTransition(
  opts: ApplyTransitionOpts
): ApplyTransitionResult {
  if (opts.fromStatus !== opts.toStatus || opts.validateOnly) {
    return applyTransition(opts);
  }
  logWorkflowDecision({
    projectId: opts.projectId,
    epicId: opts.epicId,
    status: opts.fromStatus,
    actor: opts.actor,
    reason: opts.reason ?? `Ticket held in ${opts.fromStatus}`,
    sessionId: opts.sessionId,
  });
  return { valid: true };
}

/** Record a workflow decision that intentionally keeps a ticket in place. */
export function logWorkflowDecision(opts: {
  projectId: string;
  epicId: string;
  status: string;
  actor: TransitionContext["actor"];
  reason: string;
  sessionId?: string;
}) {
  logTransition({
    projectId: opts.projectId,
    epicId: opts.epicId,
    fromStatus: opts.status,
    toStatus: opts.status,
    actor: opts.actor,
    reason: opts.reason,
    sessionId: opts.sessionId,
  });
}
