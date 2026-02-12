import { describe, it, expect } from "vitest";
import {
  buildTeamBuildPrompt,
  type TeamEpic,
  type PromptProject,
  type PromptDocument,
} from "@/lib/claude/prompt-builder";

const project: PromptProject = {
  name: "Test Project",
  description: "A test project",
  spec: "## Stack\nNext.js, TypeScript",
};

const docs: PromptDocument[] = [
  { name: "README", contentMd: "# README\nProject docs" },
];

const teamEpics: TeamEpic[] = [
  {
    title: "Authentication",
    description: "Add user authentication with JWT",
    worktreePath: "/repos/.arij-worktrees/feature-epic-abc-auth",
    userStories: [
      {
        title: "As a user, I want to log in so that I can access my account",
        description: "Login form with email/password",
        acceptanceCriteria: "- [ ] Login form renders\n- [ ] JWT token stored",
      },
      {
        title: "As a user, I want to register so that I can create an account",
        description: null,
        acceptanceCriteria: "- [ ] Registration form\n- [ ] Validation",
      },
    ],
  },
  {
    title: "Dashboard",
    description: "Build the main dashboard view",
    worktreePath: "/repos/.arij-worktrees/feature-epic-def-dashboard",
    userStories: [
      {
        title: "As a user, I want to see my stats",
        description: "Statistics panel",
        acceptanceCriteria: "- [ ] Stats display correctly",
      },
    ],
  },
];

describe("buildTeamBuildPrompt", () => {
  const prompt = buildTeamBuildPrompt(project, docs, teamEpics, "Be concise");

  it("includes global prompt", () => {
    expect(prompt).toContain("Be concise");
  });

  it("includes project name", () => {
    expect(prompt).toContain("# Project: Test Project");
  });

  it("includes project specification", () => {
    expect(prompt).toContain("Next.js, TypeScript");
  });

  it("includes reference documents", () => {
    expect(prompt).toContain("README");
    expect(prompt).toContain("Project docs");
  });

  it("includes all epic titles", () => {
    expect(prompt).toContain("Epic 1: Authentication");
    expect(prompt).toContain("Epic 2: Dashboard");
  });

  it("includes worktree paths for each epic", () => {
    expect(prompt).toContain("/repos/.arij-worktrees/feature-epic-abc-auth");
    expect(prompt).toContain(
      "/repos/.arij-worktrees/feature-epic-def-dashboard",
    );
  });

  it("includes user stories with acceptance criteria", () => {
    expect(prompt).toContain("I want to log in");
    expect(prompt).toContain("JWT token stored");
    expect(prompt).toContain("I want to register");
    expect(prompt).toContain("I want to see my stats");
  });

  it("includes epic descriptions", () => {
    expect(prompt).toContain("Add user authentication with JWT");
    expect(prompt).toContain("Build the main dashboard view");
  });

  it("instructs CC to use Task tool for delegation", () => {
    expect(prompt).toContain("Task");
    expect(prompt).toContain("sub-agent");
  });

  it("tells CC to decide team size and composition", () => {
    expect(prompt).toContain("You decide how to organize the team");
    expect(prompt).toContain("team lead");
  });

  it("includes build instructions about commits and testing", () => {
    expect(prompt).toContain("conventional commit format");
    expect(prompt).toContain("Write tests");
  });

  it("tells CC not to implement code directly", () => {
    expect(prompt).toContain(
      "Do NOT implement code yourself",
    );
  });

  it("mentions the epic count", () => {
    expect(prompt).toContain("2 epics to implement");
  });
});

describe("buildTeamBuildPrompt without global prompt", () => {
  it("works without global prompt", () => {
    const prompt = buildTeamBuildPrompt(project, [], teamEpics);
    expect(prompt).toContain("# Project: Test Project");
    expect(prompt).not.toContain("Global Instructions");
  });
});
