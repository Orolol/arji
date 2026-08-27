import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loadPromptComments } from "@/lib/claude/prompt-comments";
import {
  epics,
  userStories,
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
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import {
  getEpicOr404,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import fs from "fs";
import path from "path";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
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
  enrichPromptWithDocumentMentions,
  userAuthoredTexts,
} from "@/lib/documents/mentions";
import {
  buildEpicTargetUrl,
  createUnresolvedMentionsNotification,
} from "@/lib/notifications/create";
import { validateResumeSession } from "@/lib/agent-sessions/validate-resume";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  transitionReviewRejected,
  transitionReviewPassed,
} from "@/lib/workflow/automatic-transitions";
import {
  resolveReviewVerdict,
  resolvePriorFindingsFromProse,
  collectBlockingFindings,
  readSessionFindingsWindow,
} from "@/lib/pipeline/findings";
import { handleAskedQuestionOutcome } from "@/lib/workflow/agent-question";
import {
  emitSessionStarted,
  emitSessionCompleted,
  emitSessionFailed,
} from "@/lib/events/emit";

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
  const body = await request.json().catch(() => ({}));

  const { reviewTypes, namedAgentId: namedAgentIdParam, resumeSessionId: resumeSessionIdParam } = body as {
    reviewTypes: ReviewType[];
    namedAgentId?: string | null;
    resumeSessionId?: string;
  };
  const namedAgentId: string | null = namedAgentIdParam || null;

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

  // Validate epic in review status (project-scoped lookup)
  const foundEpic = getEpicOr404(projectId, epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;
  const { epic } = foundEpic;
  if (
    epic.status !== "review" &&
    epic.status !== "to_merge" &&
    epic.status !== "done"
  ) {
    return NextResponse.json(
      { error: "Epic must be in review, to merge or done status for agent review" },
      { status: 400 }
    );
  }

  // Concurrency guard — one active agent per epic
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
  const us = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  // Load epic comments
  const promptComments = loadPromptComments({ epicId });

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

  for (const [idx, reviewType] of reviewTypes.entries()) {
    const reviewSystemPrompt = await resolveAgentPrompt(
      REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      projectId
    );
    const prompt = buildEpicReviewPrompt(
      project,
      [],
      epic,
      us,
      reviewType,
      reviewSystemPrompt,
      promptComments
    );

    // Only user-written comments can reference an Arij document; an agent
    // comment mentioning a codebase file must neither resolve nor block review.
    const mentionEnrichment = enrichPromptWithDocumentMentions({
      projectId,
      prompt,
      textSources: userAuthoredTexts(promptComments),
    });
    const enrichedPrompt = mentionEnrichment.prompt;
    createUnresolvedMentionsNotification({
      projectId,
      missing: mentionEnrichment.missing,
      agentType: REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      targetUrl: buildEpicTargetUrl(projectId, epicId),
    });

    const resolvedAgent = await resolveAgentForDispatch(
      REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      projectId,
      namedAgentId,
      { purpose: "review", projectId, epicId }
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
            epicId: epicId,
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
      epicId,
      mode: agentMode,
      provider: resolvedAgent.provider,
      prompt: enrichedPrompt,
      logsPath,
      branchName,
      worktreePath,
      cliSessionId,
      namedAgentId: resolvedAgent.namedAgentId ?? null,
      agentType: REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
      namedAgentName: resolvedAgent.name || null,
      model: resolvedAgent.model || null,
      createdAt: now,
    });

    emitSessionStarted(projectId, epicId, sessionId, REVIEW_TYPE_TO_AGENT_TYPE[reviewType]);

    // Scheduled launch via the per-project scheduler: spawn when a slot
    // frees, wait for completion, post the review as an epic comment.
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

        try {
          fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
        } catch {
          // ignore
        }

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
            console.error("[epic review] Failed to finalize session", error);
          }
        }

        const output = resolveSessionOutput(result, sid, "Review agent completed without output.");

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

        // asked_question guard: the reviewer stopped to ask the user
        // something, so its output is not a verdict — hold the ticket where
        // it is, notify, log the decision, and skip verdict handling.
        const askedQuestion = outcome === "asked_question";
        if (askedQuestion) {
          handleAskedQuestionOutcome({
            projectId,
            epicIds: [epicId],
            sessionId: sid,
            ticketStatus: epic.status ?? "review",
          });
        }

        // If the review verdict indicates work is not done, revert epic and
        // user stories back to in_progress. Channels in priority order: the
        // reviewer's persisted submit_findings verdict, else the prose scan of
        // its final message (lib/pipeline/findings.ts owns the priority; a
        // reviewer on a provider without MCP only ever produces the prose one).
        // Prose fallback of submit_findings.prior_findings: [RC:id] FIXED
        // lines in the report resolve the prior findings they name.
        if (!askedQuestion) {
          resolvePriorFindingsFromProse({ epicId, sessionOutput: output });
        }

        const decision = askedQuestion
          ? null
          : resolveReviewVerdict({
              epicId,
              reviewSessionId: sid,
              sessionOutput: output,
            });

        if (result?.success) {
          emitSessionCompleted(projectId, epicId, sid);
        } else {
          emitSessionFailed(projectId, epicId, sid, result?.error || "Review failed");
        }

        if (decision?.negative) {
          const currentEpic = db
            .select()
            .from(epics)
            .where(eq(epics.id, epicId))
            .get();

          if (
            currentEpic &&
            (currentEpic.status === "done" ||
              currentEpic.status === "review" ||
              currentEpic.status === "to_merge")
          ) {
            transitionReviewRejected({
              projectId,
              epicId,
              scope: "epic",
              reason: `Review verdict: changes requested (${lbl})`,
              sessionId: sid,
              verdictSource: decision.source,
            });
          }
        } else if (decision && !decision.unverifiable && result?.success) {
          // Review passed: promote to the merge boundary — unless the session
          // filed an open blocking finding in its window while its verdict
          // came from prose (resolveReviewVerdict ignores findings on that
          // path); promoting then would show To Merge with an open critical.
          const findingsWindow = readSessionFindingsWindow(sid);
          const blockingInWindow = findingsWindow
            ? collectBlockingFindings(epicId, findingsWindow)
            : [];
          if (blockingInWindow.length === 0) {
            // transitionReviewPassed itself no-ops (with a decision line)
            // when the ticket already left review — e.g. a concurrent move
            // while the reviewer ran.
            try {
              transitionReviewPassed({
                projectId,
                epicId,
                scope: "epic",
                reason: `Review verdict: passed (${lbl})`,
                sessionId: sid,
                verdictSource:
                  decision.source === "structured" ? "structured" : "prose",
              });
            } catch (err) {
              console.warn(
                "[review] review passed but to_merge promotion was refused:",
                (err as Error).message
              );
            }
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
