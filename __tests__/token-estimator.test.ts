import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  estimatePromptTokens,
  findLargestContextSection,
  estimatePromptTokensBySections,
} from "@/lib/tokens/estimator";
import {
  assembleEpicBuildPrompt,
  assembleStoryReviewPrompt,
  assembleEpicReviewPrompt,
  assembleGradingPrompt,
} from "@/lib/tokens/dispatch-prompt";
import {
  parsePromptTokenBudget,
  checkPromptTokenBudget,
  resolvePromptTokenBudget,
  promptTokenBudgetSettingKey,
  PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
} from "@/lib/tokens/budget";
import {
  buildBuildPrompt,
  buildReviewPrompt,
  type PromptDocument,
  type PromptEpic,
  type PromptProject,
  type PromptUserStory,
} from "@/lib/claude/prompt-builder";
import { db } from "@/lib/db";
import {
  agentSessions,
  documents,
  epics,
  projects,
  settings,
  ticketComments,
  userStories,
} from "@/lib/db/schema";
import { createQueuedSession } from "@/lib/agent-sessions/lifecycle";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

describe("Token Estimator", () => {
  it("estimates character counts with chars/4 heuristic", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("12345")).toBe(2);
  });

  it("breaks down an assembled build prompt into standard context sections", () => {
    const project: PromptProject = {
      name: "Arij",
      description: "Local-first project manager.",
      spec: "# Full Specification\nThis is a detailed specification document with multiple paragraphs.",
      memory: "## Pitfalls\n- Avoid using globals.\n- Always migrate database safely.",
    };

    const documents: PromptDocument[] = [
      {
        name: "architecture.md",
        contentMd: "Architecture overview and component diagrams.",
      },
    ];

    const epic: PromptEpic = {
      title: "Token estimation epic",
      description: "Estimate token volume sent to agents.",
      type: "feature",
    };

    const userStories: PromptUserStory[] = [
      {
        title: "Display estimation in modal",
        description: "Show tokens before confirming dispatch.",
        acceptanceCriteria: "- Total tokens\n- Breakdown by section",
      },
    ];

    const comments = [
      {
        author: "user" as const,
        content: "Please make sure the breakdown is clear and scannable.",
        createdAt: "2026-08-27T10:00:00Z",
      },
    ];

    const prompt = buildBuildPrompt(
      project,
      documents,
      epic,
      userStories,
      "You are an expert software engineer.",
      comments
    );

    const result = estimatePromptTokens(prompt);
    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBe(Math.ceil(prompt.length / 4));

    expect(Object.values(result.breakdown)).toEqual(Array(8).fill(0));
    expect(findLargestContextSection(result.breakdown, result.total)).toBeNull();
  });

  it("handles review prompts and identifies findings & checklists", () => {
    const project: PromptProject = {
      name: "Arij",
      spec: "Project specification.",
    };
    const epic: PromptEpic = {
      title: "Epic Title",
      description: "Epic description.",
    };
    const story: PromptUserStory = {
      title: "Story Title",
      description: "Story description.",
      acceptanceCriteria: "Must pass all tests.",
    };

    const prompt = buildReviewPrompt(
      project,
      [],
      epic,
      story,
      "security",
      "System prompt"
    );

    const result = estimatePromptTokens(prompt);
    expect(result.total).toBe(Math.ceil(prompt.length / 4));
    expect(Object.values(result.breakdown)).toEqual(Array(8).fill(0));
  });

  it("returns zero counts for empty or missing prompt", () => {
    const result = estimatePromptTokens("");
    expect(result.total).toBe(0);
    expect(result.breakdown.spec).toBe(0);
    expect(result.breakdown.memory).toBe(0);
    expect(result.breakdown.ticket).toBe(0);
    expect(result.breakdown.comments).toBe(0);
    expect(result.breakdown.findings).toBe(0);
    expect(result.breakdown.documents).toBe(0);
    expect(findLargestContextSection(result.breakdown)).toBeNull();
  });
  it("accurately estimates sections by construction without misattribution", () => {
    const commentWithReviewChecklist =
      "## Code Review Checklist\n\n- [x] Item 1\n- [x] Item 2\n\n```typescript\nconst a = 1234;\n";

    const sections = {
      system: "System prompt here.",
      spec: "Specification content here.",
      memory: "Learned memory here.",
      ticket: "Epic and stories here.",
      comments: commentWithReviewChecklist,
      findings: "Actual review findings here.",
      documents: "Documents here.",
      other: "Instructions here.",
    };

    const result = estimatePromptTokensBySections(sections);
    expect(result.breakdown.comments).toBe(Math.ceil(commentWithReviewChecklist.length / 4));
    expect(result.breakdown.findings).toBe(Math.ceil("Actual review findings here.".length / 4));
    expect(result.breakdown.spec).toBe(Math.ceil("Specification content here.".length / 4));
  });

  it("shared assembleEpicBuildPrompt computes correct tokens by construction", async () => {
    const projId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projId,
        name: "Test Shared Proj",
        spec: "# Spec\nFull specification here.",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId: projId,
        title: "Test Shared Epic",
        description: "Shared Epic description",
        status: "todo",
      })
      .run();

    db.insert(userStories)
      .values({
        id: `story-${nanoid(6)}`,
        epicId,
        title: "Story Title",
        description: "Story Description",
        acceptanceCriteria: "- AC 1",
        status: "todo",
      })
      .run();

    db.insert(documents)
      .values({
        id: `doc-${nanoid(6)}`,
        projectId: projId,
        originalFilename: "notes.md",
        kind: "text",
        markdownContent: "Mentioned document content.",
      })
      .run();

    const assembled = await assembleEpicBuildPrompt({
      projectId: projId,
      epicId,
      project: { name: "Test Shared Proj", spec: "# Spec\nFull specification here.", memory: "Memory content here." },
      epic: { title: "Test Shared Epic", description: "Shared Epic description" },
      comment: "User comment on dispatch; read @notes.md",
    });

    expect(assembled.prompt).toContain("Test Shared Epic");
    expect(assembled.tokens.total).toBeGreaterThan(0);
    expect(assembled.tokens.breakdown.spec).toBeGreaterThan(0);
    expect(assembled.tokens.breakdown.memory).toBeGreaterThan(0);
    expect(assembled.tokens.breakdown.ticket).toBeGreaterThan(0);
    expect(assembled.tokens.breakdown.comments).toBeGreaterThan(0);
    expect(assembled.tokens.breakdown.documents).toBeGreaterThan(0);
    expect(assembled.prompt).toContain("## Mentioned Project Documents");

    // Assert all 8 categories sum to total (within ceiling arithmetic tolerance)
    const sum = Object.values(assembled.tokens.breakdown).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - assembled.tokens.total)).toBeLessThanOrEqual(8);
  });

  it("shared assembleEpicReviewPrompt reconciles breakdown with total", async () => {
    const projId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projId,
        name: "Test Review Proj",
        spec: "Spec",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId: projId,
        title: "Test Review Epic",
        status: "review",
      })
      .run();

    const assembled = await assembleEpicReviewPrompt({
      projectId: projId,
      epicId,
      project: { name: "Test Review Proj", spec: "Spec" },
      epic: { title: "Test Review Epic" },
      reviewType: "code_review",
    });

    expect(assembled.tokens.breakdown.findings).toBeGreaterThan(200); // 1,306 char checklist ~ 327 tokens
    const sum = Object.values(assembled.tokens.breakdown).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - assembled.tokens.total)).toBeLessThanOrEqual(8);
  });

  it("shared assembleGradingPrompt reconciles breakdown with total", async () => {
    const projId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projId,
        name: "Test Grading Proj",
        spec: "Spec",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId: projId,
        title: "Test Grading Epic",
        status: "review",
      })
      .run();

    const assembled = await assembleGradingPrompt({
      projectId: projId,
      epicId,
      project: { name: "Test Grading Proj", spec: "Spec" },
      epic: { title: "Test Grading Epic" },
      stories: [
        {
          id: "s1",
          title: "Story 1",
          description: "Desc",
          acceptanceCriteria: "Criterion 1\nCriterion 2",
        },
      ],
    });

    expect(assembled.tokens.breakdown.findings).toBeGreaterThan(0);
    const sum = Object.values(assembled.tokens.breakdown).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - assembled.tokens.total)).toBeLessThanOrEqual(8);
  });

  it("does not charge story-review comments that are only mention sources", async () => {
    const projId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;
    const storyId = `story-${nanoid(6)}`;
    db.insert(projects).values({ id: projId, name: "Story Review" }).run();
    db.insert(epics)
      .values({ id: epicId, projectId: projId, title: "Epic", status: "review" })
      .run();
    db.insert(userStories)
      .values({
        id: storyId,
        epicId,
        title: "Story",
        acceptanceCriteria: "Works",
        status: "review",
      })
      .run();
    db.insert(ticketComments)
      .values({
        id: `comment-${nanoid(6)}`,
        userStoryId: storyId,
        author: "agent",
        content: "## Code Review Checklist\n" + "details ".repeat(300),
      })
      .run();

    const assembled = await assembleStoryReviewPrompt({
      projectId: projId,
      epicId,
      storyId,
      project: { name: "Story Review" },
      epic: { title: "Epic" },
      story: { title: "Story", acceptanceCriteria: "Works" },
      reviewType: "code_review",
    });

    expect(assembled.prompt).not.toContain("## Comment History");
    expect(assembled.tokens.breakdown.comments).toBe(0);
    const sum = Object.values(assembled.tokens.breakdown).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - assembled.tokens.total)).toBeLessThanOrEqual(8);
  });

  it("captures the truncated CI autofix prompt without placeholders or over-counting", async () => {
    const projId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;
    const project = {
      name: "CI Autofix",
      spec: "é".repeat(20_000),
    };
    db.insert(projects).values({ id: projId, ...project }).run();
    db.insert(epics)
      .values({ id: epicId, projectId: projId, title: "CI Epic", status: "todo" })
      .run();

    const assembled = await assembleEpicBuildPrompt({
      projectId: projId,
      epicId,
      project,
      epic: { title: "CI Epic" },
      ciAutofix: {
        prNumber: 42,
        headSha: "abc123",
        failures: [{ name: "test", logTail: "expected true to be false" }],
      },
      worktreeHead: "def456",
    });

    expect(assembled.prompt).toContain("[Specification truncated for this fix session]");
    expect(assembled.sections.other).not.toContain("...");
    expect(assembled.tokens.breakdown.spec).toBeLessThan(assembled.tokens.total);
    const largest = findLargestContextSection(
      assembled.tokens.breakdown,
      assembled.tokens.total,
    );
    expect(largest?.percentage).toBeLessThanOrEqual(100);
    const sum = Object.values(assembled.tokens.breakdown).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - assembled.tokens.total)).toBeLessThanOrEqual(8);
  });

  it("keeps a launch comment exactly once after the route persisted it", async () => {
    const projId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;
    const marker = "PLEASE_DEDUPE_ME";
    db.insert(projects).values({ id: projId, name: "Dedupe" }).run();
    db.insert(epics)
      .values({ id: epicId, projectId: projId, title: "Epic", status: "todo" })
      .run();
    db.insert(ticketComments)
      .values({
        id: `comment-${nanoid(6)}`,
        epicId,
        author: "user",
        content: marker,
      })
      .run();

    const assembled = await assembleEpicBuildPrompt({
      projectId: projId,
      epicId,
      project: { name: "Dedupe" },
      epic: { title: "Epic" },
      comment: marker,
      commentAlreadyPersisted: true,
    });

    expect(assembled.prompt.split(marker)).toHaveLength(2);
  });
});

describe("Token Budget", () => {
  it("parses numeric values, numeric strings, and suffixes k/m", () => {
    expect(parsePromptTokenBudget(null)).toBeNull();
    expect(parsePromptTokenBudget(undefined)).toBeNull();
    expect(parsePromptTokenBudget("")).toBeNull();
    expect(parsePromptTokenBudget("invalid")).toBeNull();
    expect(parsePromptTokenBudget(50000)).toBe(50000);
    expect(parsePromptTokenBudget("50000")).toBe(50000);
    expect(parsePromptTokenBudget("50k")).toBe(50000);
    expect(parsePromptTokenBudget("1.5k")).toBe(1500);
    expect(parsePromptTokenBudget("1m")).toBe(1000000);
    expect(parsePromptTokenBudget(JSON.stringify(60000))).toBe(60000);
  });

  it("checks budget thresholds and highlights the largest section", () => {
    const breakdown = {
      spec: 30000,
      memory: 2000,
      ticket: 5000,
      comments: 3000,
      findings: 1000,
      documents: 10000,
      system: 500,
      other: 500,
    };
    const total = 52000;

    const noBudget = checkPromptTokenBudget(total, breakdown, null);
    expect(noBudget.budgetExceeded).toBe(false);
    expect(noBudget.largestSection).toBeNull();

    const withinBudget = checkPromptTokenBudget(total, breakdown, 100000);
    expect(withinBudget.budgetExceeded).toBe(false);

    const exceeded = checkPromptTokenBudget(total, breakdown, 40000);
    expect(exceeded.budgetExceeded).toBe(true);
    expect(exceeded.largestSection?.key).toBe("spec");
    expect(exceeded.largestSection?.tokens).toBe(30000);
    expect(exceeded.largestSection?.percentage).toBe(58);

    expect(
      findLargestContextSection({ ...breakdown, spec: 60_000 }, 52_000)
        ?.percentage,
    ).toBe(100);
  });
});

describe("Session Creation Token Persistence", () => {
  it("automatically estimates and persists prompt tokens in createQueuedSession", () => {
    const projId = `proj-${nanoid(6)}`;
    db.insert(projects)
      .values({ id: projId, name: "Test Proj" })
      .run();

    const prompt = "# Project: Test Proj\n## Project Specification\nSome long specification details.\n## Instructions\nDo work.";
    const sessionId = `sess-${nanoid(6)}`;

    createQueuedSession({
      id: sessionId,
      projectId: projId,
      prompt,
      mode: "code",
      provider: "claude-code",
    });

    const session = db
      .select({
        id: agentSessions.id,
        estimatedPromptTokens: agentSessions.estimatedPromptTokens,
        estimatedPromptBreakdown: agentSessions.estimatedPromptBreakdown,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();

    expect(session).toBeDefined();
    expect(session?.estimatedPromptTokens).toBe(Math.ceil(prompt.length / 4));
    expect(session?.estimatedPromptBreakdown).toBeNull();
  });

  it("resolves project-specific budget before global budget", () => {
    const projId = `proj-${nanoid(6)}`;
    db.insert(projects)
      .values({ id: projId, name: "Test Proj Budget" })
      .run();

    // Default: null
    expect(resolvePromptTokenBudget(projId)).toBeNull();

    // Global set
    db.insert(settings)
      .values({
        key: PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
        value: "45k",
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: "45k" },
      })
      .run();

    expect(resolvePromptTokenBudget(projId)).toBe(45000);

    // Project override
    db.insert(settings)
      .values({
        key: promptTokenBudgetSettingKey(projId),
        value: "25000",
      })
      .run();

    expect(resolvePromptTokenBudget(projId)).toBe(25000);
  });
});
