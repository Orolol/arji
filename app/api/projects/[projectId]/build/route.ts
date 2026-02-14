import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
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

import fs from "fs";
import path from "path";
import { tryExportArjiJson } from "@/lib/sync/export";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { resolveAgentByNamedId } from "@/lib/agent-config/providers";
import {
  enrichPromptWithDocumentMentions,
  MentionResolutionError,
} from "@/lib/documents/mentions";

function collectEpicMentionSources(
  epic: { title?: string | null; description?: string | null },
  stories: Array<{
    title?: string | null;
    description?: string | null;
    acceptanceCriteria?: string | null;
  }>
): Array<string | null | undefined> {
  return [
    epic.title,
    epic.description,
    ...stories.map((story) => story.title),
    ...stories.map((story) => story.description),
    ...stories.map((story) => story.acceptanceCriteria),
  ];
}

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
    namedAgentId = null,
  } = body as {
    epicIds: string[];
    mode?: "sequential" | "parallel";
    team?: boolean;
    namedAgentId?: string | null;
  };

  if (!epicIds || !Array.isArray(epicIds) || epicIds.length === 0) {
    return NextResponse.json(
      { error: "epicIds array is required" },
      { status: 400 }
    );
  }

  // Conflict check up-front so batch launches fail fast with a deterministic payload.
  for (const epicId of epicIds) {
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
  }

  // Team mode is Claude Code exclusive — no sub-agent delegation outside Claude today.
  const resolvedTeamCheck = resolveAgentByNamedId("team_build", projectId, namedAgentId);
  if (team && resolvedTeamCheck.provider !== "claude-code") {
    return NextResponse.json(
      { error: "Team mode is only available with Claude Code. Other providers do not support sub-agent delegation." },
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
        [],
        teamEpics,
        teamBuildSystemPrompt
      );
      let enrichedTeamPrompt = prompt;
      try {
        enrichedTeamPrompt = enrichPromptWithDocumentMentions({
          projectId,
          prompt,
          textSources: teamEpics.flatMap((teamEpic) => [
            teamEpic.title,
            teamEpic.description,
            ...teamEpic.userStories.map((story) => story.title),
            ...teamEpic.userStories.map((story) => story.description),
            ...teamEpic.userStories.map((story) => story.acceptanceCriteria),
          ]),
        }).prompt;
      } catch (error) {
        if (error instanceof MentionResolutionError) {
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
      const resolvedTeamAgent = resolveAgentByNamedId(
        "team_build",
        projectId,
        namedAgentId
      );
      if (resolvedTeamAgent.provider !== "claude-code") {
        return NextResponse.json(
          { error: "Team mode is only available with Claude Code." },
          { status: 400 }
        );
      }

      // Create single team session
      const sessionId = createId();
      const now = new Date().toISOString();
      const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
      fs.mkdirSync(logsDir, { recursive: true });
      const logsPath = path.join(logsDir, "logs.json");

      const teamCliSessionId = crypto.randomUUID();

      createQueuedSession({
        id: sessionId,
        projectId,
        mode: "code",
        orchestrationMode: "team",
        provider: resolvedTeamAgent.provider,
        prompt: enrichedTeamPrompt,
        logsPath,
        claudeSessionId: teamCliSessionId,
        cliSessionId: teamCliSessionId,
        namedAgentId: resolvedTeamAgent.namedAgentId ?? null,
        agentType: "team_build",
        namedAgentName: resolvedTeamAgent.name || null,
        model: resolvedTeamAgent.model || null,
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
        prompt: enrichedTeamPrompt,
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
        model: resolvedTeamAgent.model,
        cliSessionId: teamCliSessionId,
      }, resolvedTeamAgent.provider);

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
      [],
      epic,
      us,
      buildSystemPrompt
    );
    let enrichedPrompt = prompt;
    try {
      enrichedPrompt = enrichPromptWithDocumentMentions({
        projectId,
        prompt,
        textSources: collectEpicMentionSources(epic, us),
      }).prompt;
    } catch (error) {
      if (error instanceof MentionResolutionError) {
        throw error;
      }
      throw error;
    }
    const resolvedBuildAgent = resolveAgentByNamedId("build", projectId, namedAgentId);

    // Create session in DB
    const sessionId = createId();
    const now = new Date().toISOString();
    const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "logs.json");

    // Check concurrency guard first
    const conflict = getRunningSessionForTarget({
      scope: "epic",
      projectId,
      epicId,
    });
    if (conflict) {
      throw createAgentAlreadyRunningPayload(
        { scope: "epic", projectId, epicId },
        conflict,
        "Another agent is already running for this epic."
      );
    }

    const providerSupportsResume =
      resolvedBuildAgent.provider === "claude-code" || resolvedBuildAgent.provider === "gemini-cli";
    const soloCliSessionId = providerSupportsResume ? crypto.randomUUID() : undefined;

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId,
      mode: "code",
      orchestrationMode: "solo",
      provider: resolvedBuildAgent.provider,
      prompt: enrichedPrompt,
      logsPath,
      branchName,
      worktreePath,
      claudeSessionId: soloCliSessionId,
      cliSessionId: soloCliSessionId,
      namedAgentId: resolvedBuildAgent.namedAgentId ?? null,
      agentType: "build",
      namedAgentName: resolvedBuildAgent.name || null,
      model: resolvedBuildAgent.model || null,
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
      prompt: enrichedPrompt,
      cwd: worktreePath,
      allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
      model: resolvedBuildAgent.model,
      cliSessionId: soloCliSessionId,
    }, resolvedBuildAgent.provider);

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
      // The ticket should go through review before being moved to done/merged.
      if (result?.success) {
        db.update(userStories)
          .set({ status: "review" })
          .where(
            and(
              eq(userStories.epicId, epicId),
              notInArray(userStories.status, ["done"])
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
    if (e instanceof MentionResolutionError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "AGENT_ALREADY_RUNNING"
    ) {
      return NextResponse.json(e, { status: 409 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Build launch failed" },
      { status: 500 }
    );
  }
}
