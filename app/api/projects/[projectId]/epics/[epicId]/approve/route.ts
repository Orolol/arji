import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
  reviewComments,
  ticketComments,
  agentSessions,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { tryExportArjiJson } from "@/lib/sync/export";
import { mergeWorktree, type MergeWorktreeResult } from "@/lib/git/manager";
import { logTransition } from "@/lib/workflow/log";
import {
  applyStoryTransition,
  applyTransition,
  logWorkflowDecision,
  type StoryStatus,
} from "@/lib/workflow/transition-service";
import { createApproveMergeFailedNotification } from "@/lib/notifications/create";
import { autoModeRegistry } from "@/lib/auto-mode/registry";
import {
  buildApprovalMergeBlockedReason,
  buildApprovalConflictMarkersBlockedReason,
} from "@/lib/workflow/merge-failure";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
import { getEpicOr404, isErrorResponse } from "@/lib/api/route-helpers";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

/**
 * Approve an epic in review: land its branch on the default branch, THEN
 * close the ticket.
 *
 * The order is the whole point. The previous implementation marked
 * everything done first and then fired a naive `git merge` into whatever
 * branch happened to be checked out, swallowing failures — which produced
 * "done" tickets whose code never reached main, and could leave the repo
 * stuck mid-merge with conflict markers. Now the merge goes through
 * `mergeWorktree` (aborts on conflict, targets the project's default
 * branch) and a failed merge changes NOTHING: comments stay open, the epic
 * stays in review, and the caller gets a 409 telling the user to run
 * Resolve Merge and approve again.
 *
 * Every status write in this route (epic → done, child stories → done) goes
 * through the transition service, so the workflow engine, the SSE event and
 * the activity log see exactly what the user sees.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;

  // Validate epic exists (project-scoped) and is in review
  const found = getEpicOr404(projectId, epicId);
  if (isErrorResponse(found)) return found;
  const { epic } = found;
  if (epic.status !== "review") {
    return NextResponse.json(
      { error: "Epic must be in review status to approve" },
      { status: 400 }
    );
  }

  // ---- Refuse while an agent still owns the epic. ------------------------
  // A merge removes the epic's worktree (`git worktree remove --force` in
  // mergeWorktree), so approving over a QUEUED build drops that build into a
  // directory that no longer exists the moment it starts. `beginMergeWork`
  // below only serialises merge against merge, and the engine's owning-session
  // rule does not cover an epic sitting in `review` — so the guard has to be
  // here. Same check, same shape, as resolve-merge already applies.
  const activeSession = getRunningSessionForTarget({
    scope: "epic",
    projectId,
    epicId,
  });
  if (activeSession) {
    return NextResponse.json(
      createAgentAlreadyRunningPayload(
        { scope: "epic", projectId, epicId },
        activeSession,
        "An agent is still working on this epic — wait for it to finish or cancel it before merging."
      ),
      { status: 409 }
    );
  }

  // ---- Pre-flight the workflow guards BEFORE anything runs. --------------
  // A refusal here can be deterministic, not just a race — e.g. an epic
  // dragged into review with no completed review session. Merging first
  // would change main, delete the branch, and resolve the comments, only for
  // the transition to 400 and leave the epic stuck in review with a stale
  // branchName ('branch-missing' on every retry). Same order as auto-mode
  // (lib/auto-mode/merge.ts), for the same reason. Open review comments are
  // validated as-if-resolved: approval bulk-resolves them, but only AFTER
  // the merge lands — a refused pre-flight must have written nothing.
  const preflight = applyTransition({
    projectId,
    epicId,
    fromStatus: "review",
    toStatus: "done",
    actor: "user",
    source: "approve",
    validateOnly: true,
    assumeReviewCommentsResolved: true,
  });
  if (!preflight.valid) {
    return NextResponse.json({ error: preflight.error }, { status: 400 });
  }

  const stories = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .all();

  // Only stories that reached review are part of this approval. Stories added
  // later (or otherwise still todo/in_progress) retain their status and are
  // named in the activity log instead of invalidating the parent approval.
  const reviewedStories = stories.filter((story) => story.status === "review");
  const skippedStories = stories.filter((story) => story.status !== "review");

  // Validate every eligible child before applying any write; epic approval
  // supplies the review context for its synchronized story transitions.
  for (const story of reviewedStories) {
    const validation = applyStoryTransition({
      projectId,
      epicId,
      userStoryId: story.id,
      fromStatus: (story.status ?? "review") as StoryStatus,
      toStatus: "done",
      actor: "user",
      source: "approve",
      reason: "Parent epic review approved",
      reviewScope: "epic",
      validateOnly: true,
      assumeReviewCommentsResolved: true,
    });
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
  }

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  const needsMerge = Boolean(project?.gitRepoPath && epic.branchName);

  // Per-epic merge lock (lib/auto-mode/registry.ts). Without it, an
  // epic-approve racing a last-story-approve on the SAME epic has the loser hit
  // 'branch-missing' and leave a spurious failure trail on a healthy epic.
  if (needsMerge && !autoModeRegistry.beginMergeWork(projectId, epicId)) {
    return NextResponse.json(
      {
        error:
          "A merge is already in flight for this epic — retry in a moment.",
      },
      { status: 409 }
    );
  }

  try {
    // ---- Merge first (when there is anything to merge). ------------------
    let merged = false;
    let commitHash: string | undefined;

    if (project?.gitRepoPath && epic.branchName) {
      // Worktree of the epic's most recent agent session (the merge route's
      // lookup) — mergeWorktree has to remove it before git can merge the
      // branch it holds checked out.
      const session = db
        .select()
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.epicId, epicId),
            eq(agentSessions.projectId, projectId)
          )
        )
        .orderBy(agentSessions.createdAt)
        .all()
        .pop();
      const worktreePath = session?.worktreePath || undefined;

      if (!autoModeRegistry.tryLockProjectMerge(projectId)) {
        return NextResponse.json(
          {
            error:
              "Another merge is in progress in this repository — retry in a moment.",
          },
          { status: 409 }
        );
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
        const isConflict = result.reason === "conflict";
        const isConflictMarkers = result.reason === "conflict-markers";
        const now = new Date().toISOString();

        // The ticket is untouched on purpose: no comment resolution, no
        // transition, no status write. An approval that did not land on main
        // must remain visibly un-approved. Leave a trail instead — a ticket
        // comment, a notification, and an activity-log entry. The trail is
        // best-effort: a hiccup writing it (SQLITE_BUSY) must not turn the
        // contractual 409 into a generic 500.
        try {
          db.insert(ticketComments)
            .values({
              id: createId(),
              epicId,
              author: "agent",
              content: isConflict
                ? `**Approval blocked — merge failed.** ${mergeError}\n\nThe ticket stays in review. Use Resolve Merge, then approve again.`
                : isConflictMarkers
                ? `**Approval blocked — unresolved conflict markers.** ${mergeError}\n\nThe ticket stays in review. Clean the conflict markers in the branch, then approve again.`
                : `**Approval blocked — merge failed.** ${mergeError}\n\nThe ticket stays in review.`,
              createdAt: now,
            })
            .run();

          createApproveMergeFailedNotification({
            projectId,
            epicId,
            error: mergeError,
          });

          // review → review: not a status change, just the activity log
          // recording WHY the approval bounced (same pattern as auto-mode's
          // held-in-place merge failures). The reason is built by the shared
          // contract so the board can recognise it and show the card a
          // "merge conflict" blocker instead of a doomed Merge button.
          logTransition({
            projectId,
            epicId,
            fromStatus: "review",
            toStatus: "review",
            actor: "system",
            reason: isConflict
              ? buildApprovalMergeBlockedReason({
                  branchName: epic.branchName,
                  error: mergeError,
                })
              : isConflictMarkers
              ? buildApprovalConflictMarkersBlockedReason({
                  branchName: epic.branchName,
                  error: mergeError,
                })
              : `Approval blocked: merge failed (${result.reason ?? "unknown"}) on ${epic.branchName} — ${mergeError}`,
          });
        } catch (trailError) {
          console.error(
            "[approve] Failed to record the merge-failure trail:",
            trailError
          );
        }

        // The failure comment is part of the export (arji.json carries epic
        // comments), so re-export like the story route's failure path does.
        tryExportArjiJson(projectId);

        return NextResponse.json(
          {
            error: isConflict
              ? `Merge failed: ${mergeError}. The ticket stays in review — resolve the conflict (Resolve Merge) and approve again.`
              : isConflictMarkers
              ? `Merge failed: ${mergeError}. Unresolved conflict markers in branch — clean the markers and approve again.`
              : `Merge failed: ${mergeError}. The ticket stays in review.`,
            mergeFailed: isConflict,
          },
          { status: 409 }
        );
      }

      merged = true;
      commitHash = result.commitHash;
    }

    // ---- Main has the work (or there was none to land) — now approve. ----
    const now = new Date().toISOString();

    // Bulk-resolve all open review comments (before validation so context sees them resolved)
    db.update(reviewComments)
      .set({ status: "resolved", updatedAt: now })
      .where(
        and(
          eq(reviewComments.epicId, epicId),
          eq(reviewComments.status, "open")
        )
      )
      .run();

    // Validate + apply the epic transition (status write, event and log all
    // come from the service — the pre-flight above already proved it valid).
    const validation = applyTransition({
      projectId,
      epicId,
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
      source: "approve",
      reason: "Review approved",
      assumeReviewCommentsResolved: true,
    });
    if (!validation.valid) {
      // Genuinely rare race now that the guards were pre-flighted above: the
      // merge landed and THEN a guard started refusing (e.g. the epic moved
      // while git was running). Same precedent as the merge route — surface
      // the validation error, a human is reading it.
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Post approval activity comment
    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId,
        author: "user",
        content: "**Review approved.** All review comments resolved.",
        createdAt: now,
      })
      .run();

    // Child stories → done through the same service. The approval logged its
    // own review → done entry above; the children close as part of it, so
    // they add no per-story line of their own (one movement, one line).
    for (const story of reviewedStories) {
      applyStoryTransition({
        projectId,
        epicId,
        userStoryId: story.id,
        fromStatus: (story.status ?? "review") as StoryStatus,
        toStatus: "done",
        actor: "user",
        source: "approve",
        reason: "Parent epic review approved",
        reviewScope: "epic",
        assumeReviewCommentsResolved: true,
        logActivity: false,
      });
    }
    if (skippedStories.length > 0) {
      logWorkflowDecision({
        projectId,
        epicId,
        status: "done",
        actor: "user",
        reason: `Epic approved; ${skippedStories.length} non-review ${skippedStories.length === 1 ? "story was" : "stories were"} left unchanged (${skippedStories.map((story) => `${story.id}:${story.status ?? "todo"}`).join(", ")})`,
      });
    }

    // The branch name is cleared only when a merge actually happened
    // (mergeWorktree deleted the branch on success, so keeping the name
    // would point at nothing and make later merge attempts fail). Metadata
    // only — the status write itself went through the service above.
    if (merged) {
      db.update(epics)
        .set({ branchName: null, updatedAt: now })
        .where(eq(epics.id, epicId))
        .run();
    }

    tryExportArjiJson(projectId);

    return NextResponse.json({
      data: {
        approved: true,
        merged,
        ...(commitHash ? { commitHash } : {}),
        ...(merged ? {} : { mergeSkipped: "no-branch" }),
        ...(skippedStories.length > 0
          ? {
              skippedStories: skippedStories.map((story) => ({
                id: story.id,
                title: story.title,
                status: story.status ?? "todo",
              })),
            }
          : {}),
      },
    });
  } finally {
    if (needsMerge) autoModeRegistry.endMergeWork(projectId, epicId);
  }
}