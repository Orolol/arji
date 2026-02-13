import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
  documents,
  ticketComments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import {
  buildReviewPrompt,
  type ReviewType,
} from "@/lib/claude/prompt-builder";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import { checkSessionLock } from "@/lib/session-lock";
import type { ProviderType } from "@/lib/providers";
import fs from "fs";
import path from "path";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { REVIEW_TYPE_TO_AGENT_TYPE } from "@/lib/agent-config/constants";
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

type Params = { params: Promise<{ projectId: string; storyId: string }> };

const VALID_REVIEW_TYPES: ReviewType[] = [
  "security",
  "code_review",
  "compliance",
];

const REVIEW_LABELS: Record<ReviewType, string> = {
  security: "Security Review",
  code_review: "Code Review",
  compliance: "Compliance & Accessibility Review",
};

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;
  const body = await request.json();

  const { reviewTypes, provider: providerParam } = body as {
    reviewTypes: ReviewType[];
    provider?: ProviderType;
  };
  const provider: ProviderType = providerParam || "claude-code";

  if (
    !reviewTypes ||
    !Array.isArray(reviewTypes) ||
    reviewTypes.length === 0
  ) {
    return NextResponse.json(
      { error: "reviewTypes array is required with at least one type" },
      { status: 400 }
    );
  }

  // Validate review types
  for (const rt of reviewTypes) {
    if (!VALID_REVIEW_TYPES.includes(rt)) {
      return NextResponse.json(
        { error: `Invalid review type: ${rt}. Valid types: ${VALID_REVIEW_TYPES.join(", ")}` },
        { status: 400 }
      );
    }
  }

  // Validate story exists and is in review status
  const story = db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get();

  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  if (story.status !== "review") {
    return NextResponse.json(
      { error: "Story must be in review status for agent review" },
      { status: 400 }
    );
  }

  // Concurrency guard
  const lock = checkSessionLock({ userStoryId: storyId });
  if (lock.locked) {
    return NextResponse.json(
      { error: "conflict", message: "An agent is already running on this story", sessionId: lock.sessionId },
      { status: 409 }
    );
  }

  // Get epic
  const epic = db
    .select()
    .from(epics)
    .where(eq(epics.id, story.epicId))
    .get();

  if (!epic) {
    return NextResponse.json(
      { error: "Parent epic not found" },
      { status: 404 }
    );
  }

  // Get project
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    return NextResponse.json(
      { error: "Project not found" },
      { status: 404 }
    );
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

  // Load context
  const docs = db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .all();

  // Ensure worktree exists
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title
  );

  const sessionsCreated: string[] = [];

  // Dispatch one agent per review type
  for (const [idx, reviewType] of reviewTypes.entries()) {
    const reviewSystemPrompt = await resolveAgentPrompt(
      REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      projectId
    );
    const prompt = buildReviewPrompt(
      project,
      docs,
      epic,
      story,
      reviewType,
      reviewSystemPrompt
    );

    const sessionId = createId();
    const now = new Date().toISOString();
    const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "logs.json");

    // For the first review, check concurrency guard
    if (idx === 0) {
      const conflict = getRunningSessionForTarget({
        scope: "story",
        projectId,
        storyId,
        epicId: epic.id,
      });
      if (conflict) {
        return NextResponse.json(
          createAgentAlreadyRunningPayload(
            { scope: "story", projectId, storyId, epicId: epic.id },
            conflict,
            "Another agent is already running for this story."
          ),
          { status: 409 }
        );
      }
    }

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId: epic.id,
      userStoryId: storyId,
      mode: "plan",
      provider,
      prompt,
      logsPath,
      branchName,
      worktreePath,
      createdAt: now,
    });

    // Spawn agent in plan mode (read-only)
    markSessionRunning(sessionId, now);
    processManager.start(sessionId, {
      mode: "plan",
      prompt,
      cwd: worktreePath,
    }, provider);

    // Background: wait for completion, post review comment
    const label = REVIEW_LABELS[reviewType];
    ((sid, rt, lbl) => {
      (async () => {
        let info = processManager.getStatus(sid);
        while (info && info.status === "running") {
          await new Promise((r) => setTimeout(r, 2000));
          info = processManager.getStatus(sid);
        }

        const completedAt = new Date().toISOString();
        const result = info?.result;

        // Write logs
        try {
          fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
        } catch {
          // ignore
        }

        // Update session
        try {
          markSessionTerminal(
            sid,
            {
              success: !!result?.success,
              error: result?.error || null,
            },
            completedAt
          );
        } catch (error) {
          if (!isSessionLifecycleConflictError(error)) {
            console.error("[story review] Failed to finalize session", error);
          }
        }

        // Post review as comment with label
        const output = result?.result
          ? parseClaudeOutput(result.result).content
          : result?.error || "Review agent completed without output.";

        db.insert(ticketComments)
          .values({
            id: createId(),
            userStoryId: storyId,
            author: "agent",
            content: `**${lbl}**\n\n${output}`,
            agentSessionId: sid,
            createdAt: completedAt,
          })
          .run();
      })();
    })(sessionId, reviewType, label);

    sessionsCreated.push(sessionId);
  }

  return NextResponse.json({
    data: {
      sessions: sessionsCreated,
      count: sessionsCreated.length,
    },
  });
}
