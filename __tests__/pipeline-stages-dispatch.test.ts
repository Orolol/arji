/**
 * Integration tests for the pipeline's real stage launchers
 * (lib/pipeline/stages.ts) against the migrated schema, with the CLI spawn
 * mocked and the real scheduler + lifecycle in the loop:
 *
 *   - fix stage: build-semantics session (agentType build), resumes the
 *     run's previous code-writing session (same cliSessionId +
 *     resumeSession: true), prompt carries the open review feedback and the
 *     pipeline fix instructions, board sync identical to a human re-send
 *     (in_progress at dispatch, review on success, agent comment),
 *   - resume refusal paths: non-resumable provider (fresh, no cliSessionId)
 *     and cross-provider mismatch (fresh uuid),
 *   - review stage: agentType review_code in plan mode via
 *     resolveAgentForDispatch purpose 'review', labeled '**Code Review**'
 *     comment, negative-prose revert to in_progress, output cached for the
 *     driver's prose-fallback assessment,
 *   - escalation (attempt >= 3): alternative provider, namedAgentId null,
 *   - guard probe: foreign active session flagged, own sessions ignored,
 *     scope-correct review-target status.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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
    branchName: "feature/pipeline-stage-test",
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
  enrichPromptWithDocumentMentions: vi.fn(
    ({ prompt }: { prompt: string }) => ({ prompt, missing: [] })
  ),
  userAuthoredTexts: vi.fn(
    (entries: Array<{ author?: string | null; content?: string | null }>) =>
      entries.filter((e) => e.author !== "agent").map((e) => e.content)
  ),
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
const {
  projects,
  epics,
  userStories,
  agentSessions,
  reviewComments,
  ticketComments,
  ticketActivityLog,
  namedAgents,
} = await import("@/lib/db/schema");
const { processManager } = await import("@/lib/claude/process-manager");
const { createPipelineStageDriver } = await import("@/lib/pipeline/stages");
const { PIPELINE_FIX_INSTRUCTIONS_SECTION } = await import(
  "@/lib/pipeline/stages"
);

let counter = 0;

function claudeEnvelope(text: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result: text });
}

function seed(epicStatus = "review") {
  counter += 1;
  const projectId = `proj-stage-${counter}`;
  const epicId = `epic-stage-${counter}`;
  const storyId = `story-stage-${counter}`;

  db.insert(projects)
    .values({ id: projectId, name: "Stage Project", gitRepoPath: "/repos/s" })
    .run();
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Stage epic",
      status: epicStatus,
      position: 0,
      readableId: `E-s-${counter}`,
    })
    .run();
  db.insert(userStories)
    .values({
      id: storyId,
      epicId,
      title: "Stage story",
      status: epicStatus,
      position: 0,
    })
    .run();

  return { projectId, epicId, storyId };
}

function insertSession(input: {
  id: string;
  projectId: string;
  epicId?: string | null;
  userStoryId?: string | null;
  provider?: string;
  cliSessionId?: string | null;
  status?: string;
  agentType?: string;
}) {
  db.insert(agentSessions)
    .values({
      id: input.id,
      projectId: input.projectId,
      epicId: input.epicId ?? null,
      userStoryId: input.userStoryId ?? null,
      provider: input.provider ?? "claude-code",
      cliSessionId: input.cliSessionId ?? null,
      status: input.status ?? "completed",
      agentType: input.agentType ?? "build",
      mode: "code",
      createdAt: new Date().toISOString(),
    })
    .run();
}

function startOpts(callIndex = 0) {
  const calls = vi.mocked(processManager.start).mock.calls;
  expect(calls.length).toBeGreaterThan(callIndex);
  return {
    sessionId: calls[callIndex][0] as string,
    opts: calls[callIndex][1] as unknown as Record<string, unknown>,
    provider: calls[callIndex][2] as string,
  };
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
  resolutionMocks.pickAlternativeReviewProvider.mockResolvedValue("codex");
  processManagerState.result = {
    success: true,
    result: claudeEnvelope("Fixed everything."),
    duration: 1000,
  };
});

describe("fix stage dispatch (epic scope)", () => {
  it("resumes the previous code session, injects findings + fix instructions, and mirrors the build route's board sync", async () => {
    const { projectId, epicId } = seed("review");
    const buildSid = `build-${counter}`;
    insertSession({
      id: buildSid,
      projectId,
      epicId,
      cliSessionId: "cli-abc",
      agentType: "build",
    });
    db.insert(reviewComments)
      .values({
        id: `rc-${counter}`,
        epicId,
        filePath: "src/auth.ts",
        lineNumber: 7,
        body: "[critical] Token never expires",
        author: "agent",
        status: "open",
        createdAt: new Date().toISOString(),
      })
      .run();

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });

    const handle = await driver.launchStage({
      stage: "fix",
      attempt: 1,
      fixCycle: 1,
      previousAttemptSessionId: null,
      lastCodeSessionId: buildSid,
    });

    expect(handle.sessionId).toBeTruthy();
    expect(handle.escalatedToProvider).toBeNull();

    // Session row: build semantics, resumed CLI session.
    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!;
    expect(row).toMatchObject({
      agentType: "build",
      mode: "code",
      epicId,
      userStoryId: null,
      cliSessionId: "cli-abc",
      provider: "claude-code",
    });
    expect(row.prompt).toContain("## Code Review Feedback");
    expect(row.prompt).toContain("[critical] Token never expires");
    expect(row.prompt).toContain(PIPELINE_FIX_INSTRUCTIONS_SECTION);

    const spawn = startOpts();
    expect(spawn.sessionId).toBe(handle.sessionId);
    expect(spawn.provider).toBe("claude-code");
    expect(spawn.opts).toMatchObject({
      mode: "code",
      cwd: "/tmp/worktree",
      cliSessionId: "cli-abc",
      resumeSession: true,
    });
    expect(spawn.opts.allowedTools).toContain("Edit");

    // Completion: settled triple + finalize block (epic back to review,
    // agent comment, activity entries).
    const settled = await handle.settled;
    expect(settled).toMatchObject({
      sessionId: handle.sessionId,
      success: true,
      outcome: "answered",
    });
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("review");
    const comments = db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "agent",
      agentSessionId: handle.sessionId,
      content: "Fixed everything.",
    });
    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    // Dispatch-side board sync (identical to a human re-send-to-dev): the
    // ticket went review → in_progress at dispatch, then back to review on
    // success. Asserted via the activity trail — with the CLI mocked to
    // complete instantly, the mid-flight status is not observable.
    expect(activity).toContainEqual(
      expect.objectContaining({
        reason: "Build agent started",
        fromStatus: "review",
        toStatus: "in_progress",
        actor: "agent",
      })
    );
    expect(activity).toContainEqual(
      expect.objectContaining({
        reason: "Build completed successfully",
        fromStatus: "in_progress",
        toStatus: "review",
      })
    );
  });

  it("starts fresh (no cliSessionId) when the provider cannot resume", async () => {
    const { projectId, epicId } = seed("review");
    const buildSid = `build-${counter}`;
    insertSession({
      id: buildSid,
      projectId,
      epicId,
      provider: "codex",
      cliSessionId: "cli-codex",
    });
    resolutionMocks.resolveAgentByNamedId.mockReturnValue({
      provider: "codex",
      namedAgentId: null,
      name: null,
      model: null,
    });

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "fix",
      attempt: 1,
      fixCycle: 1,
      previousAttemptSessionId: null,
      lastCodeSessionId: buildSid,
    });

    const spawn = startOpts();
    expect(spawn.opts.resumeSession).toBe(false);
    expect(spawn.opts.cliSessionId).toBeUndefined();
    await handle.settled;
  });

  it("refuses a cross-provider resume and mints a fresh cliSessionId instead", async () => {
    const { projectId, epicId } = seed("review");
    const buildSid = `build-${counter}`;
    // Previous code session ran on gemini-cli; the fix resolves to
    // claude-code — its stored cliSessionId means nothing to claude.
    insertSession({
      id: buildSid,
      projectId,
      epicId,
      provider: "gemini-cli",
      cliSessionId: "cli-gemini",
    });

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "fix",
      attempt: 1,
      fixCycle: 1,
      previousAttemptSessionId: null,
      lastCodeSessionId: buildSid,
    });

    const spawn = startOpts();
    expect(spawn.opts.resumeSession).toBe(false);
    expect(spawn.opts.cliSessionId).toBeTruthy();
    expect(spawn.opts.cliSessionId).not.toBe("cli-gemini");
    await handle.settled;
  });

  it("resumes a previous pi session with the id pi reported", async () => {
    const { projectId, epicId } = seed("review");
    const buildSid = `build-${counter}`;
    insertSession({
      id: buildSid,
      projectId,
      epicId,
      provider: "pi",
      cliSessionId: "3f1c9a52-1b7e-4f21-9a6f-7b1c2d3e4f50",
    });
    resolutionMocks.resolveAgentByNamedId.mockReturnValue({
      provider: "pi",
      namedAgentId: null,
      name: null,
      model: null,
    });

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "fix",
      attempt: 1,
      fixCycle: 1,
      previousAttemptSessionId: null,
      lastCodeSessionId: buildSid,
    });

    const spawn = startOpts();
    expect(spawn.opts.resumeSession).toBe(true);
    expect(spawn.opts.cliSessionId).toBe("3f1c9a52-1b7e-4f21-9a6f-7b1c2d3e4f50");
    await handle.settled;
  });

  /**
   * pi prints the session id it created, so dispatch must not invent one:
   * a minted id would be stored and later replayed into `--session`.
   */
  it("mints no cliSessionId for pi when there is nothing to resume", async () => {
    const { projectId, epicId } = seed("review");
    resolutionMocks.resolveAgentByNamedId.mockReturnValue({
      provider: "oh-my-pi",
      namedAgentId: null,
      name: null,
      model: null,
    });

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "fix",
      attempt: 1,
      fixCycle: 1,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });

    const spawn = startOpts();
    expect(spawn.opts.resumeSession).toBe(false);
    expect(spawn.opts.cliSessionId).toBeUndefined();
    await handle.settled;
  });
});

describe("review stage dispatch", () => {
  it("dispatches review_code in plan mode via purpose-review resolution and posts the labeled comment", async () => {
    const { projectId, epicId } = seed("review");
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("**Overall Verdict: Complete** — all good."),
      duration: 900,
    };

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 0,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });

    expect(resolutionMocks.resolveAgentForDispatch).toHaveBeenCalledWith(
      "review_code",
      projectId,
      null,
      { purpose: "review", projectId, epicId }
    );

    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!;
    expect(row).toMatchObject({ agentType: "review_code", mode: "plan" });

    const spawn = startOpts();
    expect(spawn.opts.mode).toBe("plan");
    expect(spawn.opts.allowedTools).toBeUndefined();

    await handle.settled;
    const comment = db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all()[0];
    expect(comment.content).toBe(
      "**Code Review**\n\n**Overall Verdict: Complete** — all good."
    );
    // Positive verdict: the ticket stays in review.
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("review");
  });

  it("carries still-open findings and the convergence rules into the review prompt", async () => {
    const { projectId, epicId } = seed("review");
    db.insert(reviewComments)
      .values({
        id: `rc-prior-${counter}`,
        epicId,
        filePath: "src/auth.ts",
        lineNumber: 7,
        body: "[critical] Token never expires",
        author: "agent",
        status: "open",
        createdAt: new Date().toISOString(),
      })
      .run();
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("**Overall Verdict: Complete**"),
      duration: 900,
    };

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 2,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });

    const prompt = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!.prompt!;

    expect(prompt).toContain("## Findings Still Open From Previous Reviews");
    // The reviewer sees the finding itself, anchored.
    expect(prompt).toContain("[critical] Token never expires");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("**Line 7**");
    // fixCycle is zero-based; the prompt speaks in human cycle numbers.
    expect(prompt).toContain("This is review cycle 3");
    // The two rules that make the loop terminate.
    expect(prompt).toContain("FIXED or STILL OPEN");
    expect(prompt).toContain("bound new findings to what this branch changed");

    await handle.settled;
  });

  it("leaves the review prompt untouched when nothing is open", async () => {
    const { projectId, epicId } = seed("review");
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("**Overall Verdict: Complete**"),
      duration: 900,
    };

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 0,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });

    // A first-cycle review must read exactly as it did before this section
    // existed — no empty heading, no phantom cycle counter.
    const prompt = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!.prompt!;
    expect(prompt).not.toContain("Findings Still Open");
    expect(prompt).not.toContain("review cycle");

    await handle.settled;
  });

  it("shows a story-scoped review the epic's open findings", async () => {
    // reviewComments is epic-keyed: a sibling story's unfixed finding must
    // stay visible to the next story's reviewer instead of being rediscovered
    // from scratch as a brand-new Major.
    const { projectId, epicId, storyId } = seed("review");
    db.insert(reviewComments)
      .values({
        id: `rc-sibling-${counter}`,
        epicId,
        filePath: "src/sibling.ts",
        lineNumber: 3,
        body: "[major] Filed while reviewing another story",
        author: "agent",
        status: "open",
        createdAt: new Date().toISOString(),
      })
      .run();
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("**Overall Verdict: Complete**"),
      duration: 900,
    };

    const driver = createPipelineStageDriver({
      projectId,
      scope: "story",
      epicId,
      userStoryId: storyId,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 1,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });

    expect(
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, handle.sessionId!))
        .get()!.prompt!
    ).toContain("[major] Filed while reviewing another story");

    await handle.settled;
  });

  it("passes an explicit reviewNamedAgentId through to the review resolution", async () => {
    const { projectId, epicId } = seed("review");
    db.insert(namedAgents)
      .values({
        id: "named-reviewer",
        name: `Codex Reviewer ${counter}`,
        provider: "codex",
        model: "gpt-5.4",
      })
      .onConflictDoNothing()
      .run();
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("**Overall Verdict: Complete**"),
      duration: 900,
    };
    // An explicitly picked named agent wins over reviewer segregation —
    // the resolver's own precedence rule, exercised here end-to-end.
    resolutionMocks.resolveAgentForDispatch.mockResolvedValueOnce({
      provider: "codex",
      namedAgentId: "named-reviewer",
      name: "Codex Reviewer",
      model: "gpt-5.4",
    });

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
      reviewNamedAgentId: "named-reviewer",
    });
    const handle = await driver.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 0,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });

    expect(resolutionMocks.resolveAgentForDispatch).toHaveBeenCalledWith(
      "review_code",
      projectId,
      "named-reviewer",
      { purpose: "review", projectId, epicId }
    );

    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!;
    expect(row).toMatchObject({
      provider: "codex",
      namedAgentId: "named-reviewer",
      namedAgentName: "Codex Reviewer",
      model: "gpt-5.4",
    });

    await handle.settled;
  });

  it("keeps segregation-friendly null resolution when reviewNamedAgentId is omitted", async () => {
    const { projectId, epicId } = seed("review");
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("**Overall Verdict: Complete**"),
      duration: 900,
    };

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: "build-agent",
    });
    const handle = await driver.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 0,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });

    expect(resolutionMocks.resolveAgentForDispatch).toHaveBeenCalledWith(
      "review_code",
      projectId,
      null,
      { purpose: "review", projectId, epicId }
    );
    await handle.settled;
  });

  it("reverts the ticket on a negative prose verdict and feeds the driver's prose fallback", async () => {
    const { projectId, epicId, storyId } = seed("review");
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("**Overall Verdict: Changes Requested**"),
      duration: 900,
    };

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const stageStartedAt = new Date().toISOString();
    const handle = await driver.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 0,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });
    await handle.settled;

    // Route-identical revert (epic + stories → in_progress, agent reason).
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("in_progress");
    expect(
      db.select().from(userStories).where(eq(userStories.id, storyId)).get()!
        .status
    ).toBe("in_progress");
    const reasons = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all()
      .map((a) => a.reason);
    expect(reasons).toContain("Review verdict: changes requested (Code Review)");

    // Zero findings rows → the driver's assessment uses the cached output.
    const assessment = await driver.assessReview({
      sessionId: handle.sessionId!,
      stageStartedAt,
    });
    expect(assessment).toMatchObject({
      blocking: true,
      usedProseFallback: true,
      agentCommentCount: 0,
    });
  });

  it("escalates attempt >= 3 to the alternative provider with no named agent", async () => {
    const { projectId, epicId } = seed("review");
    const prevSid = `review-prev-${counter}`;
    insertSession({
      id: prevSid,
      projectId,
      epicId,
      provider: "claude-code",
      status: "failed",
      agentType: "review_code",
    });

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "review",
      attempt: 3,
      fixCycle: 0,
      previousAttemptSessionId: prevSid,
      lastCodeSessionId: null,
    });

    expect(
      resolutionMocks.pickAlternativeReviewProvider
    ).toHaveBeenCalledWith("claude-code");
    expect(handle.escalatedToProvider).toBe("codex");

    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!;
    expect(row).toMatchObject({
      provider: "codex",
      namedAgentId: null,
      model: null,
    });
    expect(startOpts().provider).toBe("codex");
    await handle.settled;
  });
});

describe("story scope", () => {
  it("dispatches ticket_build fix sessions and syncs the story board states", async () => {
    const { projectId, epicId, storyId } = seed("review");
    const buildSid = `tbuild-${counter}`;
    insertSession({
      id: buildSid,
      projectId,
      epicId,
      userStoryId: storyId,
      cliSessionId: "cli-story",
      agentType: "ticket_build",
    });

    const driver = createPipelineStageDriver({
      projectId,
      scope: "story",
      epicId,
      userStoryId: storyId,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "fix",
      attempt: 1,
      fixCycle: 1,
      previousAttemptSessionId: null,
      lastCodeSessionId: buildSid,
    });

    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!;
    expect(row).toMatchObject({
      agentType: "ticket_build",
      userStoryId: storyId,
      cliSessionId: "cli-story",
    });
    expect(startOpts().opts.resumeSession).toBe(true);

    await handle.settled;
    // Story back to review; sole story → epic review too. Comment on the
    // story, not the epic.
    expect(
      db.select().from(userStories).where(eq(userStories.id, storyId)).get()!
        .status
    ).toBe("review");
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("review");
    const comment = db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.userStoryId, storyId))
      .all()[0];
    expect(comment).toMatchObject({ author: "agent" });
  });

  it("passes the storyId into purpose-review resolution", async () => {
    const { projectId, epicId, storyId } = seed("review");
    const driver = createPipelineStageDriver({
      projectId,
      scope: "story",
      epicId,
      userStoryId: storyId,
      buildNamedAgentId: null,
    });
    const handle = await driver.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 0,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });
    expect(resolutionMocks.resolveAgentForDispatch).toHaveBeenCalledWith(
      "review_code",
      projectId,
      null,
      { purpose: "review", projectId, epicId, storyId }
    );
    await handle.settled;
  });
});

describe("guard probe", () => {
  it("flags foreign active sessions, ignores the run's own, and reads scope-correct status", async () => {
    const { projectId, epicId, storyId } = seed("review");
    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });

    // No active sessions: free, epic status reported.
    expect(driver.checkGuards(["s-own"])).toEqual({
      conflictSessionId: null,
      reviewTargetStatus: "review",
    });

    const intruder = `intruder-${counter}`;
    insertSession({
      id: intruder,
      projectId,
      epicId,
      status: "running",
    });
    expect(driver.checkGuards(["s-own"]).conflictSessionId).toBe(intruder);
    // The run's own live session is not a conflict.
    expect(driver.checkGuards([intruder]).conflictSessionId).toBeNull();

    // Story scope reads the STORY status (a sibling-blocked epic must not
    // fail a story run's review guard).
    db.update(epics).set({ status: "in_progress" }).where(eq(epics.id, epicId)).run();
    db.update(userStories)
      .set({ status: "review" })
      .where(eq(userStories.id, storyId))
      .run();
    const storyDriver = createPipelineStageDriver({
      projectId,
      scope: "story",
      epicId,
      userStoryId: storyId,
      buildNamedAgentId: null,
    });
    expect(storyDriver.checkGuards([intruder]).reviewTargetStatus).toBe(
      "review"
    );
  });
});

describe("batch run tagging (night runs)", () => {
  it("stamps the driver's batchRunId on the stage session row; null when absent", async () => {
    const { projectId, epicId } = seed("review");

    const tagged = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
      batchRunId: "night_test_run",
    });
    const handle = await tagged.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 0,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });
    await handle.settled;

    const taggedRow = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get();
    expect(taggedRow!.batchRunId).toBe("night_test_run");

    // Standalone pipelines (no batchRunId on the init) leave the column NULL.
    const untagged = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const handle2 = await untagged.launchStage({
      stage: "review",
      attempt: 1,
      fixCycle: 0,
      previousAttemptSessionId: null,
      lastCodeSessionId: null,
    });
    await handle2.settled;
    const untaggedRow = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle2.sessionId!))
      .get();
    expect(untaggedRow!.batchRunId).toBeNull();
  });
});
