import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  ticketComments,
  settings,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import {
  createWorktree,
  isGitRepo,
  startMergeInWorktree,
  mergeWorktree,
} from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import { buildMergeResolutionPrompt } from "@/lib/claude/prompt-builder";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import type { ProviderType } from "@/lib/providers";
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

type Params = { params: Promise<{ projectId: string; epicId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;
  const body = await request.json().catch(() => ({}));
  const provider: ProviderType = body.provider || "claude-code";

  // Validate project
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project || !project.gitRepoPath) {
    return NextResponse.json(
      { error: "Project not found or no git repo" },
      { status: 404 }
    );
  }

  const gitRepoPath = project.gitRepoPath;
  const isRepo = await isGitRepo(gitRepoPath);
  if (!isRepo) {
    return NextResponse.json(
      { error: `Path is not a git repository: ${gitRepoPath}` },
      { status: 400 }
    );
  }

  // Validate epic
  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }
  if (!epic.branchName) {
    return NextResponse.json(
      { error: "Epic has no branch" },
      { status: 400 }
    );
  }

  // Ensure worktree exists
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title
  );

  // Start merge in worktree to surface conflicts
  let mergeResult: { conflicted: boolean; output: string };
  try {
    mergeResult = await startMergeInWorktree(worktreePath, "main");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to start merge";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // If merge was clean, just do the final merge into main directly
  if (!mergeResult.conflicted) {
    const finalMerge = await mergeWorktree(gitRepoPath, branchName, worktreePath);
    if (!finalMerge.merged) {
      return NextResponse.json(
        { error: finalMerge.error || "Final merge failed" },
        { status: 500 }
      );
    }

    const now = new Date().toISOString();
    db.update(epics)
      .set({ status: "done", branchName: null, updatedAt: now })
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

  // Check concurrency guard
  const conflict = getRunningSessionForTarget({
    scope: "epic",
    projectId,
    epicId,
  });
  if (conflict) {
    return NextResponse.json(
      createAgentAlreadyRunningPayload(
        { scope: "epic", projectId, epicId },
        conflict,
        "Another agent is already running for this epic."
      ),
      { status: 409 }
    );
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
    createdAt: now,
  });

  // Spawn agent in the worktree
  markSessionRunning(sessionId, now);
  processManager.start(sessionId, {
    mode: "code",
    prompt,
    cwd: worktreePath,
    allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
  }, provider);

  // Background completion handler
  (async () => {
    let info = processManager.getStatus(sessionId);
    while (info && info.status === "running") {
      await new Promise((r) => setTimeout(r, 2000));
      info = processManager.getStatus(sessionId);
    }

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
      const finalMerge = await mergeWorktree(
        gitRepoPath,
        branchName,
        worktreePath
      );

      if (finalMerge.merged) {
        db.update(epics)
          .set({ status: "done", branchName: null, updatedAt: completedAt })
          .where(eq(epics.id, epicId))
          .run();

        tryExportArjiJson(projectId);
      }
    }

    // Post agent output as epic comment
    const output = result?.result
      ? parseClaudeOutput(result.result).content
      : result?.error || "Merge resolution agent completed without output.";

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
