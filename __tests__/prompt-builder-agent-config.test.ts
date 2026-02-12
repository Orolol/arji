import { describe, expect, it } from "vitest";
import {
  buildBuildPrompt,
  buildChatPrompt,
  buildReviewPrompt,
  buildSpecPrompt,
  buildTicketBuildPrompt,
  buildTeamBuildPrompt,
  type PromptDocument,
  type PromptEpic,
  type PromptMessage,
  type PromptProject,
  type PromptUserStory,
  type TeamEpic,
} from "@/lib/claude/prompt-builder";

const project: PromptProject = {
  name: "Arij",
  description: "AI-first local orchestrator",
  spec: "Use Next.js and SQLite",
};

const docs: PromptDocument[] = [
  {
    name: "README",
    contentMd: "# Readme",
  },
];

const messages: PromptMessage[] = [
  { role: "user", content: "How should we structure this?" },
];

const epic: PromptEpic = {
  title: "Agent Configuration",
  description: "Add agent config side panel",
};

const story: PromptUserStory = {
  title: "As a dev I can configure prompts",
  description: "Add prompt editors",
  acceptanceCriteria: "- [ ] Editors are persisted",
};

describe("Prompt builders with agent-config system prompts", () => {
  it("injects system prompt into build/chat/spec/team/ticket builders", () => {
    expect(buildBuildPrompt(project, docs, epic, [story], "Use strict TS")).toContain(
      "# System Instructions"
    );
    expect(buildChatPrompt(project, docs, messages, "Chat safely")).toContain(
      "Chat safely"
    );
    expect(buildSpecPrompt(project, docs, messages, "Spec as JSON")).toContain(
      "Spec as JSON"
    );

    const teamEpics: TeamEpic[] = [
      {
        title: "Epic 1",
        description: "One epic",
        worktreePath: "/tmp/worktree-1",
        userStories: [story],
      },
    ];
    expect(
      buildTeamBuildPrompt(project, docs, teamEpics, "Coordinate sub-agents")
    ).toContain("Coordinate sub-agents");

    expect(
      buildTicketBuildPrompt(project, docs, epic, story, [], "Fix this ticket")
    ).toContain("Fix this ticket");
  });

  it("supports custom review agent prompts", () => {
    const prompt = buildReviewPrompt(
      project,
      docs,
      epic,
      story,
      {
        name: "UI Review",
        systemPrompt: "Focus on visual hierarchy and copy clarity.",
      },
      "Follow project constraints"
    );

    expect(prompt).toContain("Follow project constraints");
    expect(prompt).toContain("Custom Review Agent Instructions");
    expect(prompt).toContain("UI Review");
    expect(prompt).toContain("visual hierarchy");
  });

  it("keeps built-in review checklists available", () => {
    const prompt = buildReviewPrompt(
      project,
      docs,
      epic,
      story,
      "security",
      "Security-first review"
    );

    expect(prompt).toContain("Security Audit Checklist");
    expect(prompt).toContain("Security-first review");
  });
});
