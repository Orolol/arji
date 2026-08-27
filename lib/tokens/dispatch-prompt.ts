/**
 * Shared dispatch prompt assembly module.
 *
 * Single source of truth for constructing build, review, and grading prompts
 * used by both the actual dispatch routes and the estimation preview API.
 *
 * Story 1 AC: "L'estimation est calculée sur le prompt réellement assemblé
 * (même code path que le prompt envoyé à l'agent)."
 */

import { db } from "@/lib/db";
import { userStories, reviewComments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { loadPromptComments } from "@/lib/claude/prompt-comments";
import {
  buildBuildPrompt,
  buildEpicReviewPrompt,
  buildGradingPrompt,
  buildReviewPrompt,
  buildTicketBuildPrompt,
  userStoriesSection,
  commentHistorySection,
  type PromptComment,
  type PromptDocument,
  type PromptEpic,
  type PromptGradingStory,
  type PromptProject,
  type PromptUserStory,
  type ReviewType,
  BUG_RED_GREEN_SECTION,
  VISUAL_PROOF_SECTION,
} from "@/lib/claude/prompt-builder";
import {
  projectHeader,
  specSection,
  memorySection,
  documentsSection,
  systemSection,
  ticketImagesSection,
} from "@/lib/claude/prompt-sections";
import { isVisualProofEnabled } from "@/lib/claude/visual-proof";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { REVIEW_TYPE_TO_AGENT_TYPE } from "@/lib/agent-config/constants";
import {
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

export interface AssembleEpicBuildPromptOptions {
  projectId: string;
  epicId: string;
  project: PromptProject;
  epic: PromptEpic;
  comment?: string | null;
  virtualComments?: PromptComment[];
  visualProofEnabled?: boolean;
}

export async function assembleEpicBuildPrompt(
  options: AssembleEpicBuildPromptOptions
): Promise<AssembledDispatchPrompt> {
  const { projectId, epicId, project, epic, comment } = options;

  const us = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  const loadedComments = loadPromptComments({ epicId });
  const comments = options.virtualComments ?? (comment?.trim()
    ? [
        ...loadedComments,
        {
          author: "user" as const,
          content: comment.trim(),
          createdAt: new Date().toISOString(),
        },
      ]
    : loadedComments);

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
  const visualProofEnabled =
    options.visualProofEnabled ?? isVisualProofEnabled();

  let prompt = buildBuildPrompt(
    project,
    [],
    epic,
    us,
    buildSystemPrompt,
    comments,
    { visualProofEnabled }
  );

  if (reviewContext) {
    prompt = prompt + "\n\n" + reviewContext;
  }

  const mentionEnrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: [comment, ...userAuthoredTexts(comments)],
  });
  const enrichedPrompt = mentionEnrichment.prompt;

  // Measure sections by construction
  const systemText = systemSection(buildSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## Epic to Implement\n\n### ${epic.title}\n\n${epic.description?.trim() ?? ""}\n\n${ticketImagesSection(epic, { headingLevel: 3 })}\n\n${userStoriesSection(us)}`;
  const commentsText = commentHistorySection(comments);
  const findingsText = [
    reviewContext,
    epic.type === "bug" ? BUG_RED_GREEN_SECTION : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const documentsText = documentsSection(
    mentionEnrichment.resolvedDocuments.map((d) => ({
      name: d.originalFilename,
      contentMd: d.markdownContent ?? "",
    }))
  );
  const otherText = [
    `## Instructions\n\nImplement this epic following the specification above...`,
    visualProofEnabled ? VISUAL_PROOF_SECTION : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const sections: PromptSectionTexts = {
    system: systemText,
    spec: specText,
    memory: memoryText,
    ticket: ticketText,
    comments: commentsText,
    findings: findingsText,
    documents: documentsText,
    other: otherText,
  };

  const tokens = estimatePromptTokensBySections(sections, enrichedPrompt);

  return {
    prompt: enrichedPrompt,
    sections,
    tokens,
    missingDocuments: mentionEnrichment.missing,
  };
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
  visualProofEnabled?: boolean;
}

export async function assembleStoryBuildPrompt(
  options: AssembleStoryBuildPromptOptions
): Promise<AssembledDispatchPrompt> {
  const { projectId, epic, story, project, comment, storyId } = options;

  const loadedComments = loadPromptComments({ userStoryId: storyId });
  const comments = options.virtualComments ?? (comment?.trim()
    ? [
        ...loadedComments,
        {
          author: "user" as const,
          content: comment.trim(),
          createdAt: new Date().toISOString(),
        },
      ]
    : loadedComments);

  const ticketBuildSystemPrompt = await resolveAgentPrompt(
    "ticket_build",
    projectId
  );
  const visualProofEnabled =
    options.visualProofEnabled ?? isVisualProofEnabled();

  const prompt = buildTicketBuildPrompt(
    project,
    [],
    epic,
    story,
    comments,
    ticketBuildSystemPrompt,
    { visualProofEnabled }
  );

  const mentionEnrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: [comment, ...userAuthoredTexts(comments)],
  });
  const enrichedPrompt = mentionEnrichment.prompt;

  // Measure sections by construction
  const systemText = systemSection(ticketBuildSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## Epic Context\n\n### ${epic.title}\n\n${epic.description?.trim() ?? ""}\n\n${ticketImagesSection(epic, { headingLevel: 3 })}\n\n## Ticket to Implement\n\n### ${story.title}\n\n${story.description?.trim() ?? ""}\n\n**Acceptance Criteria:**\n${story.acceptanceCriteria?.trim() ?? ""}`;
  const commentsText = commentHistorySection(comments);
  const findingsText = epic.type === "bug" ? BUG_RED_GREEN_SECTION : "";
  const documentsText = documentsSection(
    mentionEnrichment.resolvedDocuments.map((d) => ({
      name: d.originalFilename,
      contentMd: d.markdownContent ?? "",
    }))
  );
  const otherText = [
    `## Instructions\n\nImplement this ticket following the specification and acceptance criteria above...`,
    visualProofEnabled ? VISUAL_PROOF_SECTION : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const sections: PromptSectionTexts = {
    system: systemText,
    spec: specText,
    memory: memoryText,
    ticket: ticketText,
    comments: commentsText,
    findings: findingsText,
    documents: documentsText,
    other: otherText,
  };

  const tokens = estimatePromptTokensBySections(sections, enrichedPrompt);

  return {
    prompt: enrichedPrompt,
    sections,
    tokens,
    missingDocuments: mentionEnrichment.missing,
  };
}

export interface AssembleEpicReviewPromptOptions {
  projectId: string;
  epicId: string;
  project: PromptProject;
  epic: PromptEpic;
  reviewType: ReviewType;
  comments?: PromptComment[];
}

export async function assembleEpicReviewPrompt(
  options: AssembleEpicReviewPromptOptions
): Promise<AssembledDispatchPrompt> {
  const { projectId, epicId, project, epic, reviewType } = options;

  const us = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  const promptComments = options.comments ?? loadPromptComments({ epicId });
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

  const mentionEnrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: userAuthoredTexts(promptComments),
  });
  const enrichedPrompt = mentionEnrichment.prompt;

  // Measure sections by construction
  const isBug = epic.type === "bug";
  const systemText = systemSection(reviewSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## ${isBug ? "Bug Under Review" : "Epic Under Review"}\n\n### ${epic.title}\n\n${epic.description?.trim() ?? ""}\n\n${ticketImagesSection(epic, { headingLevel: 3 })}\n\n${!isBug ? userStoriesSection(us, { checkmark: false }) : ""}`;
  const commentsText = commentHistorySection(promptComments);
  const findingsText = `## ${reviewType} Review Checklist...`;
  const documentsText = documentsSection(
    mentionEnrichment.resolvedDocuments.map((d) => ({
      name: d.originalFilename,
      contentMd: d.markdownContent ?? "",
    }))
  );
  const otherText = `## Instructions\n\nYou are performing a review...`;

  const sections: PromptSectionTexts = {
    system: systemText,
    spec: specText,
    memory: memoryText,
    ticket: ticketText,
    comments: commentsText,
    findings: findingsText,
    documents: documentsText,
    other: otherText,
  };

  const tokens = estimatePromptTokensBySections(sections, enrichedPrompt);

  return {
    prompt: enrichedPrompt,
    sections,
    tokens,
    missingDocuments: mentionEnrichment.missing,
  };
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
}

export async function assembleStoryReviewPrompt(
  options: AssembleStoryReviewPromptOptions
): Promise<AssembledDispatchPrompt> {
  const { projectId, storyId, project, epic, story, reviewType } = options;

  const promptComments = options.comments ?? loadPromptComments({ userStoryId: storyId });
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

  const mentionEnrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: userAuthoredTexts(promptComments),
  });
  const enrichedPrompt = mentionEnrichment.prompt;

  // Measure sections by construction
  const systemText = systemSection(reviewSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## Epic Context\n\n### ${epic.title}\n\n${epic.description?.trim() ?? ""}\n\n${ticketImagesSection(epic, { headingLevel: 3 })}\n\n## Ticket Under Review\n\n### ${story.title}\n\n${story.description?.trim() ?? ""}\n\n**Acceptance Criteria:**\n${story.acceptanceCriteria?.trim() ?? ""}`;
  const commentsText = commentHistorySection(promptComments);
  const findingsText = `## ${reviewType} Review Checklist...`;
  const documentsText = documentsSection(
    mentionEnrichment.resolvedDocuments.map((d) => ({
      name: d.originalFilename,
      contentMd: d.markdownContent ?? "",
    }))
  );
  const otherText = `## Instructions\n\nYou are performing a review...`;

  const sections: PromptSectionTexts = {
    system: systemText,
    spec: specText,
    memory: memoryText,
    ticket: ticketText,
    comments: commentsText,
    findings: findingsText,
    documents: documentsText,
    other: otherText,
  };

  const tokens = estimatePromptTokensBySections(sections, enrichedPrompt);

  return {
    prompt: enrichedPrompt,
    sections,
    tokens,
    missingDocuments: mentionEnrichment.missing,
  };
}

export interface AssembleGradingPromptOptions {
  projectId: string;
  epicId: string;
  project: PromptProject;
  epic: PromptEpic;
  stories: PromptGradingStory[];
}

export async function assembleGradingPrompt(
  options: AssembleGradingPromptOptions
): Promise<AssembledDispatchPrompt> {
  const { projectId, project, epic, stories } = options;

  const gradingSystemPrompt = await resolveAgentPrompt("grading", projectId);

  const prompt = buildGradingPrompt(
    project,
    [],
    epic,
    stories,
    gradingSystemPrompt
  );

  const mentionEnrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: stories.map((s) => s.acceptanceCriteria ?? ""),
  });
  const enrichedPrompt = mentionEnrichment.prompt;

  const systemText = systemSection(gradingSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## Epic to Grade\n\n### ${epic.title}\n\n${epic.description?.trim() ?? ""}`;
  const findingsText = `## Acceptance-Criteria Rubric\n\n${stories.map((s) => `### ${s.title}\n- **storyId:** \`${s.id}\`\n**Acceptance criteria:**\n${s.acceptanceCriteria ?? ""}`).join("\n\n")}`;
  const documentsText = documentsSection(
    mentionEnrichment.resolvedDocuments.map((d) => ({
      name: d.originalFilename,
      contentMd: d.markdownContent ?? "",
    }))
  );
  const otherText = `## Role Boundary\n\nYou are an acceptance-criteria grader...`;

  const sections: PromptSectionTexts = {
    system: systemText,
    spec: specText,
    memory: memoryText,
    ticket: ticketText,
    comments: "",
    findings: findingsText,
    documents: documentsText,
    other: otherText,
  };

  const tokens = estimatePromptTokensBySections(sections, enrichedPrompt);

  return {
    prompt: enrichedPrompt,
    sections,
    tokens,
    missingDocuments: mentionEnrichment.missing,
  };
}
