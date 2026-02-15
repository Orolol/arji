import { describe, expect, it } from "vitest";
import {
  buildChatPrompt,
  buildSpecGenerationPrompt,
  buildTechCheckPrompt,
  buildImportPrompt,
  buildEpicRefinementPrompt,
  buildEpicFinalizationPrompt,
  buildEpicCreationPrompt,
  buildTitleGenerationPrompt,
  buildTeamBuildPrompt,
  buildBuildPrompt,
  buildTicketBuildPrompt,
  buildReviewPrompt,
  buildCustomReviewPrompt,
  buildCustomEpicReviewPrompt,
  buildMergeResolutionPrompt,
  buildEpicReviewPrompt,
  type PromptProject,
  type PromptDocument,
  type PromptMessage,
  type PromptEpic,
  type PromptUserStory,
  type PromptComment,
  type TeamEpic,
} from "@/lib/claude/prompt-builder";

const project: PromptProject = {
  name: "TestProject",
  description: "A test project description",
  spec: "## Spec\nUse Next.js and SQLite",
};

const docs: PromptDocument[] = [
  { name: "README.md", contentMd: "# Readme\nProject docs" },
  { name: "design.md", contentMd: "# Design\nArchitecture notes" },
];

const messages: PromptMessage[] = [
  { role: "user", content: "How should we structure this?" },
  { role: "assistant", content: "I suggest a modular approach." },
];

const epic: PromptEpic = {
  title: "Agent Configuration",
  description: "Add agent config side panel",
};

const story: PromptUserStory = {
  title: "As a dev I can configure prompts",
  description: "Add prompt editors for agent types",
  acceptanceCriteria: "- [ ] Editors are persisted\n- [ ] Changes apply immediately",
};

const comments: PromptComment[] = [
  { author: "user", content: "Please focus on security", createdAt: "2026-02-15T10:00:00Z" },
  { author: "agent", content: "Will add input validation", createdAt: "2026-02-15T10:01:00Z" },
];

const existingEpics: PromptEpic[] = [
  { title: "Auth System" },
  { title: "Dashboard" },
];

const teamEpics: TeamEpic[] = [
  {
    title: "Epic 1",
    description: "First epic",
    worktreePath: "/tmp/worktree-1",
    userStories: [story],
  },
];

const systemPrompt = "Follow strict TypeScript conventions";

describe("Prompt builder snapshot regression", () => {
  it("buildChatPrompt", () => {
    expect(buildChatPrompt(project, docs, messages, systemPrompt)).toMatchSnapshot();
  });

  it("buildSpecGenerationPrompt", () => {
    expect(buildSpecGenerationPrompt(project, docs, messages, systemPrompt)).toMatchSnapshot();
  });

  it("buildTechCheckPrompt", () => {
    expect(buildTechCheckPrompt(project, docs, "Check performance", systemPrompt)).toMatchSnapshot();
  });

  it("buildImportPrompt", () => {
    expect(buildImportPrompt(systemPrompt)).toMatchSnapshot();
  });

  it("buildEpicRefinementPrompt", () => {
    expect(buildEpicRefinementPrompt(project, docs, messages, systemPrompt, existingEpics)).toMatchSnapshot();
  });

  it("buildEpicFinalizationPrompt", () => {
    expect(buildEpicFinalizationPrompt(project, docs, messages, systemPrompt, existingEpics)).toMatchSnapshot();
  });

  it("buildEpicCreationPrompt", () => {
    expect(buildEpicCreationPrompt(project, docs, messages, systemPrompt)).toMatchSnapshot();
  });

  it("buildTitleGenerationPrompt", () => {
    expect(buildTitleGenerationPrompt("Hello", "Hi there, how can I help?")).toMatchSnapshot();
  });

  it("buildTeamBuildPrompt", () => {
    expect(buildTeamBuildPrompt(project, docs, teamEpics, systemPrompt)).toMatchSnapshot();
  });

  it("buildBuildPrompt", () => {
    expect(buildBuildPrompt(project, docs, epic, [story], systemPrompt, comments)).toMatchSnapshot();
  });

  it("buildTicketBuildPrompt", () => {
    expect(buildTicketBuildPrompt(project, docs, epic, story, comments, systemPrompt)).toMatchSnapshot();
  });

  it("buildReviewPrompt - security", () => {
    expect(buildReviewPrompt(project, docs, epic, story, "security", systemPrompt)).toMatchSnapshot();
  });

  it("buildReviewPrompt - feature_review", () => {
    expect(buildReviewPrompt(project, docs, epic, story, "feature_review", systemPrompt)).toMatchSnapshot();
  });

  it("buildReviewPrompt - custom", () => {
    expect(buildReviewPrompt(project, docs, epic, story, { name: "UI Review", systemPrompt: "Check visual hierarchy" }, systemPrompt)).toMatchSnapshot();
  });

  it("buildCustomReviewPrompt", () => {
    expect(buildCustomReviewPrompt(project, docs, epic, story, "Perf Review", "Check for N+1 queries", systemPrompt)).toMatchSnapshot();
  });

  it("buildCustomEpicReviewPrompt", () => {
    expect(buildCustomEpicReviewPrompt(project, docs, epic, [story], "Code Review", "Follow team standards", systemPrompt)).toMatchSnapshot();
  });

  it("buildMergeResolutionPrompt", () => {
    expect(buildMergeResolutionPrompt(project, epic, "feature/epic-123", "CONFLICT (content): merge conflict in src/index.ts", systemPrompt)).toMatchSnapshot();
  });

  it("buildEpicReviewPrompt - code_review", () => {
    expect(buildEpicReviewPrompt(project, docs, epic, [story], "code_review", systemPrompt, comments)).toMatchSnapshot();
  });

  it("buildEpicReviewPrompt - feature_review", () => {
    expect(buildEpicReviewPrompt(project, docs, epic, [story], "feature_review", systemPrompt)).toMatchSnapshot();
  });
});
