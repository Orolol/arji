/**
 * Workflow Rule Engine — State machine for epic/ticket transitions.
 *
 * Enforces valid transitions for both manual (UI drag-and-drop, API)
 * and programmatic (agent-triggered) status changes.
 */

import type { KanbanStatus } from "@/lib/types/kanban";

// ---------------------------------------------------------------------------
// Transition definitions
// ---------------------------------------------------------------------------

/**
 * Allowed status transitions for epics.
 * Key = current status, Value = set of statuses it can move to.
 */
const EPIC_TRANSITIONS: Record<KanbanStatus, readonly KanbanStatus[]> = {
  backlog: ["todo", "in_progress"],
  todo: ["backlog", "in_progress"],
  in_progress: ["todo", "review", "backlog"],
  review: ["in_progress", "done"],
  done: ["review", "in_progress", "released"],
  released: [], // Terminal state - no outbound transitions
};

/**
 * Conditions that must be met for specific transitions.
 * Returns null if valid, or an error message string if invalid.
 */
type TransitionGuard = (ctx: TransitionContext) => string | null;

export interface TransitionContext {
  epicId: string;
  fromStatus: KanbanStatus;
  toStatus: KanbanStatus;
  /** Whether all open review comments have been resolved */
  hasOpenReviewComments: boolean;
  /** Whether the epic has a completed review (at least one review session completed) */
  hasCompletedReview: boolean;
  /** Story approval is itself an explicit human review decision. */
  requireCompletedReview?: boolean;
  /** Story approval cannot resolve epic-scoped findings on its own. */
  requireResolvedComments?: boolean;
  /** Whether there is a queued/running code-producing session on this ticket */
  hasRunningSession: boolean;
  /** The actor initiating the transition */
  actor: "user" | "agent" | "system";
  /** The source route/action triggering this transition */
  source?: "approve" | "merge" | "drag" | "api" | "build" | "review" | "release";
}

const TRANSITION_GUARDS: TransitionGuard[] = [
  // A build session owns in_progress until its terminal handler promotes or
  // holds the ticket. Letting a concurrent drag move it would recreate the
  // active-session/orphaned-column state this engine is meant to prevent.
  (ctx) => {
    if (
      ctx.fromStatus === "in_progress" &&
      ctx.toStatus !== "in_progress" &&
      ctx.hasRunningSession
    ) {
      return "Cannot move an in-progress ticket while an agent session is queued or running.";
    }
    return null;
  },
  // Cannot move to Done without completed review
  (ctx) => {
    if (
      ctx.toStatus === "done" &&
      ctx.requireCompletedReview !== false &&
      !ctx.hasCompletedReview
    ) {
      return "Cannot move to Done: no completed review found. A review must be completed before marking as Done.";
    }
    return null;
  },
  // Cannot move to Done with open review comments
  (ctx) => {
    if (
      ctx.toStatus === "done" &&
      ctx.requireResolvedComments !== false &&
      ctx.hasOpenReviewComments
    ) {
      return "Cannot move to Done: there are unresolved review comments. Resolve all review comments first.";
    }
    return null;
  },
  // review → done requires explicit approval (approve route) or merge
  (ctx) => {
    if (
      ctx.fromStatus === "review" &&
      ctx.toStatus === "done" &&
      ctx.source !== "approve" &&
      ctx.source !== "merge"
    ) {
      return "Cannot move to Done: manual approval is required. Use the Approve action to move from Review to Done.";
    }
    return null;
  },
  // Only system actor can move to released
  (ctx) => {
    if (ctx.toStatus === "released" && ctx.actor !== "system") {
      return "Cannot move to Released: only the system can move tickets to the Released column during release creation.";
    }
    return null;
  },
  // Cannot drag to released
  (ctx) => {
    if (ctx.toStatus === "released" && ctx.source === "drag") {
      return "Cannot drag tickets to Released: tickets are automatically moved to Released when a release is created.";
    }
    return null;
  },
  // Cannot move away from released
  (ctx) => {
    if (ctx.fromStatus === "released") {
      return "Cannot change status: tickets in Released cannot be moved to another column.";
    }
    return null;
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TransitionValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Check whether a status transition is structurally allowed
 * (i.e. the edge exists in the state machine graph).
 */
export function isAllowedTransition(
  from: KanbanStatus,
  to: KanbanStatus
): boolean {
  if (from === to) return true; // same-column reorder is always valid
  const allowed = EPIC_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Full validation: checks both structural validity and guard conditions.
 */
export function validateTransition(
  ctx: TransitionContext
): TransitionValidationResult {
  // Same status is always valid (reorder within column)
  if (ctx.fromStatus === ctx.toStatus) {
    return { valid: true };
  }

  // Check structural validity
  if (!isAllowedTransition(ctx.fromStatus, ctx.toStatus)) {
    return {
      valid: false,
      error: `Invalid transition: cannot move from "${ctx.fromStatus}" to "${ctx.toStatus}". Allowed targets: ${EPIC_TRANSITIONS[ctx.fromStatus]?.join(", ") || "none"}.`,
    };
  }

  // Run guard conditions
  for (const guard of TRANSITION_GUARDS) {
    const error = guard(ctx);
    if (error) {
      return { valid: false, error };
    }
  }

  return { valid: true };
}
