/**
 * The unattended leg of a bug screenshot's journey: Auto Mode and night runs.
 *
 * `bug-image-agent-dispatch.test.ts` drives the epic build route (Send-to-Dev
 * and the bug modal's "Create And Fix"); `bug-image-team-dispatch.test.ts`
 * drives the batch route's team mode. Neither reaches `lib/pipeline/stages.ts`,
 * the launcher behind every automated run, which assembles its own prompts —
 * its own comment calls the block a "mirror of the route counterparts".
 *
 * A mirror is exactly where the team-mode hole hid: the builders were right, so
 * every builder-level test stayed green while the caller handed them a
 * projection carrying no `images`. This pins the caller instead. All four stage
 * kinds are covered because each reaches a different builder — build/fix go
 * through `buildBuildPrompt` (epic scope) or `buildTicketBuildPrompt` (story
 * scope), review through `buildEpicReviewPrompt` — and a caller can only be
 * trusted one call at a time.
 *
 * The prompt is asserted where it is consumed: the argument handed to
 * `processManager.start()`, and the copy stored on the session row the UI reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { eq } from "drizzle-orm";

const processManagerState = vi.hoisted(() => ({
  result: undefined as Record<string, unknown> | undefined,
}));

const resolutionMocks = vi.hoisted(() => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null as string | null,
    name: null as string | null,
    model: null as string | null,
  })),
  resolveAgentForDispatch: vi.fn(async () => ({
    provider: "claude-code",
    namedAgentId: null as string | null,
    name: null as string | null,
    model: null as string | null,
  })),
  pickAlternativeReviewProvider: vi.fn(async () => "codex"),
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => ({
      status: "completed",
      result: processManagerState.result,
    })),
  },
}));

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "feature/bug-image-pipeline",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: resolutionMocks.resolveAgentByNamedId,
  resolveAgentForDispatch: resolutionMocks.resolveAgentForDispatch,
}));

vi.mock("@/lib/agent-config/review-segregation", () => ({
  pickAlternativeReviewProvider: resolutionMocks.pickAlternativeReviewProvider,
}));

vi.mock("@/lib/events/emit", () => ({
  emitSessionStarted: vi.fn(),
  emitSessionCompleted: vi.fn(),
  emitSessionFailed: vi.fn(),
  emitTicketMoved: vi.fn(),
}));

vi.mock("@/lib/documents/mentions", () => ({
  enrichPromptWithDocumentMentions: vi.fn(({ prompt }: { prompt: string }) => ({
    prompt,
    missing: [],
  })),
  userAuthoredTexts: vi.fn(() => []),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw new Error("no logs in tests");
    }),
  },
}));

const { db } = await import("@/lib/db");
const { projects, epics, userStories, agentSessions } = await import(
  "@/lib/db/schema"
);
const { processManager } = await import("@/lib/claude/process-manager");
const { createPipelineStageDriver } = await import("@/lib/pipeline/stages");
const { TICKET_IMAGES_HEADING } = await import("@/lib/claude/prompt-sections");

/** Two of this project's screenshots, plus one belonging to another project. */
const FILE_NAMES = ["a1-blank-board.png", "b2-console-error.png"];
const FOREIGN_UPLOAD = "data/uploads/some-other-project/leak.png";

/** The screenshot heading, anchored at an exact level. */
function headingAt(level: number): RegExp {
  return new RegExp(`^#{${level}} ${TICKET_IMAGES_HEADING}$`, "m");
}

let counter = 0;

function seedProject(): string {
  counter += 1;
  const projectId = `proj-bug-img-${counter}`;
  db.insert(projects)
    .values({
      id: projectId,
      name: "Screenshot Project",
      gitRepoPath: "/repos/screenshots",
    })
    .run();
  return projectId;
}

/**
 * A bug and its single story. Seeded twice in the byte-identity test, where
 * everything but `images` is deliberately identical so the two prompts can only
 * differ by the screenshot block.
 */
function seedBug(projectId: string, images: string | null) {
  counter += 1;
  const epicId = `bug-${counter}`;
  const storyId = `story-${counter}`;
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Board renders blank after login",
      description: "The kanban area stays empty; no error is shown.",
      type: "bug",
      status: "todo",
      position: 0,
      readableId: `B-img-${counter}`,
      images,
    })
    .run();
  db.insert(userStories)
    .values({
      id: storyId,
      epicId,
      title: "Fix the blank board",
      status: "todo",
      position: 0,
    })
    .run();
  return { epicId, storyId };
}

/** The `epics.images` value for this project's two screenshots. */
function storedImages(projectId: string): string {
  return JSON.stringify([
    ...FILE_NAMES.map((name) => `data/uploads/${projectId}/${name}`),
    FOREIGN_UPLOAD,
  ]);
}

/** Where the agent must be told to read those screenshots from. */
function absolutePaths(projectId: string): string[] {
  return FILE_NAMES.map((name) =>
    path.join(process.cwd(), "data", "uploads", projectId, name)
  );
}

async function dispatch(input: {
  projectId: string;
  epicId: string;
  storyId?: string | null;
  scope: "epic" | "story";
  stage: "build" | "review" | "fix";
}): Promise<{ prompt: string; storedPrompt: string }> {
  const driver = createPipelineStageDriver({
    projectId: input.projectId,
    scope: input.scope,
    epicId: input.epicId,
    userStoryId: input.scope === "story" ? input.storyId ?? null : null,
    buildNamedAgentId: null,
  });

  const handle = await driver.launchStage({
    stage: input.stage,
    attempt: 1,
    fixCycle: 1,
    previousAttemptSessionId: null,
    lastCodeSessionId: null,
  });
  expect(handle.sessionId).toBeTruthy();
  await handle.settled;

  const calls = vi.mocked(processManager.start).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const opts = calls[calls.length - 1][1] as unknown as { prompt: string };

  const row = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, handle.sessionId!))
    .get()!;

  return { prompt: opts.prompt, storedPrompt: row.prompt ?? "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolutionMocks.resolveAgentByNamedId.mockReturnValue({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  });
  resolutionMocks.resolveAgentForDispatch.mockResolvedValue({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  });
  processManagerState.result = {
    success: true,
    result: JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Done.",
    }),
    duration: 1000,
  };
});

describe("a bug picked up by the pipeline reaches its agent with the screenshots", () => {
  it("puts their absolute paths in the epic build stage's prompt", async () => {
    const projectId = seedProject();
    const { epicId } = seedBug(projectId, storedImages(projectId));

    const { prompt, storedPrompt } = await dispatch({
      projectId,
      epicId,
      scope: "epic",
      stage: "build",
    });

    expect(prompt).toMatch(headingAt(3));
    for (const absolute of absolutePaths(projectId)) {
      // Absolute on purpose: the agent's cwd is a worktree of the user's
      // project, where a repo-relative `data/uploads/...` finds nothing.
      expect(path.isAbsolute(absolute)).toBe(true);
      expect(prompt).toContain(absolute);
    }
    // The session row is the copy the UI shows; it must carry the same text.
    expect(storedPrompt).toBe(prompt);
  });

  it("keeps the block inside the ticket it belongs to", async () => {
    const projectId = seedProject();
    const { epicId } = seedBug(projectId, storedImages(projectId));

    const { prompt } = await dispatch({
      projectId,
      epicId,
      scope: "epic",
      stage: "build",
    });

    // `## Epic to Implement` holds its parts at `###`. A `##` screenshots
    // heading would close that block and adopt the `### User Stories` that
    // follows, which then reads as part of the screenshots.
    const epicBlock = prompt.indexOf("## Epic to Implement");
    const screenshots = prompt.search(headingAt(3));
    const stories = prompt.indexOf("### User Stories");
    expect(epicBlock).toBeGreaterThan(-1);
    expect(screenshots).toBeGreaterThan(epicBlock);
    expect(screenshots).toBeLessThan(stories);
    expect(prompt).not.toMatch(headingAt(2));
  });

  it("keeps another project's uploads out of the prompt", async () => {
    const projectId = seedProject();
    const { epicId } = seedBug(projectId, storedImages(projectId));

    const { prompt } = await dispatch({
      projectId,
      epicId,
      scope: "epic",
      stage: "build",
    });

    // The column is free-form text; the stage must hand the agent what the
    // shared normaliser accepts, not the raw JSON.
    expect(prompt).not.toContain("some-other-project");
    expect(prompt).not.toContain("leak.png");
  });

  it("puts them in a story-scoped build stage's prompt", async () => {
    const projectId = seedProject();
    const { epicId, storyId } = seedBug(projectId, storedImages(projectId));

    const { prompt } = await dispatch({
      projectId,
      epicId,
      storyId,
      scope: "story",
      stage: "build",
    });

    expect(prompt).toMatch(headingAt(3));
    for (const absolute of absolutePaths(projectId)) {
      expect(prompt).toContain(absolute);
    }
  });

  it("puts them in the review stage's prompt", async () => {
    const projectId = seedProject();
    const { epicId } = seedBug(projectId, storedImages(projectId));
    db.update(epics).set({ status: "review" }).where(eq(epics.id, epicId)).run();

    const { prompt } = await dispatch({
      projectId,
      epicId,
      scope: "epic",
      stage: "review",
    });

    // A reviewer judging a visual fix needs the evidence the builder had.
    expect(prompt).toMatch(headingAt(3));
    for (const absolute of absolutePaths(projectId)) {
      expect(prompt).toContain(absolute);
    }
  });

  it("puts them in a fix stage's prompt, alongside the review feedback", async () => {
    const projectId = seedProject();
    const { epicId } = seedBug(projectId, storedImages(projectId));

    const { prompt } = await dispatch({
      projectId,
      epicId,
      scope: "epic",
      stage: "fix",
    });

    expect(prompt).toMatch(headingAt(3));
    for (const absolute of absolutePaths(projectId)) {
      expect(prompt).toContain(absolute);
    }
  });

  it("leaves a bug without screenshots byte-identical to before the feature", async () => {
    const projectId = seedProject();
    const withImages = seedBug(projectId, storedImages(projectId));
    const withoutImages = seedBug(projectId, null);

    const attached = await dispatch({
      projectId,
      epicId: withImages.epicId,
      scope: "epic",
      stage: "build",
    });
    const bare = await dispatch({
      projectId,
      epicId: withoutImages.epicId,
      scope: "epic",
      stage: "build",
    });

    expect(bare.prompt).not.toContain(TICKET_IMAGES_HEADING);
    expect(bare.prompt).not.toContain("data/uploads");

    // The two bugs differ only by `images`, so removing the block the feature
    // adds must reproduce the pre-feature prompt exactly — no stray blank line,
    // no reordered section.
    const block = attached.prompt.slice(
      attached.prompt.search(headingAt(3)),
      attached.prompt.indexOf("### User Stories")
    );
    expect(block).not.toBe("");
    expect(attached.prompt.replace(block, "")).toBe(bare.prompt);
  });
});
