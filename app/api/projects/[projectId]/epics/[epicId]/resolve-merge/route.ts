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
  createWorktree,
  isGitRepo,
  startMergeInWorktree,
  mergeWorktree,
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

  // Ensure worktree exists
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title,
    { defaultBranch: project.defaultBranch }
  );

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
      fromStatus: (epic.status ?? "review") as KanbanStatus,
      toStatus: "done",
      actor: "user",
      source: "merge",
      reason: "Merge resolution preflight",
      validateOnly: true,
    });
    if (!preflight.valid) {
      return NextResponse.json({ error: preflight.error }, { status: 400 });
    }
    const finalMerge = await mergeWorktree(gitRepoPath, branchName, worktreePath, {
      defaultBranch: project.defaultBranch,
    });
    if (!finalMerge.merged) {
      // `mergeFailed` marks the failures where GIT refused, the same flag the
      // approve route sets. Callers use it to decide whether offering another
      // Resolve merge is a way out or just the same wall again.
      return NextResponse.json(
        { error: finalMerge.error || "Final merge failed", mergeFailed: true },
        { status: 500 }
      );
    }

    const transition = applyTransition({
      projectId,
      epicId,
      fromStatus: (epic.status ?? "review") as KanbanStatus,
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
        .get()?.status ?? "review") as KanbanStatus;
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
      if (!preflight.valid) return;

      const finalMerge = await mergeWorktree(
        gitRepoPath,
        branchName,
        worktreePath,
        { defaultBranch: project.defaultBranch }
      );

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
        if (!transition.valid) return;
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
