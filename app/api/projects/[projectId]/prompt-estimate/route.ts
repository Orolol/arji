import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loadPromptComments } from "@/lib/claude/prompt-comments";
import {
  epics,
  userStories,
  reviewComments,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getEpicOr404,
  getProjectOr404,
  getStoryOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import {
  buildBuildPrompt,
  buildEpicReviewPrompt,
  buildGradingPrompt,
  buildReviewPrompt,
  buildTicketBuildPrompt,
  type ReviewType,
} from "@/lib/claude/prompt-builder";
import { isVisualProofEnabled } from "@/lib/claude/visual-proof";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { REVIEW_TYPE_TO_AGENT_TYPE } from "@/lib/agent-config/constants";
import {
  enrichPromptWithDocumentMentions,
  userAuthoredTexts,
} from "@/lib/documents/mentions";
import {
  estimatePromptTokens,
  findLargestContextSection,
} from "@/lib/tokens/estimator";
import {
  checkPromptTokenBudget,
  resolvePromptTokenBudget,
} from "@/lib/tokens/budget";

type Params = { params: Promise<{ projectId: string }> };

interface EstimateRequestInput {
  targetType?: "epic" | "story";
  epicId?: string | null;
  storyId?: string | null;
  dispatchType?: "build" | "review" | "grading";
  reviewTypes?: string[] | string | null;
  comment?: string | null;
  namedAgentId?: string | null;
  pipeline?: boolean;
}

const VALID_REVIEW_TYPES: ReviewType[] = [
  "security",
  "code_review",
  "compliance",
  "feature_review",
];

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const searchParams = request.nextUrl.searchParams;

  const reviewTypesParam = searchParams.get("reviewTypes");
  const reviewTypes = reviewTypesParam
    ? reviewTypesParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const input: EstimateRequestInput = {
    targetType: (searchParams.get("targetType") as "epic" | "story") || undefined,
    epicId: searchParams.get("epicId") || null,
    storyId: searchParams.get("storyId") || null,
    dispatchType: (searchParams.get("dispatchType") as "build" | "review" | "grading") || "build",
    reviewTypes,
    comment: searchParams.get("comment") || null,
    namedAgentId: searchParams.get("namedAgentId") || null,
    pipeline: searchParams.get("pipeline") === "true",
  };

  return handleEstimate(projectId, input);
}

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as EstimateRequestInput;
  return handleEstimate(projectId, body);
}

async function handleEstimate(projectId: string, input: EstimateRequestInput) {
  const foundProject = getProjectOr404(projectId);
  if (isErrorResponse(foundProject)) return foundProject;
  const { project } = foundProject;

  const dispatchType = input.dispatchType || "build";
  const storyId = input.storyId || null;
  let epicId = input.epicId || null;

  let story = null;
  if (storyId) {
    const foundStory = getStoryOr404(projectId, storyId);
    if (isErrorResponse(foundStory)) return foundStory;
    story = foundStory.story;
    if (!epicId) epicId = story.epicId;
  }

  if (!epicId) {
    return NextResponse.json(
      { error: "epicId or storyId is required for prompt estimation" },
      { status: 400 }
    );
  }

  const foundEpic = getEpicOr404(projectId, epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;
  const { epic } = foundEpic;

  let prompt = "";

  if (dispatchType === "build") {
    if (story) {
      const promptComments = loadPromptComments({ userStoryId: story.id });
      const virtualComments = input.comment?.trim()
        ? [
            ...promptComments,
            {
              author: "user" as const,
              content: input.comment.trim(),
              createdAt: new Date().toISOString(),
            },
          ]
        : promptComments;

      const ticketBuildSystemPrompt = await resolveAgentPrompt(
        "ticket_build",
        projectId
      );

      prompt = buildTicketBuildPrompt(
        project,
        [],
        epic,
        story,
        virtualComments,
        ticketBuildSystemPrompt,
        { visualProofEnabled: isVisualProofEnabled() }
      );

      const mentionEnrichment = enrichPromptWithDocumentMentions({
        projectId,
        prompt,
        textSources: [input.comment, ...userAuthoredTexts(virtualComments)],
      });
      prompt = mentionEnrichment.prompt;
    } else {
      const us = db
        .select()
        .from(userStories)
        .where(eq(userStories.epicId, epicId))
        .all();

      const promptComments = loadPromptComments({ epicId });
      const virtualComments = input.comment?.trim()
        ? [
            ...promptComments,
            {
              author: "user" as const,
              content: input.comment.trim(),
              createdAt: new Date().toISOString(),
            },
          ]
        : promptComments;

      const openReviewComments = db
        .select()
        .from(reviewComments)
        .where(
          and(
            eq(reviewComments.epicId, epicId),
            eq(reviewComments.status, "open")
          )
        )
        .orderBy(reviewComments.createdAt)
        .all();

      let reviewContext = "";
      if (openReviewComments.length > 0) {
        const byFile: Record<string, typeof openReviewComments> = {};
        for (const rc of openReviewComments) {
          if (!byFile[rc.filePath]) byFile[rc.filePath] = [];
          byFile[rc.filePath].push(rc);
        }
        const parts = [
          "## Code Review Feedback\n\nThe following review comments were left on your previous changes. Address each one:\n",
        ];
        for (const [filePath, fileComments] of Object.entries(byFile)) {
          parts.push(`### ${filePath}`);
          for (const rc of fileComments) {
            parts.push(`- **Line ${rc.lineNumber}**: ${rc.body}`);
          }
          parts.push("");
        }
        reviewContext = parts.join("\n");
      }

      const buildSystemPrompt = await resolveAgentPrompt("build", projectId);

      prompt = buildBuildPrompt(
        project,
        [],
        epic,
        us,
        buildSystemPrompt,
        virtualComments,
        { visualProofEnabled: isVisualProofEnabled() }
      );

      if (reviewContext) {
        prompt = prompt + "\n\n" + reviewContext;
      }

      const mentionEnrichment = enrichPromptWithDocumentMentions({
        projectId,
        prompt,
        textSources: [input.comment, ...userAuthoredTexts(virtualComments)],
      });
      prompt = mentionEnrichment.prompt;
    }
  } else if (dispatchType === "review") {
    const rawReviewTypes = Array.isArray(input.reviewTypes)
      ? input.reviewTypes
      : typeof input.reviewTypes === "string"
        ? input.reviewTypes.split(",").map((s) => s.trim())
        : ["feature_review"];

    const selectedTypes: ReviewType[] = rawReviewTypes.filter((t): t is ReviewType =>
      VALID_REVIEW_TYPES.includes(t as ReviewType)
    );
    const primaryReviewType: ReviewType = selectedTypes[0] || "feature_review";

    if (story) {
      const promptComments = loadPromptComments({ userStoryId: story.id });
      const reviewSystemPrompt = await resolveAgentPrompt(
        REVIEW_TYPE_TO_AGENT_TYPE[primaryReviewType],
        projectId
      );

      prompt = buildReviewPrompt(
        project,
        [],
        epic,
        story,
        primaryReviewType,
        reviewSystemPrompt
      );

      const mentionEnrichment = enrichPromptWithDocumentMentions({
        projectId,
        prompt,
        textSources: userAuthoredTexts(promptComments),
      });
      prompt = mentionEnrichment.prompt;
    } else {
      const us = db
        .select()
        .from(userStories)
        .where(eq(userStories.epicId, epicId))
        .all();

      const promptComments = loadPromptComments({ epicId });
      const reviewSystemPrompt = await resolveAgentPrompt(
        REVIEW_TYPE_TO_AGENT_TYPE[primaryReviewType],
        projectId
      );

      prompt = buildEpicReviewPrompt(
        project,
        [],
        epic,
        us,
        primaryReviewType,
        reviewSystemPrompt,
        promptComments
      );

      const mentionEnrichment = enrichPromptWithDocumentMentions({
        projectId,
        prompt,
        textSources: userAuthoredTexts(promptComments),
      });
      prompt = mentionEnrichment.prompt;
    }
  } else if (dispatchType === "grading") {
    const gradingSystemPrompt = await resolveAgentPrompt("grading", projectId);
    if (story) {
      prompt = buildGradingPrompt(
        project,
        [],
        epic,
        {
          id: story.id,
          title: story.title,
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria,
        },
        gradingSystemPrompt
      );
    } else {
      const us = db
        .select()
        .from(userStories)
        .where(eq(userStories.epicId, epicId))
        .all();

      prompt = buildGradingPrompt(
        project,
        [],
        epic,
        us.map((s) => ({
          id: s.id,
          title: s.title,
          description: s.description,
          acceptanceCriteria: s.acceptanceCriteria,
        })),
        gradingSystemPrompt
      );
    }
  }

  const estimated = estimatePromptTokens(prompt);
  const budget = resolvePromptTokenBudget(projectId);
  const budgetCheck = checkPromptTokenBudget(
    estimated.total,
    estimated.breakdown,
    budget
  );

  return NextResponse.json({
    data: {
      total: estimated.total,
      breakdown: estimated.breakdown,
      budget: budgetCheck.budget,
      budgetExceeded: budgetCheck.budgetExceeded,
      largestSection: budgetCheck.largestSection,
    },
  });
}
