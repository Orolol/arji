import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
  documents,
} from "@/lib/db/schema";
import { eq, and, notInArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import {
  buildBuildPrompt,
  buildTeamBuildPrompt,
  type TeamEpic,
} from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import type { ProviderType } from "@/lib/providers";
import fs from "fs";
import path from "path";
import { tryExportArjiJson } from "@/lib/sync/export";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();
  const {
    epicIds,
    mode = "parallel",
    team = false,
    provider = "claude-code",
  } = body as {
    epicIds: string[];
    mode?: "sequential" | "parallel";
    team?: boolean;
    provider?: ProviderType;
  };

  if (!epicIds || !Array.isArray(epicIds) || epicIds.length === 0) {
    return NextResponse.json(
      { error: "epicIds array is required" },
      { status: 400 }
    );
  }

  // Team mode is Claude Code exclusive — Codex has no Task tool
  if (team && provider === "codex") {
    return NextResponse.json(
      { error: "Team mode is only available with Claude Code. Codex does not support sub-agent delegation." },
      { status: 400 }
    );
  }

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.gitRepoPath) {
    return NextResponse.json(
      { error: "Project has no git repository configured" },
      { status: 400 }
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

  // Load project context
  const docs = db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .all();
  const buildSystemPrompt = await resolveAgentPrompt("build", projectId);
  const teamBuildSystemPrompt = await resolveAgentPrompt(
    "team_build",
    projectId
  );

  const sessionsCreated: string[] = [];
  const projectRef = project;

  // -----------------------------------------------------------------------
  // TEAM MODE — single CC session managing multiple epics via Task tool
  // -----------------------------------------------------------------------
  if (team) {
    try {
      // Pre-create all worktrees
      const teamEpics: TeamEpic[] = [];
      const epicRecords: Array<{ id: string; branchName: string }> = [];

      for (const epicId of epicIds) {
        const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
        if (!epic) continue;

        const us = db
          .select()
          .from(userStories)
          .where(eq(userStories.epicId, epicId))
          .orderBy(userStories.position)
          .all();

        const { worktreePath, branchName } = await createWorktree(
          gitRepoPath,
          epic.id,
          epic.title
        );

        teamEpics.push({
          title: epic.title,
          description: epic.description,
          worktreePath,
          userStories: us,
        });

        epicRecords.push({ id: epicId, branchName });

        // Move epic to in_progress
        const now = new Date().toISOString();
        db.update(epics)
          .set({ status: "in_progress", branchName, updatedAt: now })
          .where(eq(epics.id, epicId))
          .run();
      }

      // Build team prompt
      const prompt = buildTeamBuildPrompt(
        projectRef,
        docs,
        teamEpics,
        teamBuildSystemPrompt
      );

      // Create single team session
      const sessionId = createId();
      const now = new Date().toISOString();
      const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
      fs.mkdirSync(logsDir, { recursive: true });
      const logsPath = path.join(logsDir, "logs.json");

      createQueuedSession({
        id: sessionId,
        projectId,
        mode: "code",
        orchestrationMode: "team",
        provider: "claude-code",
        prompt,
        logsPath,
        createdAt: now,
      });

      // Update project status
      db.update(projects)
        .set({ status: "building", updatedAt: now })
        .where(eq(projects.id, projectId))
        .run();

      // Spawn single CC session from main repo root with Task in allowedTools
      markSessionRunning(sessionId, now);
      processManager.start(sessionId, {
        mode: "code",
        prompt,
        cwd: gitRepoPath,
        allowedTools: [
          "Edit",
          "Write",
          "Bash",
          "Read",
          "Glob",
          "Grep",
          "Task",
        ],
      });

      // Background: wait for completion, update all epic statuses
      const allEpicIds = epicRecords.map((e) => e.id);
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
            console.error("[build/team] Failed to finalize session", error);
          }
        }

        // Update all associated epics
        if (result?.success) {
          for (const eid of allEpicIds) {
            db.update(epics)
              .set({ status: "review", updatedAt: completedAt })
              .where(eq(epics.id, eid))
              .run();
          }
        }
      })();

      sessionsCreated.push(sessionId);
      tryExportArjiJson(projectId);

      return NextResponse.json({
        data: {
          sessions: sessionsCreated,
          count: sessionsCreated.length,
          orchestrationMode: "team",
        },
      });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Team build launch failed" },
        { status: 500 }
      );
    }
  }

  // -----------------------------------------------------------------------
  // SOLO MODE — one session per epic (existing behavior)
  // -----------------------------------------------------------------------
  async function launchEpic(epicId: string) {
    const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
    if (!epic) return;

    const us = db
      .select()
      .from(userStories)
      .where(eq(userStories.epicId, epicId))
      .orderBy(userStories.position)
      .all();

    // Create worktree + branch
    const { worktreePath, branchName } = await createWorktree(
      gitRepoPath,
      epic.id,
      epic.title
    );

    // Compose prompt
    const prompt = buildBuildPrompt(
      projectRef,
      docs,
      epic,
      us,
      buildSystemPrompt
    );

    // Create session in DB
    const sessionId = createId();
    const now = new Date().toISOString();
    const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "logs.json");

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId,
      mode: "code",
      orchestrationMode: "solo",
      provider,
      prompt,
      logsPath,
      branchName,
      worktreePath,
      createdAt: now,
    });

    // Move epic to in_progress
    db.update(epics)
      .set({ status: "in_progress", branchName, updatedAt: now })
      .where(eq(epics.id, epicId))
      .run();

    // Sync US statuses: non-done -> in_progress
    db.update(userStories)
      .set({ status: "in_progress" })
      .where(
        and(
          eq(userStories.epicId, epicId),
          notInArray(userStories.status, ["done"])
        )
      )
      .run();

    // Update project status to building
    db.update(projects)
      .set({ status: "building", updatedAt: now })
      .where(eq(projects.id, projectId))
      .run();

    // Spawn agent via process manager
    markSessionRunning(sessionId, now);
    processManager.start(sessionId, {
      mode: "code",
      prompt,
      cwd: worktreePath,
      allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
    }, provider);

    // Background: wait for completion and update DB
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
          console.error("[build/solo] Failed to finalize session", error);
        }
      }

      // Move epic + US to review if successful
      if (result?.success) {
        db.update(userStories)
          .set({ status: "review" })
          .where(
            and(
              eq(userStories.epicId, epicId),
              eq(userStories.status, "in_progress")
            )
          )
          .run();

        db.update(epics)
          .set({ status: "review", updatedAt: completedAt })
          .where(eq(epics.id, epicId))
          .run();
      }
    })();

    sessionsCreated.push(sessionId);
  }

  try {
    if (mode === "sequential") {
      for (const epicId of epicIds) {
        await launchEpic(epicId);
      }
    } else {
      await Promise.all(epicIds.map(launchEpic));
    }

    tryExportArjiJson(projectId);
    return NextResponse.json({
      data: {
        sessions: sessionsCreated,
        count: sessionsCreated.length,
        orchestrationMode: "solo",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Build launch failed" },
      { status: 500 }
    );
  }
}
