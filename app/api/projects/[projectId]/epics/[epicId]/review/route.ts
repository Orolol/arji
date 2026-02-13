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
  buildEpicReviewPrompt,
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

type Params = { params: Promise<{ projectId: string; epicId: string }> };

const VALID_REVIEW_TYPES: ReviewType[] = [
  "security",
  "code_review",
  "compliance",
  "feature_review",
];

const REVIEW_LABELS: Record<ReviewType, string> = {
  security: "Security Review",
  code_review: "Code Review",
  compliance: "Compliance & Accessibility Review",
  feature_review: "Feature Review",
};

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;
  const body = await request.json();

  const { reviewTypes, provider: providerParam } = body as {
    reviewTypes: ReviewType[];
    provider?: ProviderType;
  };
  const provider: ProviderType = providerParam || "claude-code";

  if (!reviewTypes || !Array.isArray(reviewTypes) || reviewTypes.length === 0) {
    return NextResponse.json(
      { error: "reviewTypes array is required with at least one type" },
      { status: 400 }
    );
  }

  for (const rt of reviewTypes) {
    if (!VALID_REVIEW_TYPES.includes(rt)) {
      return NextResponse.json(
        { error: `Invalid review type: ${rt}. Valid types: ${VALID_REVIEW_TYPES.join(", ")}` },
        { status: 400 }
      );
    }
  }

  // Validate epic in review status
  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }
  if (epic.status !== "review") {
    return NextResponse.json(
      { error: "Epic must be in review status for agent review" },
      { status: 400 }
    );
  }

  // Concurrency guard
  const lock = checkSessionLock({ epicId });
  if (lock.locked) {
    return NextResponse.json(
      { error: "conflict", message: "An agent is already running on this epic", sessionId: lock.sessionId },
      { status: 409 }
    );
  }

  // Get project
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

  // Load context
  const docs = db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .all();

  const us = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  // Load epic comments
  const comments = db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.epicId, epicId))
    .orderBy(ticketComments.createdAt)
    .all();

  const promptComments = comments.map((c) => ({
    author: c.author as "user" | "agent",
    content: c.content,
    createdAt: c.createdAt ?? "",
  }));

  // Ensure worktree exists
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title
  );

  const sessionsCreated: string[] = [];

  for (const [idx, reviewType] of reviewTypes.entries()) {
    const reviewSystemPrompt = await resolveAgentPrompt(
      REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      projectId
    );
    const prompt = buildEpicReviewPrompt(
      project,
      docs,
      epic,
      us,
      reviewType,
      reviewSystemPrompt,
      promptComments
    );

    const sessionId = createId();
    const now = new Date().toISOString();
    const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "logs.json");

    // For the first review, check concurrency guard
    if (idx === 0) {
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

    const agentMode = reviewType === "feature_review" ? "code" : "plan";

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId,
      mode: agentMode,
      provider,
      prompt,
      logsPath,
      branchName,
      worktreePath,
      createdAt: now,
    });

    markSessionRunning(sessionId, now);
    processManager.start(sessionId, {
      mode: agentMode,
      prompt,
      cwd: worktreePath,
    }, provider);

    // Background: wait for completion, post review as epic comment
    const label = REVIEW_LABELS[reviewType];
    ((sid, lbl) => {
      (async () => {
        let info = processManager.getStatus(sid);
        while (info && info.status === "running") {
          await new Promise((r) => setTimeout(r, 2000));
          info = processManager.getStatus(sid);
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
            sid,
            {
              success: !!result?.success,
              error: result?.error || null,
            },
            completedAt
          );
        } catch (error) {
          if (!isSessionLifecycleConflictError(error)) {
            console.error("[epic review] Failed to finalize session", error);
          }
        }

        const output = result?.result
          ? parseClaudeOutput(result.result).content
          : result?.error || "Review agent completed without output.";

        db.insert(ticketComments)
          .values({
            id: createId(),
            epicId,
            author: "agent",
            content: `**${lbl}**\n\n${output}`,
            agentSessionId: sid,
            createdAt: completedAt,
          })
          .run();
      })();
    })(sessionId, label);

    sessionsCreated.push(sessionId);
  }

  return NextResponse.json({
    data: {
      sessions: sessionsCreated,
      count: sessionsCreated.length,
    },
  });
}
