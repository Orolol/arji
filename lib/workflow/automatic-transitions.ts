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

export type BuildScope = "epic" | "story";

export class WorkflowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowTransitionError";
  }
}

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
}): { epicPromoted: boolean; remainingStories: number } {
  const reason = opts.reason ?? "Build completed successfully";
  // Build dispatch established this invariant before the session row existed,
  // and the engine forbids moving an in-progress ticket while that session is
  // active. The terminal handler therefore has one deterministic source.
  const epicStatus: KanbanStatus = "in_progress";

  if (opts.scope === "epic") {
    const stories = readStories(opts.epicId).filter(
      (story) => story.status !== "done"
    );
    requireValid(
      applyTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        fromStatus: epicStatus,
        toStatus: "review",
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
          toStatus: "review",
          reason,
          sessionId: opts.sessionId,
          validateOnly: true,
        })
      );
    }

    for (const story of stories) {
      requireValid(
        transitionStory({
          projectId: opts.projectId,
          epicId: opts.epicId,
          userStoryId: story.id,
          fromStatus: story.status,
          toStatus: "review",
          reason,
          sessionId: opts.sessionId,
        })
      );
    }
    requireValid(
      applyTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        fromStatus: epicStatus,
        toStatus: "review",
        actor: "agent",
        source: "build",
        reason,
        sessionId: opts.sessionId,
      })
    );
    return { epicPromoted: true, remainingStories: 0 };
  }

  const story = readStory(opts.epicId, opts.userStoryId ?? "");
  const stories = readStories(opts.epicId);
  const remaining = stories.filter(
    (candidate) =>
      candidate.id !== story.id &&
      candidate.status !== "review" &&
      candidate.status !== "done"
  );

  requireValid(
    transitionStory({
      projectId: opts.projectId,
      epicId: opts.epicId,
      userStoryId: story.id,
      fromStatus: story.status,
      toStatus: "review",
      reason,
      sessionId: opts.sessionId,
      validateOnly: true,
    })
  );
  if (remaining.length === 0) {
    requireValid(
      applyTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        fromStatus: epicStatus,
        toStatus: "review",
        actor: "agent",
        source: "build",
        reason: "All stories are in review or done",
        sessionId: opts.sessionId,
        validateOnly: true,
      })
    );
  }

  requireValid(
    transitionStory({
      projectId: opts.projectId,
      epicId: opts.epicId,
      userStoryId: story.id,
      fromStatus: story.status,
      toStatus: "review",
      reason,
      sessionId: opts.sessionId,
    })
  );

  if (remaining.length === 0) {
    requireValid(
      applyTransition({
        projectId: opts.projectId,
        epicId: opts.epicId,
        fromStatus: epicStatus,
        toStatus: "review",
        actor: "agent",
        source: "build",
        reason: "All stories are in review or done",
        sessionId: opts.sessionId,
      })
    );
    return { epicPromoted: true, remainingStories: 0 };
  }

  logWorkflowDecision({
    projectId: opts.projectId,
    epicId: opts.epicId,
    status: epicStatus,
    actor: "agent",
    reason: `${remaining.length} ${remaining.length === 1 ? "story remains" : "stories remain"} before epic review (${remaining.map((item) => item.id).join(", ")})`,
    sessionId: opts.sessionId,
  });
  return { epicPromoted: false, remainingStories: remaining.length };
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
}):
  | { kind: "promoted"; epicPromoted: boolean; remainingStories: number }
  | { kind: "awaiting_reply" }
  | { kind: "failed" } {
  if (opts.success && opts.outcome !== "asked_question") {
    return {
      kind: "promoted",
      ...transitionBuildCompleted(opts),
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
