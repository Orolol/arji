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
  /**
   * True when the newest EPIC-SCOPED review that recorded a structured
   * verdict recorded `changes_requested`, and nothing with a verdict has
   * spoken since.
   *
   * `hasCompletedReview` is satisfied by any completed review session ever,
   * so it cannot tell a standing rejection from a stale one; this can. It
   * exists because the merge paths land a branch on the base branch and must
   * not be where a rejected review is discovered. A NULL verdict never
   * clears it — a reviewer that deposited nothing overruled nothing.
   */
  hasNegativeReviewVerdict?: boolean;
  /** Story approval is itself an explicit human review decision. */
  requireCompletedReview?: boolean;
  /** Story approval cannot resolve epic-scoped findings on its own. */
  requireResolvedComments?: boolean;
  /** Whether there is a queued/running code-producing session on this ticket */
  hasRunningSession: boolean;
  /**
   * True only when the acting session is itself the sole queued/running
   * code-producing session on the ticket — i.e. the owner the in_progress
   * lock exists to protect. The owner may promote its own ticket to review
   * (the move the terminal handler makes once the work is committed); any
   * other target column — and any other actor, or any ticket with a second
   * live session — stays locked, so a dead or cancelled run can never
   * strand its work outside the columns the terminal handlers understand.
   */
  ownsInProgress?: boolean;
  /**
   * True when the lock fires because the sole live code-producing session
   * is a story build and the context targets its parent epic: ownership
   * stops at the story, so no concurrency wording applies — the refusal
   * is about scope, not about another session.
   */
  storyOwnershipBoundary?: boolean;
  /** The actor initiating the transition */
  actor: "user" | "agent" | "system";
  /** The source route/action triggering this transition */
  source?:
    | "approve"
    | "merge"
    | "drag"
    | "api"
    | "build"
    | "review"
    | "release"
    | "refinement";
}

const TRANSITION_GUARDS: TransitionGuard[] = [
  // The board refinement re-pass may only shuffle work between Backlog and
  // To do. This is the guardrail from the epic, and it lives here rather
  // than in the refinement prompt or its MCP routes on purpose: an agent
  // prompt is not a guard, and a route-level check only covers the routes
  // that remember to call it. Anything claiming source "refinement" is held
  // to the two planning columns, whatever asked for the move.
  (ctx) => {
    if (ctx.source !== "refinement") return null;
    const planning = (status: KanbanStatus) =>
      status === "backlog" || status === "todo";
    if (!planning(ctx.fromStatus) || !planning(ctx.toStatus)) {
      return "Refinement may only move tickets between Backlog and To do; In Progress, Review, Done and Released are out of its scope.";
    }
    return null;
  },
  // A build session owns in_progress until its terminal handler promotes or
  // holds the ticket. Letting a concurrent drag move it would recreate the
  // active-session/orphaned-column state this engine is meant to prevent.
  // The owning session itself is the owner the lock protects — but only the
  // promotion to review is exempt: the move the terminal handler makes once
  // the work is committed. A demote to todo/backlog by the owner would leave
  // the live run (and its eventual terminal handler) stranded in the wrong
  // column, so it stays locked, as does any move by anyone else or by a
  // ticket with a second live session.
  (ctx) => {
    if (
      ctx.fromStatus === "in_progress" &&
      ctx.toStatus !== "in_progress" &&
      ctx.hasRunningSession
    ) {
      if (ctx.ownsInProgress && ctx.toStatus === "review") return null;
      if (ctx.ownsInProgress) {
        return "The owning session may only move its in-progress ticket to review while a session is live on it.";
      }
      if (ctx.storyOwnershipBoundary) {
        return "A story build may only move its own story; the parent epic is promoted once every sibling story reaches review.";
      }
      return "Cannot move an in-progress ticket while another agent session is queued or running.";
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
  // A merge must not land a branch whose rejection is still unanswered.
  //
  // Scoped to `merge` on purpose. `approve` is a human explicitly making the
  // review decision — the same authority the spec gives explicit human story
  // approval — and refusing it would leave a rejected epic with no way out
  // but a fresh review. A merge has no such author.
  (ctx) => {
    if (
      ctx.toStatus === "done" &&
      ctx.source === "merge" &&
      ctx.hasNegativeReviewVerdict
    ) {
      return "Cannot merge to Done: a review requested changes and nothing has been fixed and re-reviewed since. Push a fix and re-review, or use Approve to override.";
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
