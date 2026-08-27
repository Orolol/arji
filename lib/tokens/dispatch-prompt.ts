/** Shared build/review/grading prompt assembly and exact section capture. */

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { reviewComments, userStories } from "@/lib/db/schema";
import { loadPromptComments } from "@/lib/claude/prompt-comments";
import {
  buildBuildPrompt,
  buildCiFixPrompt,
  buildEpicReviewPrompt,
  buildGradingPrompt,
  buildReviewPrompt,
  buildTicketBuildPrompt,
  type PromptComment,
  type PromptEpic,
  type PromptGradingStory,
  type PromptProject,
  type PromptUserStory,
  type ReviewType,
} from "@/lib/claude/prompt-builder";
import type {
  PromptContextSectionKey,
  PromptSectionCollector,
} from "@/lib/claude/prompt-sections";
import type { CiAutofixPayload } from "@/lib/routines/ci-autofix-shared";
import { isVisualProofEnabled } from "@/lib/claude/visual-proof";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { REVIEW_TYPE_TO_AGENT_TYPE } from "@/lib/agent-config/constants";
import {
  buildMentionContextBlock,
  enrichPromptWithDocumentMentions,
  userAuthoredTexts,
} from "@/lib/documents/mentions";
import {
  estimatePromptTokensBySections,
  type EstimatedPromptTokens,
  type PromptSectionTexts,
} from "./estimator";

export interface AssembledDispatchPrompt {
  prompt: string;
  sections: PromptSectionTexts;
  tokens: EstimatedPromptTokens;
  missingDocuments?: string[];
}

export interface AdditionalPromptSection {
  key: PromptContextSectionKey;
  text: string;
}

const SECTION_KEYS: PromptContextSectionKey[] = [
  "spec",
  "memory",
  "ticket",
  "comments",
  "findings",
  "documents",
  "system",
  "other",
];

export function createPromptSectionCapture(): {
  collect: PromptSectionCollector;
  append: PromptSectionCollector;
  toSections: () => PromptSectionTexts;
} {
  const fragments = Object.fromEntries(
    SECTION_KEYS.map((key) => [key, [] as string[]]),
  ) as Record<PromptContextSectionKey, string[]>;
  const append: PromptSectionCollector = (key, text) => {
    if (text) fragments[key].push(text);
  };
  return {
    collect: append,
    append,
    toSections: () =>
      Object.fromEntries(
        SECTION_KEYS.map((key) => [key, fragments[key].join("\n")]),
      ) as PromptSectionTexts,
  };
}

export function finalizeCapturedPrompt(
  prompt: string,
  capture: ReturnType<typeof createPromptSectionCapture>,
  missingDocuments?: string[],
): AssembledDispatchPrompt {
  const sections = capture.toSections();
  return {
    prompt,
    sections,
    tokens: estimatePromptTokensBySections(sections, prompt),
    missingDocuments,
  };
}

/** Append pipeline-only evidence while preserving exact section attribution. */
export function appendPromptSections(
  assembled: AssembledDispatchPrompt,
  additions: AdditionalPromptSection[],
): AssembledDispatchPrompt {
  const usable = additions.filter((item) => item.text);
  if (usable.length === 0) return assembled;

  const sections: PromptSectionTexts = { ...assembled.sections };
  let prompt = assembled.prompt;
  for (const { key, text } of usable) {
    prompt += `\n\n${text}`;
    sections[key] = [sections[key], text].filter(Boolean).join("\n");
  }
  return {
    ...assembled,
    prompt,
    sections,
    tokens: estimatePromptTokensBySections(sections, prompt),
  };
}

function buildReviewFeedback(
  comments: Array<{ filePath: string; lineNumber: number; body: string }>,
): string {
  if (comments.length === 0) return "";
  const byFile = new Map<string, typeof comments>();
  for (const comment of comments) {
    const group = byFile.get(comment.filePath) ?? [];
    group.push(comment);
    byFile.set(comment.filePath, group);
  }
  const parts = [
    "## Code Review Feedback\n\nThe following review comments were left on your previous changes. Address each one:\n",
  ];
  for (const [filePath, fileComments] of byFile) {
    parts.push(`### ${filePath}`);
    for (const comment of fileComments) {
      parts.push(`- **Line ${comment.lineNumber}**: ${comment.body}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

export interface AssembleEpicBuildPromptOptions {
  projectId: string;
  epicId: string;
  project: PromptProject;
  epic: PromptEpic;
  comment?: string | null;
  virtualComments?: PromptComment[];
  commentAlreadyPersisted?: boolean;
  stories?: PromptUserStory[];
  systemPrompt?: string | null;
  visualProofEnabled?: boolean;
  includeOpenReviewFeedback?: boolean;
  ciAutofix?: CiAutofixPayload | null;
  worktreeHead?: string | null;
}

export async function assembleEpicBuildPrompt(
  options: AssembleEpicBuildPromptOptions,
): Promise<AssembledDispatchPrompt> {
  const { projectId, epicId, project, epic, comment, ciAutofix, worktreeHead } =
    options;
  const systemPrompt =
    options.systemPrompt === undefined
      ? await resolveAgentPrompt("build", projectId)
      : options.systemPrompt;
  const capture = createPromptSectionCapture();

  if (ciAutofix) {
    let prompt = buildCiFixPrompt(
      project,
      epic,
      ciAutofix,
      systemPrompt,
      capture.collect,
    );
    if (worktreeHead && worktreeHead !== ciAutofix.headSha) {
      const aheadNotice =
        "\n\n## Important: this branch is ahead of the PR head\n\n" +
        `The worktree tip (${worktreeHead.slice(0, 12)}) differs from the ` +
        `CI-failing PR head (${ciAutofix.headSha.slice(0, 12)}). The extra ` +
        "local commits are intentional; fix the CI failure on top of them " +
        "and do not revert or rewrite them.\n";
      prompt += aheadNotice;
      capture.append("other", aheadNotice);
    }
    const comments = options.virtualComments ?? loadPromptComments({ epicId });
    const enrichment = enrichPromptWithDocumentMentions({
      projectId,
      prompt,
      textSources: [comment, ...userAuthoredTexts(comments)],
    });
    capture.append(
      "documents",
      buildMentionContextBlock(enrichment.resolvedDocuments),
    );
    return finalizeCapturedPrompt(enrichment.prompt, capture, enrichment.missing);
  }

  const stories =
    options.stories ??
    db
      .select()
      .from(userStories)
      .where(eq(userStories.epicId, epicId))
      .orderBy(userStories.position)
      .all();
  const loadedComments =
    options.virtualComments ?? loadPromptComments({ epicId });
  const comments =
    comment?.trim() && !options.commentAlreadyPersisted && !options.virtualComments
      ? [
          ...loadedComments,
          {
            author: "user" as const,
            content: comment.trim(),
            createdAt: new Date().toISOString(),
          },
        ]
      : loadedComments;

  let prompt = buildBuildPrompt(
    project,
    [],
    epic,
    stories,
    systemPrompt,
    comments,
    {
      visualProofEnabled:
        options.visualProofEnabled ?? isVisualProofEnabled(),
      sectionCollector: capture.collect,
    },
  );

  if (options.includeOpenReviewFeedback !== false) {
    const feedback = buildReviewFeedback(
      db
        .select()
        .from(reviewComments)
        .where(
          and(
            eq(reviewComments.epicId, epicId),
            eq(reviewComments.status, "open"),
          ),
        )
        .orderBy(reviewComments.createdAt)
        .all(),
    );
    if (feedback) {
      prompt += `\n\n${feedback}`;
      capture.append("findings", feedback);
    }
  }

  const enrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: [comment, ...userAuthoredTexts(comments)],
  });
  capture.append(
    "documents",
    buildMentionContextBlock(enrichment.resolvedDocuments),
  );
  return finalizeCapturedPrompt(enrichment.prompt, capture, enrichment.missing);
}

export interface AssembleStoryBuildPromptOptions {
  projectId: string;
  epicId: string;
  storyId: string;
  project: PromptProject;
  epic: PromptEpic;
  story: PromptUserStory;
  comment?: string | null;
  virtualComments?: PromptComment[];
  commentAlreadyPersisted?: boolean;
  systemPrompt?: string | null;
  visualProofEnabled?: boolean;
}

export async function assembleStoryBuildPrompt(
  options: AssembleStoryBuildPromptOptions,
): Promise<AssembledDispatchPrompt> {
  const { projectId, storyId, project, epic, story, comment } = options;
  const loadedComments =
    options.virtualComments ?? loadPromptComments({ userStoryId: storyId });
  const comments =
    comment?.trim() && !options.commentAlreadyPersisted && !options.virtualComments
      ? [
          ...loadedComments,
          {
            author: "user" as const,
            content: comment.trim(),
            createdAt: new Date().toISOString(),
          },
        ]
      : loadedComments;
  const systemPrompt =
    options.systemPrompt === undefined
      ? await resolveAgentPrompt("ticket_build", projectId)
      : options.systemPrompt;
  const capture = createPromptSectionCapture();
  const prompt = buildTicketBuildPrompt(
    project,
    [],
    epic,
    story,
    comments,
    systemPrompt,
    {
      visualProofEnabled:
        options.visualProofEnabled ?? isVisualProofEnabled(),
      sectionCollector: capture.collect,
    },
  );
  const enrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: [comment, ...userAuthoredTexts(comments)],
  });
  capture.append(
    "documents",
    buildMentionContextBlock(enrichment.resolvedDocuments),
  );
  return finalizeCapturedPrompt(enrichment.prompt, capture, enrichment.missing);
}

export interface AssembleEpicReviewPromptOptions {
  projectId: string;
  epicId: string;
  project: PromptProject;
  epic: PromptEpic;
  reviewType: ReviewType;
  stories?: PromptUserStory[];
  comments?: PromptComment[];
  systemPrompt?: string | null;
}

export async function assembleEpicReviewPrompt(
  options: AssembleEpicReviewPromptOptions,
): Promise<AssembledDispatchPrompt> {
  const { projectId, epicId, project, epic, reviewType } = options;
  const stories =
    options.stories ??
    db
      .select()
      .from(userStories)
      .where(eq(userStories.epicId, epicId))
      .orderBy(userStories.position)
      .all();
  const comments = options.comments ?? loadPromptComments({ epicId });
  const systemPrompt =
    options.systemPrompt === undefined
      ? await resolveAgentPrompt(
          REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
          projectId,
        )
      : options.systemPrompt;
  const capture = createPromptSectionCapture();
  const prompt = buildEpicReviewPrompt(
    project,
    [],
    epic,
    stories,
    reviewType,
    systemPrompt,
    comments,
    capture.collect,
  );
  const enrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: userAuthoredTexts(comments),
  });
  capture.append(
    "documents",
    buildMentionContextBlock(enrichment.resolvedDocuments),
  );
  return finalizeCapturedPrompt(enrichment.prompt, capture, enrichment.missing);
}

export interface AssembleStoryReviewPromptOptions {
  projectId: string;
  epicId: string;
  storyId: string;
  project: PromptProject;
  epic: PromptEpic;
  story: PromptUserStory;
  reviewType: ReviewType;
  comments?: PromptComment[];
  systemPrompt?: string | null;
}

export async function assembleStoryReviewPrompt(
  options: AssembleStoryReviewPromptOptions,
): Promise<AssembledDispatchPrompt> {
  const { projectId, storyId, project, epic, story, reviewType } = options;
  const comments =
    options.comments ?? loadPromptComments({ userStoryId: storyId });
  const systemPrompt =
    options.systemPrompt === undefined
      ? await resolveAgentPrompt(
          REVIEW_TYPE_TO_AGENT_TYPE[reviewType],
          projectId,
        )
      : options.systemPrompt;
  const capture = createPromptSectionCapture();
  const prompt = buildReviewPrompt(
    project,
    [],
    epic,
    story,
    reviewType,
    systemPrompt,
    capture.collect,
  );
  // Story-review prompts intentionally do not render Comment History. The
  // comments remain mention sources so existing @document behaviour is kept.
  const enrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: userAuthoredTexts(comments),
  });
  capture.append(
    "documents",
    buildMentionContextBlock(enrichment.resolvedDocuments),
  );
  return finalizeCapturedPrompt(enrichment.prompt, capture, enrichment.missing);
}

export interface AssembleGradingPromptOptions {
  projectId: string;
  epicId: string;
  project: PromptProject;
  epic: PromptEpic;
  stories: PromptGradingStory[];
  systemPrompt?: string | null;
}

export async function assembleGradingPrompt(
  options: AssembleGradingPromptOptions,
): Promise<AssembledDispatchPrompt> {
  const { projectId, project, epic, stories } = options;
  const systemPrompt =
    options.systemPrompt === undefined
      ? await resolveAgentPrompt("grading", projectId)
      : options.systemPrompt;
  const capture = createPromptSectionCapture();
  // Grading did not resolve document mentions before this feature. Keep that
  // prompt byte-for-byte behaviour: estimation must observe, not alter, it.
  const prompt = buildGradingPrompt(
    project,
    [],
    epic,
    stories,
    systemPrompt,
    capture.collect,
  );
  return finalizeCapturedPrompt(prompt, capture);
}
