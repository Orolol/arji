import { describe, expect, it } from "vitest";
import {
  buildBuildPrompt,
  buildChatPrompt,
  buildCustomEpicReviewPrompt,
  buildEpicReviewPrompt,
  buildReviewPrompt,
  buildSpecPrompt,
  buildTechCheckPrompt,
  buildTeamBuildPrompt,
  buildTicketBuildPrompt,
  type PromptDocument,
  type PromptProject,
  type PromptUserStory,
} from "@/lib/claude/prompt-builder";

const project: PromptProject = {
  name: "Arij",
  spec: "Project specification",
};

const docs: PromptDocument[] = [
  { name: "README.md", contentMd: "Context docs" },
];

const story: PromptUserStory = {
  title: "As a dev I want tests",
  description: "Add tests",
  acceptanceCriteria: "- [ ] Unit tests",
};

describe("Prompt builders with resolved system prompts", () => {
  it("injects custom system prompt for build/chat/spec/team/ticket builders", () => {
    const systemPrompt = "Follow project conventions strictly.";
    const build = buildBuildPrompt(
      project,
      docs,
      { title: "Epic 1" },
      [story],
      systemPrompt
    );
    const chat = buildChatPrompt(
      project,
      docs,
      [{ role: "user", content: "Help me" }],
      systemPrompt
    );
    const spec = buildSpecPrompt(project, docs, [], systemPrompt);
    const team = buildTeamBuildPrompt(
      project,
      docs,
      [
        {
          title: "Epic 1",
          worktreePath: "/tmp/wt",
          userStories: [story],
        },
      ],
      systemPrompt
    );
    const ticket = buildTicketBuildPrompt(
      project,
      docs,
      { title: "Epic 1" },
      story,
      [],
      systemPrompt
    );
    const techCheck = buildTechCheckPrompt(
      project,
      docs,
      "Focus on auth/session flows.",
      systemPrompt
    );

    expect(build).toContain("System Instructions");
    expect(chat).toContain("System Instructions");
    expect(spec).toContain("System Instructions");
    expect(team).toContain("System Instructions");
    expect(ticket).toContain("System Instructions");
    expect(techCheck).toContain("System Instructions");
    expect(techCheck).toContain("Focus on auth/session flows.");
    expect(techCheck).toContain("Comprehensive Tech Check");
  });

  it("buildReviewPrompt supports built-in and custom review agents", () => {
    const builtIn = buildReviewPrompt(
      project,
      docs,
      { title: "Epic 1" },
      story,
      "security",
      "Built-in system prompt"
    );
    const custom = buildReviewPrompt(
      project,
      docs,
      { title: "Epic 1" },
      story,
      {
        name: "UI Review",
        systemPrompt: "Review layout consistency and visual hierarchy.",
      },
      "Custom system prompt"
    );

    expect(builtIn).toContain("Security Audit Checklist");
    expect(builtIn).toContain("Built-in system prompt");
    expect(custom).toContain("Custom Review Agent Instructions");
    expect(custom).toContain("UI Review");
    expect(custom).toContain("layout consistency");
  });

  it("reuses shared project/doc/story sections in epic-level review prompts", () => {
    const epic = {
      title: "Epic 1",
      description: "Cross-cutting improvements",
    };

    const customEpicReview = buildCustomEpicReviewPrompt(
      project,
      docs,
      epic,
      [story],
      "Architecture Review",
      "Focus on boundaries and coupling.",
      "Custom global prompt"
    );

    const epicReview = buildEpicReviewPrompt(
      project,
      docs,
      epic,
      [story],
      "feature_review",
      "Built-in global prompt"
    );

    expect(customEpicReview).toContain("# Project: Arij");
    expect(customEpicReview).toContain("## Project Specification");
    expect(customEpicReview).toContain("## Reference Documents");
    expect(customEpicReview).toContain("- **As a dev I want tests**");

    expect(epicReview).toContain("# Project: Arij");
    expect(epicReview).toContain("## Project Specification");
    expect(epicReview).toContain("## Reference Documents");
    expect(epicReview).toContain("- **As a dev I want tests**");
  });
});
