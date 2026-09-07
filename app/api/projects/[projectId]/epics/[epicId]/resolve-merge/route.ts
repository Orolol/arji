import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  epics,
  ticketComments,
  settings,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  errorResponse,
  getEpicOr404,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { createId } from "@/lib/utils/nanoid";
import {
  attachWorktree,
  isGitRepo,
  startMergeInWorktree,
  mergeWorktree,
  type MergeWorktreeResult,
} from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import { buildMergeResolutionPrompt } from "@/lib/claude/prompt-builder";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { tryExportArjiJson } from "@/lib/sync/export";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
import { autoModeRegistry } from "@/lib/auto-mode/registry";
import { isGitRefusalMergeReason } from "@/lib/workflow/merge-failure";
import fs from "fs";
import path from "path";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { validateResumeSession } from "@/lib/agent-sessions/validate-resume";
import { createMergeRetryFailedNotification } from "@/lib/notifications/create";
import {
  isResumableProvider,
  providerAcceptsAssignedSessionId,
} from "@/lib/agent-sessions/resume-capability";
import { applyTransition } from "@/lib/workflow/transition-service";
import { resolveOpenReviewComments } from "@/lib/workflow/merge-approval";
import type { KanbanStatus } from "@/lib/types/kanban";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;
  const body = await request.json().catch(() => ({}));
  const namedAgentId: string | null = body.namedAgentId || null;
  const resolved = resolveAgentByNamedId("merge", projectId, namedAgentId);
  const provider = resolved.provider;
  const model = resolved.model;

  // Validate project
  const foundProject = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(foundProject)) return foundProject;
  const { project } = foundProject;

  const gitRepoPath = project.gitRepoPath;
  const isRepo = await isGitRepo(gitRepoPath);
  if (!isRepo) {
    return NextResponse.json(
      { error: `Path is not a git repository: ${gitRepoPath}` },
      { status: 400 }
    );
  }

  // Validate epic (project-scoped)
  const foundEpic = getEpicOr404(projectId, epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;
  const { epic } = foundEpic;
  if (!epic.branchName) {
    return NextResponse.json(
      { error: "Epic has no branch" },
      { status: 400 }
    );
  }

  // Concurrency guard — BEFORE any git work, not just before dispatching the
  // resolution agent. The clean-merge branch below calls `mergeWorktree`,
  // which runs `git worktree remove --force`; landing that on top of a queued
  // build drops it into a directory that no longer exists the moment it
  // starts. Same check, same placement, as the approve route.
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

  // Ensure worktree exists for the epic's stored branch.
  // `attachWorktree` attaches the worktree to `epic.branchName` rather than
  // re-deriving the branch name from `epic.title`: if the epic title was
  // edited since the branch was cut, `createWorktree` would derive a new name,
  // cut a fresh branch off the default branch, and land an empty merge commit
  // while leaving the real branch untouched.
  let worktreePath: string;
  let branchName: string;
  try {
    const attached = await attachWorktree(gitRepoPath, epic.branchName);
    worktreePath = attached.worktreePath;
    branchName = attached.branchName;
  } catch (error) {
    return errorResponse(error, "Failed to attach worktree for epic branch", 400);
  }

  // Start merge in worktree to surface conflicts. The base is the project's
  // resolved default branch — the same one `mergeWorktree` is handed below;
  // hardcoding "main" surfaced conflicts against a branch the merge would
  // never touch on a repo whose default is anything else.
  let mergeResult: { conflicted: boolean; output: string };
  try {
    mergeResult = await startMergeInWorktree(
      worktreePath,
      project.defaultBranch || "main"
    );
  } catch (error) {
    return errorResponse(error, "Failed to start merge");
  }

  // If merge was clean, just do the final merge into main directly
  if (!mergeResult.conflicted) {
    const preflight = applyTransition({
      projectId,
      epicId,
      fromStatus: (epic.status ?? "to_merge") as KanbanStatus,
      toStatus: "done",
      actor: "user",
      source: "merge",
      reason: "Merge resolution preflight",
      validateOnly: true,
    });
    if (!preflight.valid) {
      return NextResponse.json({ error: preflight.error }, { status: 400 });
    }
    if (!autoModeRegistry.tryLockProjectMerge(projectId)) {
      return NextResponse.json(
        {
          error:
            "Another merge is in progress in this repository — retry in a moment.",
        },
        { status: 409 }
      );
    }
    let finalMerge: MergeWorktreeResult;
    try {
      finalMerge = await mergeWorktree(gitRepoPath, branchName, worktreePath, {
        defaultBranch: project.defaultBranch,
      });
    } catch (e) {
      finalMerge = {
        merged: false,
        error: e instanceof Error ? e.message : "Final merge failed",
        reason: "error",
      };
    } finally {
      autoModeRegistry.unlockProjectMerge(projectId);
    }
    if (!finalMerge.merged) {
      // `mergeFailed` marks the failures where GIT refused, the same flag the
      // approve route sets. Callers use it to decide whether offering another
      // Resolve merge is a way out or just the same wall again.
      return NextResponse.json(
        {
          error: finalMerge.error || "Final merge failed",
          mergeFailed: isGitRefusalMergeReason(finalMerge.reason),
        },
        { status: 500 }
      );
    }

    const transition = applyTransition({
      projectId,
      epicId,
      fromStatus: (epic.status ?? "to_merge") as KanbanStatus,
      toStatus: "done",
      actor: "user",
      source: "merge",
      reason: "Clean merge resolution completed",
    });
    if (!transition.valid) {
      return NextResponse.json({ error: transition.error }, { status: 409 });
    }
    db.update(epics)
      .set({ branchName: null, updatedAt: new Date().toISOString() })
      .where(eq(epics.id, epicId))
      .run();

    // The merge is the approval: open review comments are accepted with it.
    // After the transition, never before — see lib/workflow/merge-approval.ts.
    resolveOpenReviewComments(epicId);

    tryExportArjiJson(projectId);

    return NextResponse.json({
      data: {
        resolved: true,
        clean: true,
        commitHash: finalMerge.commitHash,
      },
    });
  }

  // Conflicts exist — spawn an agent to resolve them

  const settingsRow = db
    .select()
    .from(settings)
    .where(eq(settings.key, "global_prompt"))
    .get();
  const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";

  const prompt = buildMergeResolutionPrompt(
    project,
    epic,
    branchName,
    mergeResult.output,
    globalPrompt
  );

  // Create session
  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");

  // Resume support — scope-guarded
  let cliSessionId: string | undefined;
  let resumeSession = false;
  if (isResumableProvider(provider) && body.resumeSessionId) {
    const validated = validateResumeSession({
      resumeSessionId: body.resumeSessionId,
      epicId: epicId,
      expectedProvider: provider,
    });
    if (validated) {
      cliSessionId = validated.cliSessionId;
      resumeSession = true;
    }
  }
  if (!cliSessionId && providerAcceptsAssignedSessionId(provider)) {
    cliSessionId = crypto.randomUUID();
  }

  createQueuedSession({
    id: sessionId,
    projectId,
    epicId,
    mode: "code",
    provider,
    prompt,
    logsPath,
    branchName,
    worktreePath,
    cliSessionId,
    namedAgentId: resolved.namedAgentId ?? null,
    compositeAgentId: resolved.compositeAgentId ?? null,
    agentType: "merge",
    namedAgentName: resolved.name || null,
    model: resolved.model || null,
    createdAt: now,
  });

  // Spawn agent in the worktree
  markSessionRunning(sessionId, now);
  processManager.start(sessionId, {
    mode: "code",
    prompt,
    cwd: worktreePath,
    model,
    allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
    cliSessionId,
    resumeSession,
  }, provider);

  // Background completion handler
  (async () => {
    const info = await waitForProcessCompletion(sessionId);

    const completedAt = new Date().toISOString();
    const result = info?.result;

    try {
      fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
    } catch {
      // ignore
    }

    try {
      markSessionTerminal(
        sessionId,
        {
          success: !!result?.success,
          error: result?.error || null,
          outcome: classifySessionOutcome(result, sessionId),
          usage: extractSessionUsage(result),
        },
        completedAt
      );
    } catch (error) {
      if (!isSessionLifecycleConflictError(error)) {
        console.error("[resolve merge] Failed to finalize session", error);
      }
    }

    // On success: attempt the final merge into main
    if (result?.success) {
      const currentStatus = (db
        .select({ status: epics.status })
        .from(epics)
        .where(eq(epics.id, epicId))
        .get()?.status ?? "to_merge") as KanbanStatus;
      const preflight = applyTransition({
        projectId,
        epicId,
        fromStatus: currentStatus,
        toStatus: "done",
        actor: "agent",
        source: "merge",
        reason: "Merge-fix completion preflight",
        sessionId,
        validateOnly: true,
      });
      if (!preflight.valid) {
        // A silent return here is how tickets used to get stuck in a merge
        // loop: the agent resolved the conflicts, the workflow refused the
        // completion, and nobody was told. Leave a trail.
        try {
          db.insert(ticketComments)
            .values({
              id: createId(),
              epicId,
              author: "agent",
              content: `**Merge resolution finished, but the ticket could not be completed.** ${preflight.error ?? "The workflow engine refused the transition."}\n\nThe branch was NOT merged. Fix the refusal reason, then run the merge again.`,
              agentSessionId: sessionId,
              createdAt: completedAt,
            })
            .run();
          createMergeRetryFailedNotification({
            projectId,
            epicId,
            sessionId,
            error: preflight.error ?? "Workflow transition refused",
          });
        } catch (trailError) {
          console.error(
            "[resolve merge] Failed to record the refusal trail:",
            trailError
          );
        }
        return;
      }
      if (!autoModeRegistry.tryLockProjectMerge(projectId)) {
        createMergeRetryFailedNotification({
          projectId,
          epicId,
          sessionId,
          error:
            "Final merge blocked: another merge is in progress in this repository.",
        });
        return;
      }
      let finalMerge: MergeWorktreeResult;
      try {
        finalMerge = await mergeWorktree(
          gitRepoPath,
          branchName,
          worktreePath,
          { defaultBranch: project.defaultBranch }
        );
      } catch (e) {
        finalMerge = {
          merged: false,
          error: e instanceof Error ? e.message : "Final merge failed",
          reason: "error",
        };
      } finally {
        autoModeRegistry.unlockProjectMerge(projectId);
      }

      if (finalMerge.merged) {
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
        if (!transition.valid) {
          // The branch IS on main at this point — never fail silently, or
          // the board and the repository quietly disagree.
          try {
            db.insert(ticketComments)
              .values({
                id: createId(),
                epicId,
                author: "agent",
                content: `**Branch merged, but the ticket could not be moved to Done.** ${transition.error ?? "The workflow engine refused the transition."}\n\nThe code IS on main; move the ticket manually once the refusal reason is fixed.`,
                agentSessionId: sessionId,
                createdAt: completedAt,
              })
              .run();
          } catch (trailError) {
            console.error(
              "[resolve merge] Failed to record the post-merge refusal trail:",
              trailError
            );
          }
          return;
        }
        // After the transition, never before (lib/workflow/merge-approval.ts).
        resolveOpenReviewComments(epicId);

        db.update(epics)
          .set({ branchName: null, updatedAt: completedAt })
          .where(eq(epics.id, epicId))
          .run();

        tryExportArjiJson(projectId);
      } else {
        // The agent claimed success but the follow-up merge STILL failed —
        // e.g. it committed the conflict markers, tripping the marker guard.
        // This closure has no HTTP response left to carry the failure, so a
        // silent swallow here would be exactly the bug this route exists to
        // kill: an epic that never closes and no word on why.
        const mergeError = finalMerge.error || "Merge failed";
        try {
          db.insert(ticketComments)
            .values({
              id: createId(),
              epicId,
              author: "agent",
              content: `**Merge resolution finished, but the final merge still failed.** ${mergeError}\n\nThe epic keeps its current status. Run Resolve Merge again to land the branch.`,
              createdAt: completedAt,
            })
            .run();

          createMergeRetryFailedNotification({
            projectId,
            epicId,
            sessionId,
            error: mergeError,
          });
        } catch (trailError) {
          console.error(
            "[resolve merge] Failed to record the merge-failure trail:",
            trailError
          );
        }
      }
    }

    // Post agent output as epic comment
    const output = resolveSessionOutput(result, sessionId, "Merge resolution agent completed without output.");

    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId,
        author: "agent",
        content: output,
        agentSessionId: sessionId,
        createdAt: completedAt,
      })
      .run();
  })();

  return NextResponse.json({
    data: { sessionId, resolved: false },
  });
}
