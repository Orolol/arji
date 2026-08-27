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
import type { CiAutofixPayload } from "@/lib/routines/ci-autofix-shared";
import {
  projectHeader,
  specSection,
  memorySection,
  documentsSection,
  systemSection,
  ticketImagesSection,
  userStoriesSection,
  commentHistorySection,
  BUG_RED_GREEN_SECTION,
  VISUAL_PROOF_SECTION,
  REVIEW_CHECKLISTS,
  BUG_REVIEW_CHECKLIST,
  REVIEW_BOUNDARY_SECTION,
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
  ciAutofix?: CiAutofixPayload | null;
  worktreeHead?: string | null;
}
export async function assembleEpicBuildPrompt(
  options: AssembleEpicBuildPromptOptions
): Promise<AssembledDispatchPrompt> {
  const {
    projectId,
    epicId,
    project,
    epic,
    comment,
    ciAutofix,
    worktreeHead,
  } = options;

  const buildSystemPrompt = await resolveAgentPrompt("build", projectId);
  const visualProofEnabled =
    options.visualProofEnabled ?? isVisualProofEnabled();

  if (ciAutofix) {
    const prompt = buildCiFixPrompt(
      project,
      epic,
      ciAutofix,
      buildSystemPrompt
    );

    let finalPrompt = prompt;
    let aheadNotice = "";
    if (worktreeHead && worktreeHead !== ciAutofix.headSha) {
      aheadNotice =
        "\n\n## Important: this branch is ahead of the PR head\n\n" +
        `The worktree tip (${worktreeHead.slice(0, 12)}) differs from the ` +
        `CI-failing PR head (${ciAutofix.headSha.slice(0, 12)}). The extra ` +
        "local commits are intentional; fix the CI failure on top of them " +
        "and do not revert or rewrite them.\n";
      finalPrompt += aheadNotice;
    }
    const mentionEnrichment = enrichPromptWithDocumentMentions({
      projectId,
      prompt: finalPrompt,
      textSources: [comment],
    });

    const sections: PromptSectionTexts = {
      system: systemSection(buildSystemPrompt),
      spec: `${projectHeader(project.name)}\n${specSection(project.spec)}`,
      memory: memorySection(project.memory),
      ticket: `## Epic Context\n\n### ${epic.title}\n\n${epic.description?.trim() ?? ""}`,
      comments: "",
      findings: `## CI Failure Evidence\n\n${ciAutofix.failures.map((c) => `### ${c.name}\n\n${c.logTail ?? ""}`).join("\n\n")}`,
      documents: documentsSection(
        mentionEnrichment.resolvedDocuments.map((d) => ({
          name: d.originalFilename,
          contentMd: d.markdownContent ?? "",
        }))
      ),
      other: `## Instructions\n\nFix the CI failures described above...${aheadNotice}`,
    };

    const tokens = estimatePromptTokensBySections(
      sections,
      mentionEnrichment.prompt
    );

    return {
      prompt: mentionEnrichment.prompt,
      sections,
      tokens,
      missingDocuments: mentionEnrichment.missing,
    };
  }

  const us = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  const loadedComments = loadPromptComments({ epicId });
  const comments =
    options.virtualComments ??
    (comment?.trim()
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

  // Exact section texts matching buildBuildPrompt
  const systemText = systemSection(buildSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## Epic to Implement\n\n### ${epic.title}\n\n${epic.description ? `${epic.description.trim()}\n` : ""}${ticketImagesSection(epic, { headingLevel: 3 })}\n${userStoriesSection(us)}`;
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
  const instructionsBody = `## Instructions

Implement this epic following the specification above. For each user story:

1. Create or modify the necessary files.
2. Write tests that verify the acceptance criteria.
3. Ensure all acceptance criteria are met before moving to the next story.

Consider all comments in the history — they may contain clarifications, feedback, or specific instructions.

Commit your changes with clear, descriptive commit messages that reference the epic and user story titles. Use conventional commit format when possible.

Work through the user stories in order. If a story depends on another, implement the dependency first.
`;
  const otherText = [
    instructionsBody,
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
  const comments =
    options.virtualComments ??
    (comment?.trim()
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

  // Exact section texts matching buildTicketBuildPrompt
  const systemText = systemSection(ticketBuildSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## Epic Context\n\n### ${epic.title}\n\n${epic.description ? `${epic.description.trim()}\n` : ""}${ticketImagesSection(epic, { headingLevel: 3 })}\n## Ticket to Implement\n\n### ${story.title}\n\n${story.description ? `${story.description.trim()}\n` : ""}${story.acceptanceCriteria ? `**Acceptance Criteria:**\n${story.acceptanceCriteria.trim()}\n` : ""}`;
  const commentsText = commentHistorySection(comments);
  const findingsText = epic.type === "bug" ? BUG_RED_GREEN_SECTION : "";
  const documentsText = documentsSection(
    mentionEnrichment.resolvedDocuments.map((d) => ({
      name: d.originalFilename,
      contentMd: d.markdownContent ?? "",
    }))
  );
  const instructionsBody = `## Instructions

Implement this ticket following the specification and acceptance criteria above. Consider all comments in the history — they may contain clarifications, feedback, or specific instructions.

1. Create or modify the necessary files.
2. Ensure all acceptance criteria are met.
3. Commit your changes with a clear, descriptive commit message referencing the ticket title.
`;
  const otherText = [
    instructionsBody,
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

  // Exact section texts matching buildEpicReviewPrompt
  const isBug = epic.type === "bug";
  const systemText = systemSection(reviewSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## ${isBug ? "Bug Under Review" : "Epic Under Review"}\n\n### ${epic.title}\n\n${epic.description ? `${epic.description.trim()}\n` : ""}${ticketImagesSection(epic, { headingLevel: 3 })}\n${!isBug ? userStoriesSection(us, { checkmark: false }) : ""}`;
  const commentsText = commentHistorySection(promptComments);
  const findingsText =
    isBug && reviewType === "feature_review"
      ? BUG_REVIEW_CHECKLIST
      : REVIEW_CHECKLISTS[reviewType];

  let reviewInstructions = "";
  if (reviewType === "feature_review") {
    if (isBug) {
      reviewInstructions = `## Instructions

You are performing a **bug fix verification** on the bug described above. You have full access to all tools — browser, shell, file system, test runners, etc.

**IMPORTANT: This is a BUG FIX review, not a feature review.** Focus exclusively on verifying the bug fix described in this ticket. Do NOT review unrelated features or changes from other tickets.

1. Read the bug description and understand the reported issue.
2. Read the relevant source files to understand the fix.
3. **Actively test the fix**: launch the app if needed, use the browser, run commands, execute tests.
4. Verify the fix addresses the root cause, not just the symptom.
5. Check for regressions in adjacent functionality.
6. Produce a structured report with PASS/FAIL/PARTIAL for each verification criterion.

**IMPORTANT — Final Verdict:** Your report MUST end with exactly one of these lines:
- \`**Overall Verdict: Bug Fixed**\` — if the fix correctly addresses the reported issue
- \`**Overall Verdict: Partially Complete**\` — if the fix is incomplete or introduces issues
- \`**Overall Verdict: Not Complete**\` — if the bug is not resolved

Your response should be a well-formatted markdown report. Do NOT just read the code — actually run and test the fix.
`;
    } else {
      reviewInstructions = `## Instructions

You are performing a **feature completeness review** on the entire epic described above, covering all user stories. You have full access to all tools — browser, shell, file system, test runners, etc.

1. Read the relevant source files to understand the implementation.
2. **Actively test the features**: launch the app if needed, use the browser to navigate to relevant pages, run commands, execute tests.
3. Go through each user story and its acceptance criteria, verifying with concrete evidence.
4. Produce a structured report with PASS/FAIL/PARTIAL for each user story and criterion.
5. End with a summary: number of stories/criteria passed/failed, and an overall verdict.

**IMPORTANT — Final Verdict:** Your report MUST end with exactly one of these lines:
- \`**Overall Verdict: Feature Complete**\` — if all acceptance criteria pass
- \`**Overall Verdict: Partially Complete**\` — if some criteria fail
- \`**Overall Verdict: Not Complete**\` — if major criteria fail

Your response should be a well-formatted markdown report. Do NOT just read the code — actually run and test the features.
`;
    }
  } else {
    const reviewLabel = isBug
      ? `${reviewType.replace("_", " ")} (bug fix)`
      : reviewType.replace("_", " ");
    reviewInstructions = `## Instructions

You are performing a **${reviewLabel}** on the ${isBug ? "bug fix" : "entire epic"} described above${isBug ? "" : ", covering all user stories"}.

${isBug ? "**IMPORTANT: This is a BUG FIX review.** Focus exclusively on the bug fix described in this ticket. Do NOT review unrelated features or changes from other tickets.\n" : ""}1. Read the relevant source files in the current working directory.
2. Evaluate the code against every item in the checklist above.
3. Produce a structured report with your findings.
4. If no issues are found for a category, state "No issues found."
5. End with a summary: total findings by severity, and an overall verdict.

**IMPORTANT — Final Verdict:** Your report MUST end with exactly one of these lines:
- \`**Overall Verdict: Approved**\` — no blocking issues found
- \`**Overall Verdict: Approved with Minor Issues**\` — minor suggestions only
- \`**Overall Verdict: Changes Requested**\` — blocking issues that must be fixed

Your response should be a well-formatted markdown report.
`;
  }

  const documentsText = documentsSection(
    mentionEnrichment.resolvedDocuments.map((d) => ({
      name: d.originalFilename,
      contentMd: d.markdownContent ?? "",
    }))
  );
  const otherText = `${reviewInstructions}\n\n${REVIEW_BOUNDARY_SECTION}`;

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

  const promptComments =
    options.comments ?? loadPromptComments({ userStoryId: storyId });
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

  // Exact section texts matching buildReviewPrompt
  const systemText = systemSection(reviewSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## Epic Context\n\n### ${epic.title}\n\n${epic.description ? `${epic.description.trim()}\n` : ""}${ticketImagesSection(epic, { headingLevel: 3 })}\n## Ticket Under Review\n\n### ${story.title}\n\n${story.description ? `${story.description.trim()}\n` : ""}${story.acceptanceCriteria ? `**Acceptance Criteria:**\n${story.acceptanceCriteria.trim()}\n` : ""}`;
  const commentsText = commentHistorySection(promptComments);
  const findingsText = REVIEW_CHECKLISTS[reviewType];

  let reviewInstructions = "";
  if (reviewType === "feature_review") {
    reviewInstructions = `## Instructions

You are performing a **feature completeness review** on the ticket described above. You have full access to all tools — browser, shell, file system, test runners, etc.

1. Read the relevant source files to understand the implementation.
2. **Actively test the feature**: launch the app if needed, use the browser to navigate to relevant pages, run commands, execute tests.
3. Go through each acceptance criterion and verify it with concrete evidence.
4. Produce a structured report with PASS/FAIL/PARTIAL for each criterion.
5. End with a summary: number of criteria passed/failed, and an overall verdict.

**IMPORTANT — Final Verdict:** Your report MUST end with exactly one of these lines:
- \`**Overall Verdict: Feature Complete**\` — if all acceptance criteria pass
- \`**Overall Verdict: Partially Complete**\` — if some criteria fail
- \`**Overall Verdict: Not Complete**\` — if major criteria fail

Your response should be a well-formatted markdown report. Do NOT just read the code — actually run and test the feature.
`;
  } else {
    reviewInstructions = `## Instructions

You are performing a **${reviewType.replace("_", " ")}** on the code changes for the ticket described above.

1. Read the relevant source files in the current working directory.
2. Evaluate the code against every item in the checklist above.
3. Produce a structured report with your findings.
4. If no issues are found for a category, state "No issues found."
5. End with a summary: total findings by severity, and an overall verdict.

**IMPORTANT — Final Verdict:** Your report MUST end with exactly one of these lines:
- \`**Overall Verdict: Approved**\` — no blocking issues found
- \`**Overall Verdict: Approved with Minor Issues**\` — minor suggestions only
- \`**Overall Verdict: Changes Requested**\` — blocking issues that must be fixed

Your response should be a well-formatted markdown report.
`;
  }

  const documentsText = documentsSection(
    mentionEnrichment.resolvedDocuments.map((d) => ({
      name: d.originalFilename,
      contentMd: d.markdownContent ?? "",
    }))
  );
  const otherText = `${reviewInstructions}\n\n${REVIEW_BOUNDARY_SECTION}`;

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

  // Exact section texts matching buildGradingPrompt
  const systemText = systemSection(gradingSystemPrompt);
  const specText = `${projectHeader(project.name)}\n${specSection(project.spec)}`;
  const memoryText = memorySection(project.memory);
  const ticketText = `## Epic to Grade\n\n### ${epic.title}\n\n${epic.description ? `${epic.description.trim()}\n` : ""}`;
  const rubricParts = ["## Acceptance-Criteria Rubric\n"];
  for (const story of stories) {
    rubricParts.push(`### ${story.title}\n`);
    rubricParts.push(`- **storyId:** \`${story.id}\`\n`);
    if (story.description) {
      rubricParts.push(`${story.description.trim()}\n`);
    }
    rubricParts.push(`**Acceptance criteria (verbatim):**\n`);
    rubricParts.push(`${story.acceptanceCriteria?.trim() ?? ""}\n`);
  }
  const findingsText = rubricParts.join("");
  const documentsText = documentsSection(
    mentionEnrichment.resolvedDocuments.map((d) => ({
      name: d.originalFilename,
      contentMd: d.markdownContent ?? "",
    }))
  );
  const otherText = `## Role Boundary

You are an acceptance-criteria grader, not a general code reviewer. Evaluate only whether the implementation satisfies each criterion above. Do not judge general code quality, style, architecture, or unrelated defects; those belong to review agents.

Inspect the current worktree and its diff, read the relevant implementation and tests, and run focused checks (tests, commands, the app itself) when they materially strengthen the evidence. Evidence must cite concrete files, tests, commands, or observed behavior. An implementation claim in an agent comment is not proof.

You must not modify the repository: no file edits, creates, or deletes, no commits, no branch or git-state changes. Grading only observes; if running something leaves incidental artifacts, leave them uncommitted.

## Mandatory Structured Submission

Before ending the session, you **MUST call** \`mcp__arij__submit_grading\` exactly once. A prose report or final message is not a substitute for this tool call.

Submit this shape:

\`{ gradings: [{ storyId, criterion, status, evidence }], summary }\`

- Include exactly one grading entry for every acceptance criterion in the rubric.
- Use the exact \`storyId\` shown above and copy the corresponding criterion verbatim into \`criterion\`.
- \`status\` must be one of: \`met | partial | missed\`.
- \`evidence\` must explain the observed proof or the concrete gap; never leave it empty.
- Use \`met\` only when the criterion is fully demonstrated, \`partial\` when only part is demonstrated, and \`missed\` when it is absent or contradicted.
- Keep \`summary\` concise and outcome-focused.

Do not call \`submit_findings\`; grading does not create review findings and introduces no ticket transition. After \`submit_grading\` succeeds, briefly summarize that the structured report was filed.
`;

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
