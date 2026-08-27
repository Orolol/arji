import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics, agentSessions, ticketComments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getEpicOr404,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { mergeWorktree, type MergeWorktreeResult } from "@/lib/git/manager";
import { tryExportArjiJson } from "@/lib/sync/export";
import { createId } from "@/lib/utils/nanoid";
import { processManager } from "@/lib/claude/process-manager";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import {
  createQueuedSession,
  markSessionRunning,
  markSessionTerminal,
  isSessionLifecycleConflictError,
} from "@/lib/agent-sessions/lifecycle";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
import { autoModeRegistry } from "@/lib/auto-mode/registry";
import { agentScheduler } from "@/lib/agents/scheduler";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import { applyTransition } from "@/lib/workflow/transition-service";
import { resolveOpenReviewComments } from "@/lib/workflow/merge-approval";
import { logTransition } from "@/lib/workflow/log";
import {
  buildMergeBlockedReason,
  buildMergeConflictMarkersBlockedReason,
} from "@/lib/workflow/merge-failure";
import {
  createApproveMergeFailedNotification,
  createMergeRetryFailedNotification,
} from "@/lib/notifications/create";
import type { KanbanStatus } from "@/lib/types/kanban";
import fs from "fs";
import path from "path";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; epicId: string }> }
) {
  const { projectId, epicId } = await params;

  let autoAgent = false;
  try {
    const body = await request.json();
    autoAgent = body?.autoAgent === true;
  } catch {
    // No body or invalid JSON — defaults to false
  }

  const foundProject = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(foundProject)) return foundProject;
  const { project } = foundProject;

  const foundEpic = getEpicOr404(projectId, epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;
  const { epic } = foundEpic;

  if (!epic.branchName) {
    return NextResponse.json({ error: "Epic has no branch to merge" }, { status: 400 });
  }

  // Workflow guards run before git, so only a ticket at the merge boundary
  // (to_merge) can land on main.
  const preflight = applyTransition({
    projectId,
    epicId,
    fromStatus: (epic.status ?? "to_merge") as KanbanStatus,
    toStatus: "done",
    actor: "user",
    source: "merge",
    reason: "Manual merge preflight",
    validateOnly: true,
  });
  if (!preflight.valid) {
    return NextResponse.json({ error: preflight.error }, { status: 400 });
  }

  // Concurrency guard BEFORE any git work — this is now the ONLY merge entry
  // for the board and the ticket detail, so it carries the guards the retired
  // approve route had: `mergeWorktree` runs `git worktree remove --force`,
  // and landing that on top of a queued session drops it into a directory
  // that no longer exists the moment it starts.
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
        "Another agent is already running for this epic."
      ),
      { status: 409 }
    );
  }

  // Find the worktree path from the most recent session for this epic
  const session = db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.epicId, epicId), eq(agentSessions.projectId, projectId)))
    .orderBy(agentSessions.createdAt)
    .all()
    .pop();

  const worktreePath = session?.worktreePath || undefined;

  // Per-epic and per-project merge serialization, same as resolve-merge and
  // Full Auto: git is not transactional and two merges on one repository
  // race on index.lock and on each other's rollback checkpoints.
  if (!autoModeRegistry.beginMergeWork(projectId, epicId)) {
    return NextResponse.json(
      { error: "A merge is already in flight for this epic — retry in a moment." },
      { status: 409 }
    );
  }
  let result: MergeWorktreeResult;
  try {
    if (!autoModeRegistry.tryLockProjectMerge(projectId)) {
      return NextResponse.json(
        {
          error:
            "Another merge is in progress in this repository — retry in a moment.",
        },
        { status: 409 }
      );
    }
    try {
      result = await mergeWorktree(
        project.gitRepoPath,
        epic.branchName,
        worktreePath,
        { defaultBranch: project.defaultBranch }
      );
    } catch (e) {
      // A throw (repository gone, git binary failure) must flow into the
      // ordinary failure path below — with its ticket trail — not out of the
      // handler as a bare 500.
      result = {
        merged: false,
        error: e instanceof Error ? e.message : "Merge failed",
        reason: "error",
      };
    } finally {
      autoModeRegistry.unlockProjectMerge(projectId);
    }
  } finally {
    autoModeRegistry.endMergeWork(projectId, epicId);
  }

  if (result.merged) {
    const prevStatus = (epic.status ?? "to_merge") as KanbanStatus;

    // The merge is the approval: whatever review comments stayed open —
    // minor findings, notes from earlier cycles — are accepted with it.
    resolveOpenReviewComments(epicId);

    // Re-check and apply after git: guards may have changed during the merge.
    const validation = applyTransition({
      projectId,
      epicId,
      fromStatus: prevStatus,
      toStatus: "done",
      actor: "user",
      source: "merge",
      reason: "Branch merged successfully",
    });
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // The status is already guarded/applied; branch cleanup is metadata only.
    db.update(epics)
      .set({ branchName: null, updatedAt: new Date().toISOString() })
      .where(eq(epics.id, epicId))
      .run();

    tryExportArjiJson(projectId);

    return NextResponse.json({
      data: {
        merged: true,
        commitHash: result.commitHash,
        ...(validation.skippedStories?.length
          ? { skippedStories: validation.skippedStories }
          : {}),
      },
    });
  }

  // Merge failed — if autoAgent is enabled, launch a merge-fix agent
  if (autoAgent && worktreePath) {
    // Check concurrency guard
    const conflict = getRunningSessionForTarget({
      scope: "epic",
      projectId,
      epicId,
    });
    if (conflict) {
      return NextResponse.json(
        {
          error: `${result.error || "Merge failed"} — an agent is already running for this epic, so no merge-fix agent was launched.`,
        },
        { status: 500 }
      );
    }

    const mergeSystemPrompt = await resolveAgentPrompt("merge", projectId);
    const prompt = [
      mergeSystemPrompt,
      `The branch "${epic.branchName}" failed to merge into main.`,
      `Error: ${result.error || "Unknown merge conflict"}`,
      "",
      "Resolve the merge conflicts and complete the merge. Steps:",
      `1. In the worktree at ${worktreePath}, run: git merge main`,
      "2. Resolve all conflicts in the affected files",
      "3. Stage and commit the resolution",
      "4. Verify the build still passes",
    ].filter(Boolean).join("\n");

    const sessionId = createId();
    const now = new Date().toISOString();
    const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "logs.json");

    const cliSessionId = crypto.randomUUID();

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId,
      mode: "code",
      orchestrationMode: "solo",
      provider: "claude-code",
      prompt,
      logsPath,
      branchName: epic.branchName,
      worktreePath,
      cliSessionId,
      agentType: "merge",
      namedAgentName: null,
      model: null,
      createdAt: now,
    });

    // Scheduled merge-fix launch: spawn when a slot frees, wait for
    // completion, then attempt the merge again (no retry cap).
    agentScheduler.submit(projectId, sessionId, async () => {
      markSessionRunning(sessionId);
      processManager.start(sessionId, {
        mode: "code",
        prompt,
        cwd: worktreePath,
        allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
        cliSessionId,
      });

      const info = await waitForProcessCompletion(sessionId);

      const completedAt = new Date().toISOString();
      const agentResult = info?.result;

      try {
        fs.writeFileSync(logsPath, JSON.stringify(agentResult, null, 2));
      } catch {
        // ignore
      }

      try {
        markSessionTerminal(
          sessionId,
          {
            success: !!agentResult?.success,
            error: agentResult?.error || null,
            outcome: classifySessionOutcome(agentResult, sessionId),
            usage: extractSessionUsage(agentResult),
          },
          completedAt
        );
      } catch (error) {
        if (!isSessionLifecycleConflictError(error)) {
          console.error("[merge/auto-agent] Failed to finalize session", error);
        }
      }

      // If agent succeeded, attempt merge again
      if (agentResult?.success) {
        const retryResult = await mergeWorktree(
          project.gitRepoPath!,
          epic.branchName!,
          worktreePath,
          { defaultBranch: project.defaultBranch }
        );
        if (retryResult.merged) {
          resolveOpenReviewComments(epicId);
          const currentStatus = (db
            .select({ status: epics.status })
            .from(epics)
            .where(eq(epics.id, epicId))
            .get()?.status ?? "to_merge") as KanbanStatus;
          const transition = applyTransition({
            projectId,
            epicId,
            fromStatus: currentStatus,
            toStatus: "done",
            actor: "agent",
            source: "merge",
            reason: "Merge-fix agent resolved conflicts and merged",
            sessionId,
          });
          if (transition.valid) {
            db.update(epics)
              .set({ branchName: null, updatedAt: new Date().toISOString() })
              .where(eq(epics.id, epicId))
              .run();
          }
          tryExportArjiJson(projectId);
        } else {
          // The agent claimed success but the retry merge STILL failed —
          // e.g. it committed the conflict markers, tripping the marker
          // guard. This closure has no HTTP response left to carry the
          // failure, so leave a trail or the user never learns why the epic
          // did not close.
          const retryError = retryResult.error || "Merge failed";
          try {
            db.insert(ticketComments)
              .values({
                id: createId(),
                epicId,
                author: "agent",
                content: `**Merge-fix agent finished, but the merge still failed.** ${retryError}\n\nThe epic keeps its current status. Use Resolve Merge to land the branch.`,
                agentSessionId: sessionId,
                createdAt: completedAt,
              })
              .run();

            createMergeRetryFailedNotification({
              projectId,
              epicId,
              sessionId,
              error: retryError,
            });
          } catch (trailError) {
            console.error(
              "[merge/auto-agent] Failed to record the merge-failure trail:",
              trailError
            );
          }
        }
      }

      // Post output as epic comment
      const mergeOutput = resolveSessionOutput(agentResult, sessionId);

      db.insert(ticketComments)
        .values({
          id: createId(),
          epicId,
          author: "agent",
          content: mergeOutput,
          agentSessionId: sessionId,
          createdAt: completedAt,
        })
        .run();
    });

    return NextResponse.json({
      data: {
        merged: false,
        autoAgent: true,
        sessionId,
        error: result.error || "Merge failed — agent launched to resolve",
      },
    });
  }

  const mergeError = result.error || "Merge failed";
  const isConflict = result.reason === "conflict";
  const isConflictMarkers = result.reason === "conflict-markers";
  const now = new Date().toISOString();

  try {
    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId,
        author: "agent",
        content: isConflict
          ? `**Merge failed.** ${mergeError}\n\nThe ticket stays in ${epic.status}. Use Resolve with Agent, then merge again.`
          : isConflictMarkers
          ? `**Merge failed — unresolved conflict markers.** ${mergeError}\n\nThe ticket stays in ${epic.status}. Clean the conflict markers in the branch, then merge again.`
          : `**Merge failed.** ${mergeError}\n\nThe ticket stays in ${epic.status}.`,
        createdAt: now,
      })
      .run();

    createApproveMergeFailedNotification({
      projectId,
      epicId,
      error: mergeError,
    });

    logTransition({
      projectId,
      epicId,
      fromStatus: (epic.status ?? "review") as KanbanStatus,
      toStatus: (epic.status ?? "review") as KanbanStatus,
      actor: "system",
      reason: isConflict
        ? buildMergeBlockedReason({
            branchName: epic.branchName,
            error: mergeError,
          })
        : isConflictMarkers
        ? buildMergeConflictMarkersBlockedReason({
            branchName: epic.branchName,
            error: mergeError,
          })
        : `Merge blocked: merge failed (${result.reason ?? "unknown"}) on ${epic.branchName} — ${mergeError}`,
    });
  } catch (trailError) {
    console.error(
      "[merge] Failed to record the merge-failure trail:",
      trailError
    );
  }

  if (isConflict) {
    return NextResponse.json(
      {
        error: `Merge failed: ${mergeError}. The ticket stays in ${epic.status} — resolve the conflict (Resolve with Agent) and merge again.`,
        reason: "conflict",
        conflictFiles: result.conflictFiles,
        mergeFailed: true,
      },
      { status: 409 }
    );
  }

  if (isConflictMarkers) {
    return NextResponse.json(
      {
        error: `Merge failed: ${mergeError}. Unresolved conflict markers in branch — clean the markers and merge again.`,
        reason: "conflict-markers",
        mergeFailed: false,
      },
      { status: 409 }
    );
  }

  return NextResponse.json(
    {
      error: result.error || "Merge failed",
      reason: result.reason ?? "error",
    },
    { status: 500 }
  );
}
