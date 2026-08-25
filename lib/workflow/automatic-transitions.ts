/**
 * Automatic ticket transitions shared by manual routes, pipeline stages and
 * Full Auto Mode. Dispatchers create sessions; this module owns the board
 * effects so every automatic status write goes through the workflow engine.
 */

import { db } from "@/lib/db";
import { epics, userStories } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { KanbanStatus } from "@/lib/types/kanban";
import {
  applyStoryTransition,
  applyTransition,
  logWorkflowDecision,
  type ApplyTransitionResult,
  type StoryStatus,
} from "./transition-service";
import { handleAskedQuestionOutcome } from "./agent-question";
import { recordSessionTransitionRefusal } from "@/lib/agent-sessions/lifecycle";

export type BuildScope = "epic" | "story";

export class WorkflowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowTransitionError";
  }
}

export type BuildCompletionResult =
  | { valid: true; epicPromoted: boolean; remainingStories: number }
  | {
      valid: false;
      epicPromoted: false;
      remainingStories: number;
      error: string;
    };

function requireValid(result: ApplyTransitionResult): void {
  if (!result.valid) {
    throw new WorkflowTransitionError(
      result.error ?? "The workflow engine refused the transition"
    );
  }
}

function readEpicStatus(epicId: string): KanbanStatus {
  return (db
    .select({ status: epics.status })
    .from(epics)
    .where(eq(epics.id, epicId))
    .get()?.status ?? "backlog") as KanbanStatus;
}

function readStory(epicId: string, userStoryId: string) {
  const story = db
    .select({ id: userStories.id, status: userStories.status })
    .from(userStories)
    .where(eq(userStories.id, userStoryId))
    .get();
  if (!story) throw new WorkflowTransitionError("Story not found");
  return {
    id: story.id,
    epicId,
    status: (story.status ?? "todo") as StoryStatus,
  };
}

function readStories(epicId: string) {
  return db
    .select({ id: userStories.id, status: userStories.status })
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .all()
    .map((story) => ({
      id: story.id,
      status: (story.status ?? "todo") as StoryStatus,
    }));
}

function transitionStory(opts: {
  projectId: string;
  epicId: string;
  userStoryId: string;
  fromStatus: StoryStatus;
  toStatus: StoryStatus;
  reason: string;
  sessionId: string;
  validateOnly?: boolean;
}) {
  return applyStoryTransition({
    ...opts,
    actor: "agent",
    source: "build",
  });
}

/**
 * Establish the no-orphan invariant before a queued build session is written:
 * its story (when scoped) and parent epic are both in_progress. Backlog is an
 * intentional build source, so Full Auto may safely pick backlog tickets too.
 */
export function transitionBuildStarted(opts: {
  projectId: string;
  epicId: string;
  scope: BuildScope;
  userStoryId?: string | null;
  sessionId: string;
  reason?: string;
  /** Preflight a multi-ticket dispatch without applying any status write. */
  validateOnly?: boolean;
}): void {
  const reason = opts.reason ?? "Build agent started";
  const epicStatus = readEpicStatus(opts.epicId);
  const stories =
    opts.scope === "epic"
      ? readStories(opts.epicId).filter((story) => story.status !== "done")
      : [readStory(opts.epicId, opts.userStoryId ?? "")];

  // Validate the whole status set first. A refused guard cannot leave a
  // partially moved ticket, and no queued session exists at this point.
  requireValid(
    applyTransition({
      projectId: opts.projectId,
      epicId: opts.epicId,
      fromStatus: epicStatus,
      toStatus: "in_progress",
      actor: "agent",
      source: "build",
      reason,
      sessionId: opts.sessionId,
      validateOnly: true,
    })
  );
  for (const story of stories) {
    requireValid(
      transitionStory({
        projectId: opts.projectId,
        epicId: opts.epicId,
        userStoryId: story.id,
        fromStatus: story.status,
        toStatus: "in_progress",
        reason,
        sessionId: opts.sessionId,
        validateOnly: true,
      })
    );
  }

  if (opts.validateOnly) return;

  requireValid(
    applyTransition({
      projectId: opts.projectId,
      epicId: opts.epicId,
      fromStatus: epicStatus,
      toStatus: "in_progress",
      actor: "agent",
      source: "build",
      reason,
      sessionId: opts.sessionId,
    })
  );
  // A retry starts from in_progress, so the status write is intentionally a
  // no-op. Keep the dispatch visible in the activity trail all the same.
  if (epicStatus === "in_progress") {
    logWorkflowDecision({
      projectId: opts.projectId,
      epicId: opts.epicId,
      status: epicStatus,
      actor: "agent",
      reason,
      sessionId: opts.sessionId,
    });
  }
  for (const story of stories) {
    requireValid(
      transitionStory({
        projectId: opts.projectId,
        epicId: opts.epicId,
        userStoryId: story.id,
        fromStatus: story.status,
        toStatus: "in_progress",
        reason,
        sessionId: opts.sessionId,
      })
    );
  }
}

/**
 * Promote a successful code session. Epic-scoped work moves immediately to
 * review. Story-scoped work promotes the parent only after every sibling is
 * review/done; otherwise a same-state activity entry names what remains.
 */
export function transitionBuildCompleted(opts: {
  projectId: string;
  epicId: string;
  scope: BuildScope;
  userStoryId?: string | null;
  sessionId: string;
  reason?: string;
}): BuildCompletionResult {
  const reason = opts.reason ?? "Build completed successfully";
  let epicStatus: KanbanStatus = "in_progress";

  const refused = (
    error: string,
    remainingStories = 0
  ): BuildCompletionResult => {
    logWorkflowDecision({
      projectId: opts.projectId,
      epicId: opts.epicId,
      status: epicStatus,
      actor: "agent",
      reason: `Build completed but review promotion was refused; ticket held in ${epicStatus}: ${error}`,
      sessionId: opts.sessionId,
    });
    return {
      valid: false,
      epicPromoted: false,
      remainingStories,
      error,
    };
  };

  try {
    // Read the persisted source instead of assuming dispatch left the row in
    // in_progress. This keeps terminal retries and released tickets guarded by
    // their real state and makes emitted fromStatus values truthful.
    epicStatus = readEpicStatus(opts.epicId);

    if (opts.scope === "epic") {
      // Only work that was part of this build advances. A story added while
      // the agent was running remains todo and cannot invalidate completion.
      const stories = readStories(opts.epicId).filter(
        (story) => story.status === "in_progress"
      );
      const epicValidation = applyTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        fromStatus: epicStatus,
        toStatus: "review",
        actor: "agent",
        source: "build",
        reason,
        sessionId: opts.sessionId,
        validateOnly: true,
      });
      if (!epicValidation.valid) {
        return refused(
          epicValidation.error ?? "The workflow engine refused epic review"
        );
      }
      for (const story of stories) {
        const storyValidation = transitionStory({
          projectId: opts.projectId,
          epicId: opts.epicId,
          userStoryId: story.id,
          fromStatus: story.status,
          toStatus: "review",
          reason,
          sessionId: opts.sessionId,
          validateOnly: true,
        });
        if (!storyValidation.valid) {
          return refused(
            storyValidation.error ??
              `The workflow engine refused review for story ${story.id}`
          );
        }
      }

      for (const story of stories) {
        const storyTransition = transitionStory({
          projectId: opts.projectId,
          epicId: opts.epicId,
          userStoryId: story.id,
          fromStatus: story.status,
          toStatus: "review",
          reason,
          sessionId: opts.sessionId,
        });
        if (!storyTransition.valid) {
          return refused(
            storyTransition.error ??
              `The workflow engine refused review for story ${story.id}`
          );
        }
      }
      const epicTransition = applyTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        fromStatus: epicStatus,
        toStatus: "review",
        actor: "agent",
        source: "build",
        reason,
        sessionId: opts.sessionId,
      });
      if (!epicTransition.valid) {
        return refused(
          epicTransition.error ?? "The workflow engine refused epic review"
        );
      }
      return { valid: true, epicPromoted: true, remainingStories: 0 };
    }

    const story = readStory(opts.epicId, opts.userStoryId ?? "");
    const stories = readStories(opts.epicId);
    const remaining = stories.filter(
      (candidate) =>
        candidate.id !== story.id &&
        candidate.status !== "review" &&
        candidate.status !== "done"
    );

    const storyValidation = transitionStory({
      projectId: opts.projectId,
      epicId: opts.epicId,
      userStoryId: story.id,
      fromStatus: story.status,
      toStatus: "review",
      reason,
      sessionId: opts.sessionId,
      validateOnly: true,
    });
    if (!storyValidation.valid) {
      return refused(
        storyValidation.error ?? "The workflow engine refused story review",
        remaining.length
      );
    }
    if (remaining.length === 0) {
      const epicValidation = applyTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        fromStatus: epicStatus,
        toStatus: "review",
        actor: "agent",
        source: "build",
        reason: "All stories are in review or done",
        sessionId: opts.sessionId,
        validateOnly: true,
      });
      if (!epicValidation.valid) {
        return refused(
          epicValidation.error ?? "The workflow engine refused epic review"
        );
      }
    }

    const storyTransition = transitionStory({
      projectId: opts.projectId,
      epicId: opts.epicId,
      userStoryId: story.id,
      fromStatus: story.status,
      toStatus: "review",
      reason,
      sessionId: opts.sessionId,
    });
    if (!storyTransition.valid) {
      return refused(
        storyTransition.error ?? "The workflow engine refused story review",
        remaining.length
      );
    }

    if (remaining.length === 0) {
      const epicTransition = applyTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        fromStatus: epicStatus,
        toStatus: "review",
        actor: "agent",
        source: "build",
        reason: "All stories are in review or done",
        sessionId: opts.sessionId,
      });
      if (!epicTransition.valid) {
        return refused(
          epicTransition.error ?? "The workflow engine refused epic review"
        );
      }
      return { valid: true, epicPromoted: true, remainingStories: 0 };
    }

    logWorkflowDecision({
      projectId: opts.projectId,
      epicId: opts.epicId,
      status: epicStatus,
      actor: "agent",
      reason: `${remaining.length} ${remaining.length === 1 ? "story remains" : "stories remain"} before epic review (${remaining.map((item) => item.id).join(", ")})`,
      sessionId: opts.sessionId,
    });
    return {
      valid: true,
      epicPromoted: false,
      remainingStories: remaining.length,
    };
  } catch (error) {
    return refused(
      error instanceof Error ? error.message : "Unknown workflow completion error"
    );
  }
}

/** Move a negative review back to buildable work through guarded writes. */
export function transitionReviewRejected(opts: {
  projectId: string;
  epicId: string;
  scope: BuildScope;
  userStoryId?: string | null;
  sessionId: string;
  reason: string;
}): void {
  const epicStatus = readEpicStatus(opts.epicId);
  const stories =
    opts.scope === "epic"
      ? readStories(opts.epicId).filter(
          (story) => story.status !== "in_progress"
        )
      : [readStory(opts.epicId, opts.userStoryId ?? "")];

  requireValid(
    applyTransition({
      projectId: opts.projectId,
      epicId: opts.epicId,
      fromStatus: epicStatus,
      toStatus: "in_progress",
      actor: "agent",
      source: "review",
      reason: opts.reason,
      sessionId: opts.sessionId,
      validateOnly: true,
    })
  );
  for (const story of stories) {
    requireValid(
      applyStoryTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        userStoryId: story.id,
        fromStatus: story.status,
        toStatus: "in_progress",
        actor: "agent",
        source: "review",
        reason: opts.reason,
        sessionId: opts.sessionId,
        validateOnly: true,
      })
    );
  }

  requireValid(
    applyTransition({
      projectId: opts.projectId,
      epicId: opts.epicId,
      fromStatus: epicStatus,
      toStatus: "in_progress",
      actor: "agent",
      source: "review",
      reason: opts.reason,
      sessionId: opts.sessionId,
    })
  );
  for (const story of stories) {
    requireValid(
      applyStoryTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        userStoryId: story.id,
        fromStatus: story.status,
        toStatus: "in_progress",
        actor: "agent",
        source: "review",
        reason: opts.reason,
        sessionId: opts.sessionId,
      })
    );
  }
}

/**
 * Pull a ticket back out of Review after a non-delivering terminal outcome.
 *
 * The owning-session exemption lets a live build promote its own ticket to
 * Review mid-run — so a build that then fails or ends on an open question
 * must not leave the work parked in Review (Full Auto would pick it up as a
 * review candidate). The target is the ticket the session could have moved:
 * the epic for epic-scoped builds, the story for story-scoped ones — epic
 * promotion belongs to transitionBuildCompleted's sibling-story rule, which
 * a story terminal outcome never runs.
 *
 * Returns the status the ticket is held at afterwards: in_progress when the
 * pullback landed (or the ticket was never out of it), the real status when
 * the guarded pullback is refused or could not run — so the caller's hold
 * entry stays truthful instead of hard-coding in_progress.
 */
export function pullTicketBackIfPromoted(
  opts: TicketPullbackOpts
): KanbanStatus {
  try {
    return applyTicketPullback(opts);
  } catch (err) {
    // Best-effort, like the rest of the terminal handlers: the failure and
    // asked_question paths call this from background completion blocks that
    // do not wrap it (see agent-question.ts), so a throw here would reject
    // runBuildSession and lose the agent's output comment. Degrade to
    // reporting the column the board is actually in.
    console.warn(
      "[workflow] Failed to pull the ticket back out of review:",
      (err as Error).message
    );
    return readHeldStatus(opts);
  }
}

export interface TicketPullbackOpts {
  projectId: string;
  epicId: string;
  scope: BuildScope;
  userStoryId?: string | null;
  /** The terminal session, which owns the ticket back if it is still the sole live build. */
  sessionId: string;
  /** Activity-trail wording for why the ticket must not stay in Review. */
  reason: string;
}

/**
 * The column the ticket sits in when the pullback itself could not run.
 * Never throws: a caller inside a completion block has nothing better to
 * fall back to than in_progress, the status the build started from.
 */
function readHeldStatus(opts: TicketPullbackOpts): KanbanStatus {
  try {
    if (opts.scope === "story" && opts.userStoryId) {
      return (db
        .select({ status: userStories.status })
        .from(userStories)
        .where(eq(userStories.id, opts.userStoryId))
        .get()?.status ?? "in_progress") as KanbanStatus;
    }
    return readEpicStatus(opts.epicId);
  } catch {
    return "in_progress";
  }
}

function applyTicketPullback(opts: TicketPullbackOpts): KanbanStatus {
  if (opts.scope === "story" && opts.userStoryId) {
    const story = db
      .select({ id: userStories.id, status: userStories.status })
      .from(userStories)
      .where(eq(userStories.id, opts.userStoryId))
      .get();
    if (!story || (story.status ?? "todo") !== "review") {
      // No promotion to undo — report the real status, not a guess.
      return (story?.status ?? "in_progress") as KanbanStatus;
    }
    const result = applyStoryTransition({
      projectId: opts.projectId,
      epicId: opts.epicId,
      userStoryId: story.id,
      fromStatus: "review",
      toStatus: "in_progress",
      actor: "agent",
      source: "build",
      reason: opts.reason,
      sessionId: opts.sessionId,
    });
    if (result.valid) return "in_progress";
    return (
      db
        .select({ status: userStories.status })
        .from(userStories)
        .where(eq(userStories.id, story.id))
        .get()?.status ?? "review"
    ) as KanbanStatus;
  }

  const status = readEpicStatus(opts.epicId);
  if (status !== "review") return status;
  const result = applyTransition({
    projectId: opts.projectId,
    epicId: opts.epicId,
    fromStatus: "review",
    toStatus: "in_progress",
    actor: "agent",
    source: "build",
    reason: opts.reason,
    sessionId: opts.sessionId,
  });
  return result.valid ? "in_progress" : readEpicStatus(opts.epicId);
}

/**
 * Failure path: the build never claimed the ticket, so it never reclaims it
 * — except that the owning-session exemption may have promoted the ticket
 * to Review mid-run, in which case the failure undoes that promotion first.
 * The hold entry logs the status the ticket is actually held in.
 *
 * Named `hold*`, not `log*`: unlike logWorkflowDecision/logTransition this
 * writes board state (the pullback), so a caller cannot treat it as a
 * pure audit call.
 */
export function holdFailedBuild(opts: {
  projectId: string;
  epicId: string;
  /** Which ticket to hold/rollback; defaults to the epic (batch/team callers). */
  scope?: BuildScope;
  userStoryId?: string | null;
  sessionId: string;
  error?: string | null;
}) {
  const detail = opts.error || "unknown error";
  const status = pullTicketBackIfPromoted({
    projectId: opts.projectId,
    epicId: opts.epicId,
    scope: opts.scope ?? "epic",
    userStoryId: opts.userStoryId,
    sessionId: opts.sessionId,
    reason: `Build failed; returning ticket to in_progress: ${detail}`,
  });
  logWorkflowDecision({
    projectId: opts.projectId,
    epicId: opts.epicId,
    status,
    actor: "agent",
    reason: `Build failed; ticket held in ${status}: ${detail}`,
    sessionId: opts.sessionId,
  });
}

/**
 * Exhaustive terminal-outcome switch for code sessions. `answered` (and a
 * legacy successful null outcome) is a delivered build; asked_question holds
 * the ticket; every unsuccessful/error result stays in progress with a log.
 */
export type BuildTerminalOutcome =
  | { kind: "promoted"; epicPromoted: boolean; remainingStories: number }
  | { kind: "refused"; error: string }
  | { kind: "awaiting_reply" }
  | { kind: "failed" };

export interface BuildSessionResult {
  success: boolean;
  outcome: string | null;
  error: string | null;
}

/** Fold the board-transition decision into a pipeline/wave settle payload. */
export function resolveBuildSessionResult(
  terminal: BuildTerminalOutcome,
  result: BuildSessionResult
): BuildSessionResult {
  if (terminal.kind !== "refused") return result;
  return {
    success: false,
    outcome: "transition_refused",
    error: terminal.error,
  };
}

export function finalizeBuildTerminalOutcome(opts: {
  projectId: string;
  epicId: string;
  scope: BuildScope;
  userStoryId?: string | null;
  sessionId: string;
  success: boolean;
  outcome: string | null;
  error?: string | null;
  reason?: string;
}): BuildTerminalOutcome {
  if (opts.success && opts.outcome !== "asked_question") {
    const completed = transitionBuildCompleted(opts);
    if (!completed.valid) {
      recordSessionTransitionRefusal(opts.sessionId, completed.error);
      return { kind: "refused", error: completed.error };
    }
    return {
      kind: "promoted",
      epicPromoted: completed.epicPromoted,
      remainingStories: completed.remainingStories,
    };
  }

  if (opts.success) {
    // The agent stopped to ask a question: the work is not delivered, so a
    // ticket it promoted to Review mid-run comes back BEFORE the reply hold
    // is recorded — the hold entry must name the status it actually holds.
    const heldStatus = pullTicketBackIfPromoted({
      projectId: opts.projectId,
      epicId: opts.epicId,
      scope: opts.scope,
      userStoryId: opts.userStoryId,
      sessionId: opts.sessionId,
      reason:
        "The build ended with an open question; returning ticket to in_progress",
    });
    handleAskedQuestionOutcome({
      projectId: opts.projectId,
      epicIds: [opts.epicId],
      sessionId: opts.sessionId,
      ticketStatus: heldStatus,
    });
    return { kind: "awaiting_reply" };
  }

  holdFailedBuild({
    projectId: opts.projectId,
    epicId: opts.epicId,
    scope: opts.scope,
    userStoryId: opts.userStoryId,
    sessionId: opts.sessionId,
    error: opts.error,
  });
  return { kind: "failed" };
}
