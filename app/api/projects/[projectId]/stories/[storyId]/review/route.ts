import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  userStories,
  ticketComments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import { loadPromptComments } from "@/lib/claude/prompt-comments";
import { assembleStoryReviewPrompt } from "@/lib/tokens";
import { type ReviewType } from "@/lib/claude/prompt-builder";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import { handleAskedQuestionOutcome } from "@/lib/workflow/agent-question";
import {
  getEpicOr404,
  getProjectOr404,
  getStoryOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import fs from "fs";
import path from "path";
import { REVIEW_TYPE_TO_AGENT_TYPE } from "@/lib/agent-config/constants";
import { resolveAgentForDispatch } from "@/lib/agent-config/agent-resolution";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
import { agentScheduler } from "@/lib/agents/scheduler";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import {
  buildEpicTargetUrl,
  createUnresolvedMentionsNotification,
} from "@/lib/notifications/create";
import { validateResumeSession } from "@/lib/agent-sessions/validate-resume";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import { transitionReviewRejected } from "@/lib/workflow/automatic-transitions";
import {
  resolveReviewVerdict,
  resolvePriorFindingsFromProse,
} from "@/lib/pipeline/findings";

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
  const body = await request.json().catch(() => ({}));

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

  // Validate story exists (project-scoped) and is in review status
  const foundStory = getStoryOr404(projectId, storyId);
  if (isErrorResponse(foundStory)) return foundStory;
  const { story } = foundStory;

  if (story.status !== "review" && story.status !== "done") {
    return NextResponse.json(
      { error: "Story must be in review or done status for agent review" },
      { status: 400 }
    );
  }

  // Get epic (project-scoped)
  const foundEpic = getEpicOr404(projectId, story.epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;
  const { epic } = foundEpic;

  // Concurrency guard — one active agent per story (or its parent epic)
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

  // Get project
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

  // Load context
  const comments = loadPromptComments({ userStoryId: storyId });

  // Ensure worktree exists
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title,
    { defaultBranch: project.defaultBranch }
  );

  const sessionsCreated: string[] = [];
  const resolutions: Array<{
    sessionId: string;
    reviewType: ReviewType;
    provider: string;
    segregated: boolean;
    builderProvider: string | null;
  }> = [];

  // Dispatch one agent per review type
  for (const [idx, reviewType] of reviewTypes.entries()) {
    const assembled = await assembleStoryReviewPrompt({
      projectId,
      epicId: epic.id,
      storyId,
      project,
      epic,
      story,
      reviewType,
      comments,
    });
    const enrichedPrompt = assembled.prompt;
    createUnresolvedMentionsNotification({
      projectId,
      missing: assembled.missingDocuments ?? [],
      agentType: REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      targetUrl: buildEpicTargetUrl(projectId, epic.id),
    });
    const resolvedAgent = await resolveAgentForDispatch(
      REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      projectId,
      namedAgentId,
      { purpose: "review", projectId, epicId: epic.id, storyId },
    );

    const sessionId = createId();
    const now = new Date().toISOString();
    const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "logs.json");

    // All review types run in code mode: plan mode refuses mutating MCP
    // tools (submit_findings, create_bug) and read-only provider postures
    // cut the tool channel. The reviewer's no-modification rule is a prompt
    // contract (REVIEW_BOUNDARY_SECTION), not a harness restriction.
    const agentMode = "code";

    // First review session can resume; subsequent ones start fresh. Resolved
    // per review type because each one may land on a different provider, and
    // the stored id is only valid for the provider that created it.
    const resumeCliSessionId =
      idx === 0 && resumeSessionIdParam
        ? validateResumeSession({
            resumeSessionId: resumeSessionIdParam,
            epicId: epic.id,
            userStoryId: storyId,
            expectedProvider: resolvedAgent.provider,
          })?.cliSessionId
        : undefined;

    const useResume = !!resumeCliSessionId;
    const cliSessionId = useResume
      ? resumeCliSessionId
      : providerAcceptsAssignedSessionId(resolvedAgent.provider)
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
      estimatedPromptTokens: assembled.tokens.total,
      estimatedPromptBreakdown: JSON.stringify(assembled.tokens.breakdown),
      logsPath,
      branchName,
      worktreePath,
      cliSessionId,
      namedAgentId: resolvedAgent.namedAgentId ?? null,
      namedAgentName: resolvedAgent.name || null,
      model: resolvedAgent.model || null,
      agentType: REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      createdAt: now,
    });

    // Scheduled launch via the per-project scheduler. The closure spawns
    // the agent — feature_review runs in code mode, others in plan mode
    // (read-only) — waits for completion, and posts the review comment.
    const label = REVIEW_LABELS[reviewType];
    ((sid, lbl) => {
      agentScheduler.submit(projectId, sid, async () => {
        markSessionRunning(sid);
        processManager.start(sid, {
          mode: agentMode,
          prompt: enrichedPrompt,
          cwd: worktreePath,
          model: resolvedAgent.model,
          cliSessionId,
          resumeSession: useResume,
        }, resolvedAgent.provider);

        const info = await waitForProcessCompletion(sid);

        const completedAt = new Date().toISOString();
        const result = info?.result;

        // Write logs
        try {
          fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
        } catch {
          // ignore
        }

        // Update session
        const outcome = classifySessionOutcome(result, sid);

        try {
          markSessionTerminal(
            sid,
            {
              success: !!result?.success,
              error: result?.error || null,
              outcome,
              usage: extractSessionUsage(result),
            },
            completedAt
          );
        } catch (error) {
          if (!isSessionLifecycleConflictError(error)) {
            console.error("[story review] Failed to finalize session", error);
          }
        }

        // Post review as comment with label
        const output = resolveSessionOutput(result, sid, "Review agent completed without output.");

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

        // asked_question guard: the reviewer stopped to ask the user
        // something, so its output is not a verdict — hold the story where
        // it is, notify, log the decision, and skip verdict handling.
        const askedQuestion = outcome === "asked_question";
        if (askedQuestion) {
          handleAskedQuestionOutcome({
            projectId,
            epicIds: [epic.id],
            sessionId: sid,
            ticketStatus: story.status ?? "review",
          });
        }

        // If the review verdict indicates work is not done, revert the story
        // back to in_progress. Channels in priority order: the reviewer's
        // persisted submit_findings verdict, else the prose scan of its final
        // message (lib/pipeline/findings.ts owns the priority; a reviewer on
        // a provider without MCP only ever produces the prose one).
        // Prose fallback of submit_findings.prior_findings: [RC:id] FIXED
        // lines in the report resolve the prior findings they name.
        if (!askedQuestion) {
          resolvePriorFindingsFromProse({
            epicId: epic.id,
            sessionOutput: output,
          });
        }

        const decision = askedQuestion
          ? null
          : resolveReviewVerdict({
              epicId: epic.id,
              reviewSessionId: sid,
              sessionOutput: output,
            });

        if (decision?.negative) {
          const currentStory = db
            .select()
            .from(userStories)
            .where(eq(userStories.id, storyId))
            .get();

          if (currentStory && (currentStory.status === "done" || currentStory.status === "review")) {
            transitionReviewRejected({
              projectId,
              epicId: currentStory.epicId,
              scope: "story",
              userStoryId: storyId,
              sessionId: sid,
              reason: `Review verdict: changes requested (${lbl})`,
              verdictSource: decision.source,
            });
          }
        }
      });
    })(sessionId, label);

    sessionsCreated.push(sessionId);
    resolutions.push({
      sessionId,
      reviewType,
      provider: resolvedAgent.provider,
      segregated: !!resolvedAgent.segregated,
      builderProvider: resolvedAgent.builderProvider ?? null,
    });
  }

  return NextResponse.json({
    data: {
      sessions: sessionsCreated,
      count: sessionsCreated.length,
      resolutions,
    },
  });
}
