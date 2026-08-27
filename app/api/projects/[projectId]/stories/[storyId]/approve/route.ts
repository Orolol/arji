import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
  ticketComments,
  agentSessions,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { tryExportArjiJson } from "@/lib/sync/export";
import { mergeWorktree, type MergeWorktreeResult } from "@/lib/git/manager";
import { logTransition } from "@/lib/workflow/log";
import { createApproveMergeFailedNotification } from "@/lib/notifications/create";
import { autoModeRegistry } from "@/lib/auto-mode/registry";
import { getStoryOr404, isErrorResponse } from "@/lib/api/route-helpers";
import {
  applyStoryTransition,
  applyTransition,
  logWorkflowDecision,
  type StoryStatus,
} from "@/lib/workflow/transition-service";
import type { KanbanStatus } from "@/lib/types/kanban";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

/**
 * Approve a user story in review.
 *
 * The story itself always goes done — approving one story is a review
 * verdict on that story alone and must never be blocked by git. Only when
 * this was the LAST open story does the epic close, and closing the epic
 * means landing its branch: the merge runs through `mergeWorktree` (aborts
 * on conflict, targets the project's default branch) BEFORE the epic is
 * marked done. The previous implementation did it the other way around —
 * epic done first, then a naive checked-out-branch merge whose failure was
 * swallowed — which produced "done" epics whose code never reached main.
 *
 * Both status writes (story → done, and the epic → done when all stories
 * are approved) go through the transition service, so the engine's guards
 * still apply: an epic whose completion the engine refuses stays put and
 * the refusal is reported back to the caller instead of force-closed.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;

  // Validate story exists (project-scoped) and is in review
  const found = getStoryOr404(projectId, storyId);
  if (isErrorResponse(found)) return found;
  const { story } = found;

  if (story.status !== "review") {
    return NextResponse.json(
      { error: "Story must be in review status to approve" },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  // Check whether this approval will complete the epic before applying any
  // status write, so all workflow guards can be validated as one decision.
  const epic = db
    .select()
    .from(epics)
    .where(eq(epics.id, story.epicId))
    .get();

  if (!epic) {
    // Orphaned story (epic deleted out from under it): record the verdict
    // for the story itself, nothing else to close.
    const orphanValidation = applyStoryTransition({
      projectId,
      epicId: story.epicId,
      userStoryId: storyId,
      fromStatus: (story.status ?? "review") as StoryStatus,
      toStatus: "done",
      actor: "user",
      source: "approve",
      reason: "Story review approved",
      requireCompletedReview: false,
      requireResolvedComments: false,
      validateOnly: true,
    });
    if (!orphanValidation.valid) {
      return NextResponse.json({ error: orphanValidation.error }, { status: 400 });
    }
    applyStoryTransition({
      projectId,
      epicId: story.epicId,
      userStoryId: storyId,
      fromStatus: (story.status ?? "review") as StoryStatus,
      toStatus: "done",
      actor: "user",
      source: "approve",
      reason: "Story review approved",
      requireCompletedReview: false,
      requireResolvedComments: false,
    });
    tryExportArjiJson(projectId);
    return NextResponse.json({ data: { approved: true, epicComplete: false } });
  }

  const allStories = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epic.id))
    .all();

  const allDone = allStories.every((s) => s.id === storyId || s.status === "done");

  // Explicit human approval of a story is itself the review verdict for it,
  // and story approval cannot resolve epic-scoped findings on its own.
  const storyValidation = applyStoryTransition({
    projectId,
    epicId: epic.id,
    userStoryId: storyId,
    fromStatus: (story.status ?? "review") as StoryStatus,
    toStatus: "done",
    actor: "user",
    source: "approve",
    reason: "Story review approved",
    requireCompletedReview: false,
    requireResolvedComments: false,
    validateOnly: true,
  });
  if (!storyValidation.valid) {
    return NextResponse.json({ error: storyValidation.error }, { status: 400 });
  }

  applyStoryTransition({
    projectId,
    epicId: epic.id,
    userStoryId: storyId,
    fromStatus: (story.status ?? "review") as StoryStatus,
    toStatus: "done",
    actor: "user",
    source: "approve",
    reason: "Story review approved",
    requireCompletedReview: false,
    requireResolvedComments: false,
  });

  if (!allDone) {
    tryExportArjiJson(projectId);
    return NextResponse.json({
      data: { approved: true, epicComplete: false, merged: false },
    });
  }

  // This is the last open story, so the epic may close — but only if the
  // engine agrees (completed review session, no open comments, no build
  // session still running). A refusal holds the epic in place and reports
  // why, instead of force-closing it.
  const epicValidation = applyTransition({
    projectId,
    epicId: epic.id,
    fromStatus: (epic.status ?? "review") as KanbanStatus,
    toStatus: "done",
    actor: "user",
    source: "approve",
    reason: "All stories approved",
    validateOnly: true,
  });

  if (!epicValidation.valid) {
    logWorkflowDecision({
      projectId,
      epicId: epic.id,
      status: (epic.status ?? "review") as KanbanStatus,
      actor: "user",
      reason: `Story approved; parent epic held because completion was refused: ${epicValidation.error ?? "unknown workflow guard failure"}`,
    });
    tryExportArjiJson(projectId);
    return NextResponse.json({
      data: {
        approved: true,
        epicComplete: false,
        epicHoldReason: epicValidation.error,
        merged: false,
      },
    });
  }

  // Last story approved and the engine agrees — the epic is complete. Land
  // the branch BEFORE marking the epic done, so "done" always means "on
  // main".
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (project?.gitRepoPath && epic.branchName) {
    // Same per-epic merge lock as auto-mode (lib/auto-mode/merge.ts).
    // Without it, this merge racing auto-mode's can be silently un-merged
    // by auto's rollback (its checkpoint predates our merge), and racing an
    // epic-approve has the loser hit 'branch-missing' and leave a spurious
    // failure trail on a healthy epic. When the lock is held, the story
    // stays done (the verdict stands) and the epic is left untouched — the
    // in-flight merge will close it, or the user retries in a moment.
    if (!autoModeRegistry.beginMergeWork(projectId, epic.id)) {
      tryExportArjiJson(projectId);
      return NextResponse.json({
        data: {
          approved: true,
          epicComplete: true,
          merged: false,
          mergeError:
            "A merge is already in flight for this epic — retry in a moment.",
        },
      });
    }

    try {
      // Worktree of the epic's most recent agent session (the merge route's
      // lookup) — mergeWorktree has to remove it before git can merge the
      // branch it holds checked out.
      const session = db
        .select()
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.epicId, epic.id),
            eq(agentSessions.projectId, projectId)
          )
        )
        .orderBy(agentSessions.createdAt)
        .all()
        .pop();
      const worktreePath = session?.worktreePath || undefined;

      if (!autoModeRegistry.tryLockProjectMerge(projectId)) {
        tryExportArjiJson(projectId);
        return NextResponse.json({
          data: {
            approved: true,
            epicComplete: true,
            merged: false,
            mergeError:
              "Another merge is in progress in this repository — retry in a moment.",
          },
        });
      }
      let result: MergeWorktreeResult;
      try {
        result = await mergeWorktree(
          project.gitRepoPath,
          epic.branchName,
          worktreePath,
          { defaultBranch: project.defaultBranch }
        );
      } catch (e) {
        result = {
          merged: false,
          error: e instanceof Error ? e.message : "Merge failed",
          reason: "error",
        };
      } finally {
        autoModeRegistry.unlockProjectMerge(projectId);
      }

      if (!result.merged) {
        const mergeError = result.error || "Merge failed";

        // The story approval stands (it already went done above) but the
        // epic stays exactly where it is — an epic whose code is not on main
        // must not read "done". Leave a trail: ticket comment, notification,
        // and an activity-log entry, then report the partial outcome with
        // 200 — the approve itself DID succeed, only the merge failed. The
        // trail is best-effort: a hiccup writing it (SQLITE_BUSY) must not
        // turn the contractual 200 into a generic 500.
        try {
          db.insert(ticketComments)
            .values({
              id: createId(),
              epicId: epic.id,
              author: "agent",
              content: `**All stories approved, but the epic merge failed.** ${mergeError}\n\nThe epic keeps its current status. Use Resolve Merge on the epic to land the branch and close it.`,
              createdAt: now,
            })
            .run();

          createApproveMergeFailedNotification({
            projectId,
            epicId: epic.id,
            error: mergeError,
          });

          // Same-status entry: not a move, just the activity log recording
          // WHY the epic did not close (same pattern as auto-mode's
          // held-in-place merge failures).
          const heldStatus = epic.status ?? "review";
          logTransition({
            projectId,
            epicId: epic.id,
            fromStatus: heldStatus,
            toStatus: heldStatus,
            actor: "system",
            reason: `Epic completion blocked: merge of ${epic.branchName} failed — ${mergeError}`,
          });
        } catch (trailError) {
          console.error(
            "[story approve] Failed to record the merge-failure trail:",
            trailError
          );
        }

        tryExportArjiJson(projectId);

        return NextResponse.json({
          data: {
            approved: true,
            epicComplete: true,
            merged: false,
            mergeError,
          },
        });
      }

      // Merge landed — NOW the epic may close (status write, event and log
      // via the service). The branch name is cleared because mergeWorktree
      // deleted the branch on success; keeping it would point at nothing and
      // make later merge attempts fail.
      const applied = applyTransition({
        projectId,
        epicId: epic.id,
        fromStatus: (epic.status ?? "review") as KanbanStatus,
        toStatus: "done",
        actor: "user",
        source: "approve",
        reason: "All stories approved",
      });
      if (!applied.valid) {
        // Same rare race as the epic-approve route: pre-flight passed, the
        // merge landed, then a guard refused. Surface it — the branch is on
        // main, a human is reading this.
        return NextResponse.json({ error: applied.error }, { status: 400 });
      }
      db.update(epics)
        .set({ branchName: null, updatedAt: now })
        .where(eq(epics.id, epic.id))
        .run();

      tryExportArjiJson(projectId);

      return NextResponse.json({
        data: {
          approved: true,
          epicComplete: true,
          merged: true,
          commitHash: result.commitHash,
        },
      });
    } finally {
      autoModeRegistry.endMergeWork(projectId, epic.id);
    }
  }

  // No repo or no branch: nothing to land, so closing the epic without a
  // merge is correct, not an error.
  applyTransition({
    projectId,
    epicId: epic.id,
    fromStatus: (epic.status ?? "review") as KanbanStatus,
    toStatus: "done",
    actor: "user",
    source: "approve",
    reason: "All stories approved",
  });

  tryExportArjiJson(projectId);

  return NextResponse.json({
    data: { approved: true, epicComplete: true, merged: false },
  });
}