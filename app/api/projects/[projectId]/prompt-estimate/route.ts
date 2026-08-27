import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { userStories } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  getEpicOr404,
  getProjectOr404,
  getStoryOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import type { ReviewType } from "@/lib/claude/prompt-builder";
import {
  assembleEpicBuildPrompt,
  assembleStoryBuildPrompt,
  assembleEpicReviewPrompt,
  assembleStoryReviewPrompt,
  assembleGradingPrompt,
  type EstimatedPromptTokens,
  type PromptTokenBreakdown,
} from "@/lib/tokens";
import {
  checkPromptTokenBudget,
  resolvePromptTokenBudget,
} from "@/lib/tokens/budget";
import { gradableStories } from "@/lib/grading/dispatch";
import { loadPromptComments } from "@/lib/claude/prompt-comments";

type Params = { params: Promise<{ projectId: string }> };

interface EstimateRequestInput {
  epicId?: string | null;
  storyId?: string | null;
  dispatchType?: "build" | "review" | "grading";
  reviewTypes?: string[] | string | null;
  comment?: string | null;
}

const VALID_REVIEW_TYPES: ReviewType[] = [
  "security",
  "code_review",
  "compliance",
  "feature_review",
];

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

  let estimated: EstimatedPromptTokens;
  let sessionsCount = 1;
  let perSessionEstimates:
    | Array<{ reviewType: ReviewType; tokens: number; breakdown: PromptTokenBreakdown }>
    | undefined;

  if (dispatchType === "build") {
    if (story) {
      const assembled = await assembleStoryBuildPrompt({
        projectId,
        epicId,
        storyId: story.id,
        project,
        epic,
        story,
        comment: input.comment,
      });
      estimated = assembled.tokens;
    } else {
      const assembled = await assembleEpicBuildPrompt({
        projectId,
        epicId,
        project,
        epic,
        comment: input.comment,
      });
      estimated = assembled.tokens;
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
    const typesToEstimate = selectedTypes.length > 0 ? selectedTypes : ["feature_review" as ReviewType];
    sessionsCount = typesToEstimate.length;
    const sharedComments = story
      ? loadPromptComments({ userStoryId: story.id })
      : loadPromptComments({ epicId });
    const sharedStories = story
      ? undefined
      : db
          .select()
          .from(userStories)
          .where(eq(userStories.epicId, epicId))
          .orderBy(userStories.position)
          .all();

    const sessionList: Array<{
      reviewType: ReviewType;
      tokens: number;
      breakdown: PromptTokenBreakdown;
    }> = [];

    const aggregateBreakdown: PromptTokenBreakdown = {
      spec: 0,
      memory: 0,
      ticket: 0,
      comments: 0,
      findings: 0,
      documents: 0,
      system: 0,
      other: 0,
    };
    let aggregateTotal = 0;

    for (const rt of typesToEstimate) {
      let tokens: EstimatedPromptTokens;
      if (story) {
        const assembled = await assembleStoryReviewPrompt({
          projectId,
          epicId,
          storyId: story.id,
          project,
          epic,
          story,
          reviewType: rt,
          comments: sharedComments,
        });
        tokens = assembled.tokens;
      } else {
        const assembled = await assembleEpicReviewPrompt({
          projectId,
          epicId,
          project,
          epic,
          reviewType: rt,
          stories: sharedStories,
          comments: sharedComments,
        });
        tokens = assembled.tokens;
      }

      sessionList.push({
        reviewType: rt,
        tokens: tokens.total,
        breakdown: tokens.breakdown,
      });

      aggregateTotal += tokens.total;
      aggregateBreakdown.spec += tokens.breakdown.spec;
      aggregateBreakdown.memory += tokens.breakdown.memory;
      aggregateBreakdown.ticket += tokens.breakdown.ticket;
      aggregateBreakdown.comments += tokens.breakdown.comments;
      aggregateBreakdown.findings += tokens.breakdown.findings;
      aggregateBreakdown.documents += tokens.breakdown.documents;
      aggregateBreakdown.system += tokens.breakdown.system;
      aggregateBreakdown.other += tokens.breakdown.other;
    }

    estimated = {
      total: aggregateTotal,
      breakdown: aggregateBreakdown,
    };
    perSessionEstimates = sessionList;
  } else if (dispatchType === "grading") {
    const scopedStories = story
      ? [story]
      : db
        .select()
        .from(userStories)
        .where(eq(userStories.epicId, epicId))
        .orderBy(userStories.position)
        .all();
    const gradingStories = gradableStories(scopedStories).map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria,
      }));

    if (gradingStories.length === 0) {
      return NextResponse.json({
        data: {
          skipped: true,
          skipReason: "No non-empty acceptance criteria to grade",
        },
      });
    }

    const assembled = await assembleGradingPrompt({
      projectId,
      epicId,
      project,
      epic,
      stories: gradingStories,
    });
    estimated = assembled.tokens;
  } else {
    return NextResponse.json(
      { error: `Invalid dispatchType: ${dispatchType}` },
      { status: 400 }
    );
  }

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
      sessionsCount,
      perSessionEstimates,
      budget: budgetCheck.budget,
      budgetExceeded: budgetCheck.budgetExceeded,
      largestSection: budgetCheck.largestSection,
    },
  });
}
