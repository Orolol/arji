import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
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
import fs from "fs";
import path from "path";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { REVIEW_TYPE_TO_AGENT_TYPE } from "@/lib/agent-config/constants";
import { resolveAgentByNamedId } from "@/lib/agent-config/providers";
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
import {
  MentionResolutionError,
  enrichPromptWithDocumentMentions,
} from "@/lib/documents/mentions";
import { agentSessions } from "@/lib/db/schema";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

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
  const { projectId, storyId } = await params;
  const body = await request.json();

  const { reviewTypes, namedAgentId: namedAgentIdParam, resumeSessionId: resumeSessionIdParam } = body as {
    reviewTypes: ReviewType[];
    namedAgentId?: string | null;
    resumeSessionId?: string;
  };
  const namedAgentId: string | null = namedAgentIdParam || null;

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

  if (story.status !== "review" && story.status !== "done") {
    return NextResponse.json(
      { error: "Story must be in review or done status for agent review" },
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
  const comments = db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.userStoryId, storyId))
    .orderBy(ticketComments.createdAt)
    .all();

  // Ensure worktree exists
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title
  );

  // Resume support: look up previous session's cliSessionId
  let resumeCliSessionId: string | undefined;
  if (resumeSessionIdParam) {
    const prevSession = db
      .select({
        cliSessionId: agentSessions.cliSessionId,
        claudeSessionId: agentSessions.claudeSessionId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, resumeSessionIdParam))
      .get();
    const previousCliSessionId =
      prevSession?.cliSessionId ?? prevSession?.claudeSessionId ?? null;
    if (previousCliSessionId) {
      resumeCliSessionId = previousCliSessionId;
    }
  }

  const sessionsCreated: string[] = [];

  // Dispatch one agent per review type
  for (const [idx, reviewType] of reviewTypes.entries()) {
    const reviewSystemPrompt = await resolveAgentPrompt(
      REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      projectId
    );
    const prompt = buildReviewPrompt(
      project,
      [],
      epic,
      story,
      reviewType,
      reviewSystemPrompt
    );

    let enrichedPrompt = prompt;
    try {
      enrichedPrompt = enrichPromptWithDocumentMentions({
        projectId,
        prompt,
        textSources: comments.map((comment) => comment.content),
      }).prompt;
    } catch (error) {
      if (error instanceof MentionResolutionError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const resolvedAgent = resolveAgentByNamedId(
      REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      projectId,
      namedAgentId,
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

    const agentMode = reviewType === "feature_review" ? "code" : "plan";
    const providerSupportsResume =
      resolvedAgent.provider === "claude-code" || resolvedAgent.provider === "gemini-cli";

    // First review session can resume (when provider supports it); subsequent ones start fresh
    const useResume = idx === 0 && providerSupportsResume && !!resumeCliSessionId;
    const cliSessionId = useResume
      ? resumeCliSessionId
      : providerSupportsResume
        ? crypto.randomUUID()
        : undefined;

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId: epic.id,
      userStoryId: storyId,
      mode: agentMode,
      provider: resolvedAgent.provider,
      prompt: enrichedPrompt,
      logsPath,
      branchName,
      worktreePath,
      claudeSessionId: cliSessionId,
      cliSessionId,
      namedAgentId: resolvedAgent.namedAgentId ?? null,
      namedAgentName: resolvedAgent.name || null,
      model: resolvedAgent.model || null,
      agentType: REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      createdAt: now,
    });

    // Spawn agent — feature_review runs in code mode, others in plan mode (read-only)
    markSessionRunning(sessionId, now);
    processManager.start(sessionId, {
      mode: agentMode,
      prompt: enrichedPrompt,
      cwd: worktreePath,
      model: resolvedAgent.model,
      cliSessionId,
      resumeSession: useResume,
    }, resolvedAgent.provider);

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

        // If the review verdict indicates work is not done, revert
        // the story back to in_progress
        const lowerOutput = output.toLowerCase();
        const isNegativeVerdict =
          lowerOutput.includes("changes requested") ||
          lowerOutput.includes("not complete") ||
          lowerOutput.includes("partially complete");

        if (isNegativeVerdict) {
          const currentStory = db
            .select()
            .from(userStories)
            .where(eq(userStories.id, storyId))
            .get();

          if (currentStory && (currentStory.status === "done" || currentStory.status === "review")) {
            db.update(userStories)
              .set({ status: "in_progress" })
              .where(eq(userStories.id, storyId))
              .run();

            // Also revert the parent epic if it's done/review
            const parentEpic = db
              .select()
              .from(epics)
              .where(eq(epics.id, currentStory.epicId))
              .get();

            if (parentEpic && (parentEpic.status === "done" || parentEpic.status === "review")) {
              db.update(epics)
                .set({ status: "in_progress", updatedAt: completedAt })
                .where(eq(epics.id, currentStory.epicId))
                .run();
            }
          }
        }
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
