import { describe, it, expect } from "vitest";
import {
  buildBuildPrompt,
  buildTicketBuildPrompt,
  buildTeamBuildPrompt,
  type PromptProject,
  type PromptEpic,
  type PromptUserStory,
  type TeamEpic,
} from "@/lib/claude/prompt-builder";

const project: PromptProject = { name: "Test Project" };
const docs = [{ name: "README", contentMd: "# README" }];

const stories: PromptUserStory[] = [
  { title: "Story A", description: "Do A", acceptanceCriteria: "- [ ] A" },
];

function epic(type: string | null): PromptEpic {
  return {
    title: "Crash on save",
    description: "Saving throws",
    type,
    projectId: "p1",
  };
}

const MARKER = "mandatory red → green regression test";

describe("bug red → green prompt rule", () => {
  it("buildBuildPrompt appends the dedicated section for a bug epic", () => {
    const prompt = buildBuildPrompt(project, [], epic("bug"), stories);
    expect(prompt).toContain(MARKER);
    expect(prompt).toContain("Write the failing test first");
    expect(prompt).toContain("Commit the test file(s) together with the fix");
  });

  it("buildBuildPrompt omits the section for a feature epic", () => {
    expect(buildBuildPrompt(project, [], epic("feature"), stories)).not.toContain(
      MARKER
    );
  });

  it("buildBuildPrompt omits the section when type is null (legacy rows)", () => {
    expect(buildBuildPrompt(project, [], epic(null), stories)).not.toContain(
      MARKER
    );
  });

  it("buildTicketBuildPrompt appends the dedicated section for a bug story's epic", () => {
    const prompt = buildTicketBuildPrompt(
      project,
      [],
      epic("bug"),
      stories[0],
      []
    );
    expect(prompt).toContain(MARKER);
    expect(prompt).toContain("test_fails_on_branch");
  });

  it("buildTicketBuildPrompt omits the section for a feature epic", () => {
    expect(
      buildTicketBuildPrompt(project, [], epic("feature"), stories[0], [])
    ).not.toContain(MARKER);
  });

  it("buildTeamBuildPrompt appends the section per bug epic only", () => {
    const bugEpic: TeamEpic = {
      ...epic("bug"),
      worktreePath: "/wt/bug",
      userStories: stories,
    };
    const featureEpic: TeamEpic = {
      ...epic("feature"),
      title: "Feature epic",
      worktreePath: "/wt/feature",
      userStories: stories,
    };
    // One bug epic + one feature epic: exactly one occurrence, under the bug
    // epic's block (before the feature epic's heading).
    const mixed = buildTeamBuildPrompt(project, [], [featureEpic, bugEpic]);
    expect(mixed).toContain(MARKER);
    const first = mixed.indexOf(MARKER);
    const second = mixed.indexOf(MARKER, first + 1);
    expect(second).toBe(-1);
    expect(first).toBeGreaterThan(mixed.indexOf("# Project:"));
    expect(first).toBeGreaterThan(mixed.indexOf("### Epic 2: Crash on save"));

    // No bug epics at all → no section.
    expect(
      buildTeamBuildPrompt(project, [], [featureEpic])
    ).not.toContain(MARKER);
  });
});
