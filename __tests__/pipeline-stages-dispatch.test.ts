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
 *   - review verdict channels: a structured submit_findings verdict on the
 *     session row outranks the prose scan in BOTH directions, and the
 *     activity trail records which channel decided,
 *   - escalation: attempt 3 uses a configured stronger same-provider named
 *     agent before attempt 4 changes provider; without configuration attempt
 *     3 retains the legacy alternative-provider behaviour,
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

const verificationMocks = vi.hoisted(() => ({
  runVerification: vi.fn(),
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
  emitTicketUpdated: vi.fn(),
}));
vi.mock("@/lib/verify/runner", () => ({
  runVerification: verificationMocks.runVerification,
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

const { db, sqlite } = await import("@/lib/db");
const {
  projects,
  epics,
  userStories,
  agentSessions,
  reviewComments,
  ticketComments,
  ticketActivityLog,
  namedAgents,
  settings,
} = await import("@/lib/db/schema");
const { processManager } = await import("@/lib/claude/process-manager");
const { emitTicketUpdated } = await import("@/lib/events/emit");
const fsMock = await import("fs");
const { createPipelineStageDriver } = await import("@/lib/pipeline/stages");
const { PIPELINE_FIX_INSTRUCTIONS_SECTION } = await import(
  "@/lib/pipeline/stages"
);
const { verifyCommandsSettingKey, verifyTimeoutMsSettingKey } = await import(
  "@/lib/verify/verify-constants"
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
  worktreePath?: string | null;
  namedAgentId?: string | null;
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
      namedAgentId: input.namedAgentId ?? null,
      mode: "code",
      worktreePath: input.worktreePath ?? null,
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

  it("injects missed grading criteria and their evidence into the fix prompt", async () => {
    const { projectId, epicId, storyId } = seed("review");
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
      gradingFailure: {
        reportId: "grading-report-1",
        summary: "The card outcome is missing.",
        missed: [
          {
            storyId,
            criterion: "The Kanban card shows aggregate grading",
            status: "missed",
            evidence: "EpicCard renders no grading badge.",
          },
        ],
      },
    });

    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!;
    expect(row.prompt).toContain("## Acceptance grading gaps");
    expect(row.prompt).not.toContain("A code review found blocking findings");
    expect(row.prompt).toContain("The Kanban card shows aggregate grading");
    expect(row.prompt).toContain("EpicCard renders no grading badge.");
    await handle.settled;
  });

  it("settles a successful provider run even if the terminal session write fails", async () => {
    // The session row is left 'running' (forced write failure), but the
    // terminal handler acts for that owning session — its in_progress →
    // review promotion is now permitted, so the run settles as success.
    const { projectId, epicId } = seed("review");
    sqlite.exec(`
      CREATE TRIGGER refuse_pipeline_terminal_write
      BEFORE UPDATE OF status ON agent_sessions
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'forced terminal write failure');
      END;
    `);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
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

      await expect(handle.settled).resolves.toMatchObject({
        sessionId: handle.sessionId,
        success: true,
        outcome: "answered",
      });
      expect(
        db.select().from(epics).where(eq(epics.id, epicId)).get()?.status
      ).toBe("review");
      expect(
        db
          .select()
          .from(ticketComments)
          .where(eq(ticketComments.epicId, epicId))
          .all()
      ).toContainEqual(
        expect.objectContaining({ content: "Fixed everything." })
      );
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS refuse_pipeline_terminal_write");
      errorSpy.mockRestore();
    }
  });

  it("injects the exact failed command tail into a deterministic-verification fix prompt", async () => {
    const { projectId, epicId } = seed("review");
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
      verificationFailure: {
        name: "unit tests",
        command: "npm test",
        exitCode: 1,
        durationMs: 432,
        tail: "AssertionError: expected 2 to equal 3\nfinal diagnostic line",
      },
    });

    const row = db
      .select({ prompt: agentSessions.prompt })
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!;
    expect(row.prompt).toContain("## Deterministic verification failure");
    expect(row.prompt).toContain("unit tests");
    expect(row.prompt).toContain("npm test");
    expect(row.prompt).toContain("exited with code 1");
    expect(row.prompt).toContain(
      "AssertionError: expected 2 to equal 3\nfinal diagnostic line"
    );

    await handle.settled;
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

  it("resumes a previous oh-my-pi session with the id omp reported", async () => {
    const { projectId, epicId } = seed("review");
    const buildSid = `build-${counter}`;
    insertSession({
      id: buildSid,
      projectId,
      epicId,
      provider: "oh-my-pi",
      cliSessionId: "3f1c9a52-1b7e-4f21-9a6f-7b1c2d3e4f50",
    });
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
    expect(row).toMatchObject({ agentType: "review_code", mode: "code" });
    expect(row.prompt).not.toContain("## Deterministic verification evidence");

    const spawn = startOpts();
    expect(spawn.opts.mode).toBe("code");
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

  it("injects one compact line per passing command into the reviewer prompt", async () => {
    const { projectId, epicId } = seed("review");
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
      lastCodeSessionId: "s-build",
      verificationReport: {
        id: "verify-pass",
        projectId,
        epicId,
        agentSessionId: "s-build",
        status: "pass",
        startedAt: "2026-08-25T10:00:00.000Z",
        finishedAt: "2026-08-25T10:00:02.000Z",
        commands: [
          {
            name: "test",
            command: "npm test",
            exitCode: 0,
            durationMs: 1_200,
            tail: "ok",
          },
          {
            name: "lint",
            command: "npm run lint",
            exitCode: 0,
            durationMs: 800,
            tail: "clean",
          },
        ],
      },
    });

    const row = db
      .select({ prompt: agentSessions.prompt })
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId!))
      .get()!;
    expect(row.prompt).toContain("## Deterministic verification evidence");
    expect(row.prompt).toContain("- PASS — test: npm test (1200 ms)");
    expect(row.prompt).toContain("- PASS — lint: npm run lint (800 ms)");
    expect(row.prompt).not.toContain("clean");

    await handle.settled;
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
    // No submit_findings verdict on the session → the prose channel decided,
    // and the activity trail says so.
    expect(reasons).toContain(
      "Review verdict: changes requested (Code Review) [verdict source: prose]"
    );

    // Zero findings rows → the driver's assessment uses the cached output.
    const assessment = await driver.assessReview({
      sessionId: handle.sessionId!,
      stageStartedAt,
    });
    expect(assessment).toMatchObject({
      blocking: true,
      usedProseFallback: true,
      agentCommentCount: 0,
      verdictSource: "prose",
      structuredVerdict: null,
    });
  });

  it("reverts on a structured changes_requested verdict even when the prose reads clean", async () => {
    const { projectId, epicId, storyId } = seed("review");
    // The reviewer's markdown says the work is done; its submit_findings call
    // says otherwise. The structured channel is authoritative.
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("**Overall Verdict: Complete** — ship it."),
      duration: 900,
    };
    // Stands in for the mid-session submit_findings write.
    vi.mocked(processManager.start).mockImplementationOnce(
      ((sid: string) => {
        db.update(agentSessions)
          .set({ reviewVerdict: "changes_requested" })
          .where(eq(agentSessions.id, sid))
          .run();
      }) as unknown as typeof processManager.start
    );

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

    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("in_progress");
    expect(
      db.select().from(userStories).where(eq(userStories.id, storyId)).get()!
        .status
    ).toBe("in_progress");

    // Traceability: the activity trail names the channel that decided.
    const reasons = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all()
      .map((a) => a.reason);
    expect(reasons).toContain(
      "Review verdict: changes requested (Code Review) [verdict source: structured]"
    );

    const assessment = await driver.assessReview({
      sessionId: handle.sessionId!,
      stageStartedAt,
    });
    expect(assessment).toMatchObject({
      blocking: true,
      verdictSource: "structured",
      structuredVerdict: "changes_requested",
      usedProseFallback: false,
    });
  });

  it("holds the ticket in review on a structured approved verdict even when the prose reads negative", async () => {
    const { projectId, epicId, storyId } = seed("review");
    processManagerState.result = {
      success: true,
      result: claudeEnvelope(
        "I first thought changes requested, but everything checks out."
      ),
      duration: 900,
    };
    vi.mocked(processManager.start).mockImplementationOnce(
      ((sid: string) => {
        db.update(agentSessions)
          .set({ reviewVerdict: "approved" })
          .where(eq(agentSessions.id, sid))
          .run();
      }) as unknown as typeof processManager.start
    );

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

    // No revert: the prose scan does not get a vote here.
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("review");
    expect(
      db.select().from(userStories).where(eq(userStories.id, storyId)).get()!
        .status
    ).toBe("review");
    const reasons = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all()
      .map((a) => a.reason);
    expect(
      reasons.some((reason) => reason?.startsWith("Review verdict:"))
    ).toBe(false);

    const assessment = await driver.assessReview({
      sessionId: handle.sessionId!,
      stageStartedAt,
    });
    expect(assessment).toMatchObject({
      blocking: false,
      verdictSource: "structured",
      structuredVerdict: "approved",
    });
  });

  it("keeps the legacy attempt-3 provider escalation without escalatesTo", async () => {
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
    expect(resolutionMocks.resolveAgentForDispatch).not.toHaveBeenCalled();
    expect(handle.escalatedToNamedAgent).toBeNull();
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

  it("uses the stronger same-provider agent before the alternative provider", async () => {
    const { projectId, epicId } = seed("review");
    const strongerId = `review-stronger-${counter}`;
    const baseId = `review-base-${counter}`;
    db.insert(namedAgents)
      .values([
        {
          id: strongerId,
          name: `Stronger reviewer ${counter}`,
          provider: "claude-code",
          model: "claude-opus-4-6",
        },
        {
          id: baseId,
          name: `Base reviewer ${counter}`,
          provider: "claude-code",
          model: "claude-sonnet-4-6",
          escalatesTo: strongerId,
        },
      ])
      .run();
    const resumedAttemptId = `review-resumed-${counter}`;
    insertSession({
      id: resumedAttemptId,
      projectId,
      epicId,
      provider: "claude-code",
      status: "failed",
      agentType: "review_code",
      namedAgentId: baseId,
    });

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const effortHandle = await driver.launchStage({
      stage: "review",
      attempt: 3,
      fixCycle: 0,
      previousAttemptSessionId: resumedAttemptId,
      lastCodeSessionId: null,
    });

    expect(
      resolutionMocks.pickAlternativeReviewProvider
    ).not.toHaveBeenCalled();
    expect(effortHandle.escalatedToNamedAgent).toBe(
      `Stronger reviewer ${counter}`
    );
    expect(effortHandle.escalatedToProvider).toBeNull();
    expect(
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, effortHandle.sessionId!))
        .get()
    ).toMatchObject({
      provider: "claude-code",
      namedAgentId: strongerId,
      namedAgentName: `Stronger reviewer ${counter}`,
      model: "claude-opus-4-6",
    });
    expect(startOpts().provider).toBe("claude-code");
    await effortHandle.settled;

    const providerHandle = await driver.launchStage({
      stage: "review",
      attempt: 4,
      fixCycle: 0,
      previousAttemptSessionId: effortHandle.sessionId,
      lastCodeSessionId: null,
    });

    expect(
      resolutionMocks.pickAlternativeReviewProvider
    ).toHaveBeenCalledWith("claude-code");
    expect(providerHandle.escalatedToNamedAgent).toBeNull();
    expect(providerHandle.escalatedToProvider).toBe("codex");
    expect(
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, providerHandle.sessionId!))
        .get()
    ).toMatchObject({
      provider: "codex",
      namedAgentId: null,
      model: null,
    });
    expect(startOpts(1).provider).toBe("codex");
    await providerHandle.settled;
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

describe("deterministic verification driver", () => {
  it("returns the strict no-op outcome when verify_commands is not configured", async () => {
    const { projectId, epicId } = seed("review");
    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });

    await expect(
      driver.runDeterministicVerification("unused-session")
    ).resolves.toEqual({ ran: false, result: null });
    expect(verificationMocks.runVerification).not.toHaveBeenCalled();
  });

  it("resolves settings and runs in the recorded epic worktree with the code session attribution", async () => {
    const { projectId, epicId } = seed("review");
    const codeSessionId = `verify-code-${counter}`;
    insertSession({
      id: codeSessionId,
      projectId,
      epicId,
      worktreePath: "/repos/.arij-worktrees/exact-epic-worktree",
    });
    db.insert(settings)
      .values([
        {
          key: verifyCommandsSettingKey(projectId),
          value: JSON.stringify([
            { name: "test", command: "npm test" },
            { name: "lint", command: "npm run lint" },
          ]),
        },
        { key: verifyTimeoutMsSettingKey(projectId), value: "45000" },
      ])
      .run();
    // The applicability path now stats the recorded worktree; the global
    // mock reports nothing exists, so mark this one as present.
    (fsMock.default.existsSync as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (candidate: unknown) =>
        candidate === "/repos/.arij-worktrees/exact-epic-worktree"
    );
    const expected = {
      id: "verify-report",
      projectId,
      epicId,
      agentSessionId: codeSessionId,
      persisted: true,
      status: "pass" as const,
      startedAt: "2026-08-25T10:00:00.000Z",
      finishedAt: "2026-08-25T10:00:02.000Z",
      commands: [
        {
          name: "test",
          command: "npm test",
          exitCode: 0,
          durationMs: 2_000,
          tail: "ok",
        },
      ],
    };
    verificationMocks.runVerification.mockResolvedValueOnce(expected);

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    await expect(
      driver.runDeterministicVerification(codeSessionId)
    ).resolves.toEqual({ ran: true, result: expected });

    // The pipeline announces the finished report the same way the manual
    // route does, so an open EpicDetail panel and the board stay current.
    expect(emitTicketUpdated).toHaveBeenCalledWith(projectId, epicId, {
      verifyReportId: "verify-report",
      verifyStatus: "pass",
    });

    expect(verificationMocks.runVerification).toHaveBeenCalledWith({
      projectId,
      epicId,
      agentSessionId: codeSessionId,
      worktreePath: "/repos/.arij-worktrees/exact-epic-worktree",
      commands: [
        { name: "test", command: "npm test" },
        { name: "lint", command: "npm run lint" },
      ],
      timeoutMs: 45_000,
    });
  });

  it("treats a report that could not be persisted as a skip", async () => {
    const { projectId, epicId } = seed("review");
    const codeSessionId = `verify-lost-${counter}`;
    insertSession({
      id: codeSessionId,
      projectId,
      epicId,
      worktreePath: "/repos/.arij-worktrees/exact-epic-worktree",
    });
    db.insert(settings)
      .values([
        {
          key: verifyCommandsSettingKey(projectId),
          value: JSON.stringify([{ name: "test", command: "npm test" }]),
        },
      ])
      .run();
    (fsMock.default.existsSync as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (candidate: unknown) =>
        candidate === "/repos/.arij-worktrees/exact-epic-worktree"
    );
    verificationMocks.runVerification.mockResolvedValueOnce({
      id: "verify-lost",
      projectId,
      epicId,
      agentSessionId: codeSessionId,
      persisted: false,
      status: "pass" as const,
      startedAt: "2026-08-25T10:00:00.000Z",
      finishedAt: "2026-08-25T10:00:02.000Z",
      commands: [
        { name: "test", command: "npm test", exitCode: 0, durationMs: 5, tail: "ok" },
      ],
    });

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    const outcome = await driver.runDeterministicVerification(codeSessionId);

    // Every durable reader — the merge gate, the panel, the next sweep —
    // reads the table. Announcing "passed" from an in-memory report the
    // table never received would have the two halves disagreeing forever.
    expect(outcome.ran).toBe(false);
    expect(outcome.skipReason).toMatch(/could not be persisted/i);
    expect(emitTicketUpdated).not.toHaveBeenCalled();
  });

  it("does not emit a report event when verification is not configured", async () => {
    const { projectId, epicId } = seed("review");

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });
    await expect(
      driver.runDeterministicVerification("unused-session")
    ).resolves.toEqual({ ran: false, result: null });
    expect(emitTicketUpdated).not.toHaveBeenCalled();
  });

  it("skips verification for a repository checkout recorded as a session worktree", async () => {
    const { projectId, epicId } = seed("review");
    const codeSessionId = `verify-main-checkout-${counter}`;
    insertSession({
      id: codeSessionId,
      projectId,
      epicId,
      worktreePath: "/repos/s",
    });
    db.insert(settings)
      .values({
        key: verifyCommandsSettingKey(projectId),
        value: JSON.stringify([{ name: "test", command: "npm test" }]),
      })
      .run();

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });

    // Hard constraint intact — nothing runs outside a managed epic
    // worktree — but the stage is TOTAL: an applicability fault resolves
    // to "did not apply" with a visible reason instead of crashing into
    // the runner's park path.
    const outcome = await driver.runDeterministicVerification(codeSessionId);
    expect(outcome).toMatchObject({ ran: false, result: null });
    expect(outcome.skipReason).toMatch(/managed epic worktree/i);
    expect(verificationMocks.runVerification).not.toHaveBeenCalled();
    expect(emitTicketUpdated).not.toHaveBeenCalled();
  });

  it("skips with a visible reason when the recorded worktree was pruned", async () => {
    const { projectId, epicId } = seed("review");
    const codeSessionId = `verify-pruned-${counter}`;
    insertSession({
      id: codeSessionId,
      projectId,
      epicId,
      // Managed path, but the global fs mock stats nothing as existing —
      // exactly the pruned-worktree situation.
      worktreePath: "/repos/.arij-worktrees/vanished",
    });
    db.insert(settings)
      .values({
        key: verifyCommandsSettingKey(projectId),
        value: JSON.stringify([{ name: "test", command: "npm test" }]),
      })
      .run();

    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });

    // Spawning into a missing cwd would read as a phantom failing command
    // and burn a fix cycle; it must surface as a traced skip instead.
    const outcome = await driver.runDeterministicVerification(codeSessionId);
    expect(outcome).toMatchObject({ ran: false, result: null });
    expect(outcome.skipReason).toMatch(/no longer exists/i);
    expect(verificationMocks.runVerification).not.toHaveBeenCalled();
  });
});

describe("grading stage dispatch", () => {
  it("returns a successful journalled skip without creating a session when no stories exist", async () => {
    const { projectId, epicId, storyId } = seed("review");
    db.delete(userStories).where(eq(userStories.id, storyId)).run();
    const driver = createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
    });

    const handle = await driver.launchStage({
      stage: "grading",
      attempt: 1,
      fixCycle: 0,
      previousAttemptSessionId: null,
      lastCodeSessionId: "build-complete",
    });

    expect(handle.sessionId).toBeNull();
    await expect(handle.settled).resolves.toMatchObject({
      success: true,
      gradingSkipped: true,
    });
    expect(
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.epicId, epicId))
        .all(),
    ).toHaveLength(0);
    expect(
      db
        .select()
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.epicId, epicId))
        .all(),
    ).toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining("Grading skipped") }),
    );
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
