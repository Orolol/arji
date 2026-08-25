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

/**
 * Move a negative review back to buildable work through guarded writes.
 *
 * `verdictSource` records WHICH channel produced the negative verdict — the
 * reviewer's structured `submit_findings` verdict, or the prose scan of its
 * final message (see lib/pipeline/findings.ts, which owns the priority
 * between them). It is appended to the reason so `ticket_activity_log` says
 * why the ticket came back, not just that it did: a revert driven by a
 * substring match in markdown and one driven by a tool call the agent
 * deliberately made are not the same evidence. Omitted — the pre-existing
 * shape — leaves the reason untouched.
 *
 * Typed structurally rather than importing `ReviewVerdictSource` from
 * lib/pipeline/findings.ts: the workflow layer sits below the pipeline and
 * does not depend on it.
 */
export function transitionReviewRejected(opts: {
  projectId: string;
  epicId: string;
  scope: BuildScope;
  userStoryId?: string | null;
  sessionId: string;
  reason: string;
  verdictSource?: "structured" | "prose";
}): void {
  const reason = opts.verdictSource
    ? `${opts.reason} [verdict source: ${opts.verdictSource}]`
    : opts.reason;
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
      reason,
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
        reason,
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
      reason,
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
        reason,
        sessionId: opts.sessionId,
      })
    );
  }
}

export function logBuildFailure(opts: {
  projectId: string;
  epicId: string;
  sessionId: string;
  error?: string | null;
}) {
  const status = "in_progress";
  logWorkflowDecision({
    projectId: opts.projectId,
    epicId: opts.epicId,
    status,
    actor: "agent",
    reason: `Build failed; ticket held in ${status}: ${opts.error || "unknown error"}`,
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
    handleAskedQuestionOutcome({
      projectId: opts.projectId,
      epicIds: [opts.epicId],
      sessionId: opts.sessionId,
      ticketStatus: "in_progress",
    });
    return { kind: "awaiting_reply" };
  }

  logBuildFailure(opts);
  return { kind: "failed" };
}
