import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, agentSessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { mergeWorktree } from "@/lib/git/manager";
import { tryExportArjiJson } from "@/lib/sync/export";
import { createId } from "@/lib/utils/nanoid";
import { processManager } from "@/lib/claude/process-manager";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import {
  createQueuedSession,
  markSessionRunning,
  markSessionTerminal,
  isSessionLifecycleConflictError,
} from "@/lib/agent-sessions/lifecycle";
import {
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
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

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project || !project.gitRepoPath) {
    return NextResponse.json({ error: "Project not found or no git repo" }, { status: 404 });
  }

  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  if (!epic.branchName) {
    return NextResponse.json({ error: "Epic has no branch to merge" }, { status: 400 });
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

  const result = await mergeWorktree(project.gitRepoPath, epic.branchName, worktreePath);

  if (result.merged) {
    // Move epic to done
    const now = new Date().toISOString();
    db.update(epics)
      .set({ status: "done", branchName: null, updatedAt: now })
      .where(eq(epics.id, epicId))
      .run();

    tryExportArjiJson(projectId);

    return NextResponse.json({
      data: {
        merged: true,
        commitHash: result.commitHash,
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
        { error: result.error || "Merge failed", autoAgent: false, reason: "Agent already running" },
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

    const claudeSessionId = crypto.randomUUID();

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
      claudeSessionId,
      agentType: "merge",
      createdAt: now,
    });

    markSessionRunning(sessionId, now);
    processManager.start(sessionId, {
      mode: "code",
      prompt,
      cwd: worktreePath,
      allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
      claudeSessionId,
    });

    // Background: wait for completion, attempt merge again (no retry cap)
    (async () => {
      let info = processManager.getStatus(sessionId);
      while (info && info.status === "running") {
        await new Promise((r) => setTimeout(r, 2000));
        info = processManager.getStatus(sessionId);
      }

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
          project.gitRepoPath,
          epic.branchName!,
          worktreePath
        );
        if (retryResult.merged) {
          db.update(epics)
            .set({ status: "done", branchName: null, updatedAt: new Date().toISOString() })
            .where(eq(epics.id, epicId))
            .run();
          tryExportArjiJson(projectId);
        }
      }
    })();

    return NextResponse.json({
      data: {
        merged: false,
        autoAgent: true,
        sessionId,
        error: result.error || "Merge failed — agent launched to resolve",
      },
    });
  }

  return NextResponse.json(
    { error: result.error || "Merge failed" },
    { status: 500 }
  );
}
