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
  review: ["in_progress", "to_merge"],
  to_merge: ["review", "in_progress", "done"],
  done: ["review", "in_progress", "released"],
  released: [], // Terminal state - no outbound transitions
};

/**
 * Allowed status transitions for user stories. Stories never merge on their
 * own — the epic's branch is the unit of merge — so their machine has no
 * `to_merge`: a reviewed story sits in `review` until a human approves it or
 * the parent epic's merge cascades it to `done`.
 */
const STORY_TRANSITIONS: Partial<
  Record<KanbanStatus, readonly KanbanStatus[]>
> = {
  todo: ["in_progress"],
  in_progress: ["todo", "review"],
  review: ["in_progress", "done"],
  done: ["review", "in_progress"],
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
  /**
   * Which state machine this transition runs on. Epics carry the merge
   * boundary (`to_merge`); stories close through approval or their epic's
   * merge cascade. Defaults to "epic".
   */
  targetKind?: "epic" | "story";
  /**
   * Whether the epic has a completed review that actually delivered evidence
   * — at least one completed review session that is not `unverifiable`
   * (lib/workflow/context.ts).
   */
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
  /**
   * Whether every completed review on the epic is unverifiable: it ran on a
   * provider with the structured `submit_findings` channel and filed no
   * verdict on it. Purely a REASON refinement — `hasCompletedReview` is
   * already false in that case; this exists so the refusal can name the
   * broken channel instead of claiming no review ever ran.
   */
  hasUnverifiableReview?: boolean;
  /** Story approval is itself an explicit human review decision. */
  requireCompletedReview?: boolean;
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
      return "Refinement may only move tickets between Backlog and To do; In Progress, Review, To Merge, Done and Released are out of its scope.";
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
  // A review ran, but its verdict never reached Arij. Ordered BEFORE the
  // generic "no completed review" refusal so the operator gets the actionable
  // sentence: the reviewer is not missing, its findings channel is broken,
  // and the fix is another review rather than another look at the board.
  (ctx) => {
    if (
      ctx.toStatus === "to_merge" &&
      ctx.requireCompletedReview !== false &&
      !ctx.hasCompletedReview &&
      ctx.hasUnverifiableReview
    ) {
      // "every" and not "the last": hasUnverifiableReview is
      // `no verifiable review AND at least one completed one`
      // (lib/workflow/context.ts), so an epic with one good review and one
      // broken one never reaches this branch.
      return "Cannot move to To Merge: every completed review filed no verdict through submit_findings, so nothing they found is recorded. Run a review that completes before the ticket can be merged.";
    }
    return null;
  },
  // Cannot move to To Merge without completed review
  (ctx) => {
    if (
      ctx.toStatus === "to_merge" &&
      ctx.requireCompletedReview !== false &&
      !ctx.hasCompletedReview
    ) {
      return "Cannot move to To Merge: no completed review found. A review must be completed before the ticket can be merged.";
    }
    return null;
  },
  // Agents reach To Merge only through a review verdict (the review drivers
  // use source "review"). An agent poking update_ticket_status (source "api")
  // must not be able to skip the review boundary; humans stay free to drag.
  (ctx) => {
    if (
      ctx.toStatus === "to_merge" &&
      ctx.actor === "agent" &&
      ctx.source !== "review"
    ) {
      return "Cannot move to To Merge: only a passing review verdict promotes a ticket to To Merge.";
    }
    return null;
  },
  // A merge must not land a branch whose rejection is still unanswered.
  //
  // Scoped to `merge` on purpose, and it survives the merge-as-approval
  // rework: with no approve route left for epics, a merge is the only way
  // into Done, so this is the only place a standing `changes_requested`
  // verdict can still be caught. The way out is a fix and a fresh review —
  // the same verdict that promotes the epic to To Merge.
  (ctx) => {
    if (
      ctx.toStatus === "done" &&
      ctx.source === "merge" &&
      ctx.hasNegativeReviewVerdict
    ) {
      return "Cannot merge to Done: a review requested changes and nothing has been fixed and re-reviewed since. Push a fix and re-review before merging.";
    }
    return null;
  },
  // Done is reached exclusively through a successful merge — the merge IS the
  // approval. There is no manual approve step for epics. Stories are the one
  // exception: they have no branch of their own, so an explicit human story
  // approval or the parent epic's merge cascade closes them.
  (ctx) => {
    if (ctx.toStatus !== "done") return null;
    if (ctx.targetKind === "story") {
      if (ctx.source !== "approve" && ctx.source !== "merge") {
        return "Cannot move story to Done: a story is completed by approving it or by merging its parent epic.";
      }
      return null;
    }
    if (ctx.source !== "merge") {
      return "Cannot move to Done: a ticket reaches Done through a successful merge. Use the Merge action.";
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
  to: KanbanStatus,
  targetKind: "epic" | "story" = "epic"
): boolean {
  if (from === to) return true; // same-column reorder is always valid
  const graph = targetKind === "story" ? STORY_TRANSITIONS : EPIC_TRANSITIONS;
  const allowed = graph[from];
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

  const targetKind = ctx.targetKind ?? "epic";

  // Check structural validity
  if (!isAllowedTransition(ctx.fromStatus, ctx.toStatus, targetKind)) {
    const graph =
      targetKind === "story" ? STORY_TRANSITIONS : EPIC_TRANSITIONS;
    return {
      valid: false,
      error: `Invalid transition: cannot move from "${ctx.fromStatus}" to "${ctx.toStatus}". Allowed targets: ${graph[ctx.fromStatus]?.join(", ") || "none"}.`,
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
