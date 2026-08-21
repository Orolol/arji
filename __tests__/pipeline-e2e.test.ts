/**
 * End-to-end tests for the autonomous pipeline: the REAL epic build route,
 * startPipelineRun glue, runner engine, stage drivers (stages.ts), findings
 * assessment, forensic module, scheduler, and session lifecycle — all against
 * a fully-migrated createTestDb. The only fake is the CLI itself: the process
 * manager serves scripted per-session results in dispatch order (the
 * wave-runner test pattern), with per-script side effects standing in for
 * mid-session agent behavior (a reviewer filing findings via submit_findings,
 * a user stopping a live session).
 *
 * Scenarios:
 *   (a) build success → review clean → pipeline succeeded, ticket left in
 *       review (never auto-approved),
 *   (b) build success → review files a [critical] finding → fix RESUMES the
 *       build session → re-review clean (old open finding outside the second
 *       stage window) → succeeded with exactly one fix cycle,
 *   (c) build fails → retry resumes the failed attempt → fails → escalated
 *       provider (fresh, no resume) → fails → forensic diagnostic comment
 *       posted, run failed, attempt cap respected,
 *   (d) review asks a question → run pauses terminally, ticket held where it
 *       is, notification created, no further sessions,
 *   (e) user stops the live review session → clean cancel, no orphan stages.
 *
 * Each scenario asserts the epic's ticketActivityLog reads as one coherent
 * story (route board-sync entries interleaved with the pipeline trace).
 *
 * TIMING: the suite runs under fake timers. Every scripted CLI run spawns as
 * 'running' and flips to its terminal status ~40 fake-ms later, so a stage's
 * terminal effects always land AFTER its dispatch-time writes — exactly like
 * a real multi-second CLI run, and unlike an instantly-completing mock whose
 * microtask interleaving with the runner is hop-count trivia. The launch
 * closures observe the flip through waitForProcessCompletion's real 2s poll;
 * `drain()` advances the fake clock (Date included, which keeps the findings
 * window semantics of scenario (b) deterministic) until the watched promise
 * or predicate settles.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

/** One scripted CLI run, consumed FIFO by processManager.start. */
interface ScriptedCliRun {
  /** Debug label so an exhausted/misaligned queue is diagnosable. */
  label: string;
  /** ClaudeResult-shaped payload getStatus serves alongside the status. */
  result: Record<string, unknown> | undefined;
  /** Mutable status served by getStatus (flipped to simulate completion). */
  statusRef: { value: string };
  /** Status the auto-flip timer applies ~40 fake-ms after spawn. */
  flipTo: string | null;
  /** Side effect at spawn time (reviewer files findings, user stops, …). */
  onStart?: (sessionId: string) => void;
}

const cliState = vi.hoisted(() => ({
  queue: [] as Array<{
    label: string;
    result: Record<string, unknown> | undefined;
    statusRef: { value: string };
    flipTo: string | null;
    onStart?: (sessionId: string) => void;
  }>,
  bySession: new Map<
    string,
    {
      label: string;
      result: Record<string, unknown> | undefined;
      statusRef: { value: string };
    }
  >(),
  starts: [] as Array<{
    sessionId: string;
    opts: Record<string, unknown>;
    provider: string;
    label: string;
  }>,
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
    start: vi.fn((sessionId: string, opts: unknown, provider: string) => {
      const script = cliState.queue.shift();
      if (!script) {
        throw new Error("pipeline-e2e: CLI script queue exhausted");
      }
      cliState.bySession.set(sessionId, script);
      cliState.starts.push({
        sessionId,
        opts: opts as Record<string, unknown>,
        provider,
        label: script.label,
      });
      script.onStart?.(sessionId);
      // The "CLI run": stays 'running' for ~40 fake-ms, then reaches its
      // scripted terminal status (unless the script manages status itself).
      if (script.flipTo) {
        setTimeout(() => {
          if (script.statusRef.value === "running") {
            script.statusRef.value = script.flipTo!;
          }
        }, 40);
      }
    }),
    getStatus: vi.fn((sessionId: string) => {
      const script = cliState.bySession.get(sessionId);
      if (!script) return undefined;
      return { status: script.statusRef.value, result: script.result };
    }),
    cancel: vi.fn(),
  },
}));

// Every stage dispatch awaits the worktree; the 3ms pause guarantees the
// (fake) wall clock advances between one review stage's findings and the
// next stage's window start, keeping the window-semantics assertion of
// scenario (b) deterministic.
vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 3));
    return { worktreePath: "/tmp/worktree-e2e", branchName: "feature/e2e" };
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
  notifications,
  settings,
} = await import("@/lib/db/schema");
const { POST: epicBuildPost } = await import(
  "@/app/api/projects/[projectId]/epics/[epicId]/build/route"
);
const { pipelineRegistry } = await import("@/lib/pipeline");
const { PIPELINE_REASONS, pipelineMaxAttemptsSettingKey } = await import(
  "@/lib/pipeline/constants"
);
const { PIPELINE_FIX_INSTRUCTIONS_SECTION } = await import(
  "@/lib/pipeline/stages"
);
const { FORENSIC_COMMENT_HEADING } = await import("@/lib/pipeline/forensic");
const { AGENT_ASKED_QUESTION_REASON } = await import(
  "@/lib/workflow/agent-question"
);
const { agentScheduler } = await import("@/lib/agents/scheduler");
const { markSessionCancelled } = await import("@/lib/agent-sessions/lifecycle");
const { processManager } = await import("@/lib/claude/process-manager");
import type { PipelineRunSnapshot } from "@/lib/pipeline/constants";

let counter = 0;

/* ------------------------------------------------------------------ */
/* Harness helpers                                                     */
/* ------------------------------------------------------------------ */

function claudeEnvelope(text: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result: text });
}

function cliOk(
  text: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { success: true, result: claudeEnvelope(text), duration: 700, ...extra };
}

function cliFail(error: string): Record<string, unknown> {
  return { success: false, error, duration: 300 };
}

/**
 * Queues one scripted CLI run. It spawns 'running' and auto-flips to
 * `flipTo` ("completed" by default, matching the ClaudeResult's success flag
 * semantics being carried in `result`) ~40 fake-ms later; pass
 * `flipTo: null` for scripts that manage their status themselves (the user
 * stop). Returns the script so tests can flip/inspect it.
 */
function scriptRun(
  label: string,
  result: Record<string, unknown> | undefined,
  extra: {
    flipTo?: string | null;
    onStart?: (sessionId: string) => void;
  } = {}
): ScriptedCliRun {
  const script: ScriptedCliRun = {
    label,
    result,
    statusRef: { value: "running" },
    flipTo: extra.flipTo === undefined ? "completed" : extra.flipTo,
    onStart: extra.onStart,
  };
  cliState.queue.push(script);
  return script;
}

/**
 * Advances the fake clock (flushing microtasks along the way) until the
 * given promise settles, then returns/throws its outcome. The step is
 * coarse; ordering stays exact because sinon executes timers in due-time
 * order within an advance.
 */
async function drain<T>(promise: Promise<T>, maxFakeMs = 120_000): Promise<T> {
  const state: {
    done: boolean;
    ok: boolean;
    value: T | undefined;
    error: unknown;
  } = { done: false, ok: false, value: undefined, error: undefined };
  promise.then(
    (value) => {
      state.done = true;
      state.ok = true;
      state.value = value;
    },
    (error) => {
      state.done = true;
      state.error = error;
    }
  );
  let advanced = 0;
  while (!state.done && advanced < maxFakeMs) {
    await vi.advanceTimersByTimeAsync(250);
    advanced += 250;
  }
  if (!state.done) {
    throw new Error(`pipeline-e2e: promise did not settle within ${maxFakeMs} fake ms`);
  }
  if (!state.ok) throw state.error;
  return state.value as T;
}

/** Advances the fake clock until the predicate returns a truthy value. */
async function drainUntil<T>(
  predicate: () => T | null | undefined | false,
  what: string,
  maxFakeMs = 120_000
): Promise<T> {
  let advanced = 0;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (advanced >= maxFakeMs) {
      throw new Error(`pipeline-e2e: ${what} not reached within ${maxFakeMs} fake ms`);
    }
    await vi.advanceTimersByTimeAsync(250);
    advanced += 250;
  }
}

function seed() {
  counter += 1;
  const projectId = `proj-e2e-${counter}`;
  const epicId = `epic-e2e-${counter}`;
  const storyId = `story-e2e-${counter}`;

  db.insert(projects)
    .values({ id: projectId, name: "E2E Project", gitRepoPath: "/repos/e2e" })
    .run();
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Token auth epic",
      status: "todo",
      position: 0,
      readableId: `E-e2e-${counter}`,
    })
    .run();
  db.insert(userStories)
    .values({
      id: storyId,
      epicId,
      title: "Token auth story",
      status: "todo",
      position: 0,
    })
    .run();

  return { projectId, epicId, storyId };
}

async function dispatchPipelineBuild(projectId: string, epicId: string) {
  const res = await drain(
    epicBuildPost(
      mockJsonRequest({ pipeline: true }),
      mockRouteContext({ projectId, epicId })
    )
  );
  expect(res.status).toBe(200);
  const json = await drain(res.json());
  expect(json.data.pipeline?.runId).toBeTruthy();
  return {
    runId: json.data.pipeline.runId as string,
    buildSessionId: json.data.sessionId as string,
  };
}

/** Advances fake time until the run reaches a terminal state. */
async function waitForTerminalRun(runId: string): Promise<PipelineRunSnapshot> {
  const run = await drainUntil(
    () => {
      const snapshot = pipelineRegistry.get(runId);
      return snapshot?.endedAt ? snapshot : null;
    },
    `terminal state of run ${runId}`
  );
  // A little more fake time so the engine promise fully unwinds.
  await vi.advanceTimersByTimeAsync(250);
  return run;
}

function epicActivity(epicId: string) {
  return db
    .select()
    .from(ticketActivityLog)
    .where(eq(ticketActivityLog.epicId, epicId))
    .all();
}

function epicReasons(epicId: string): Array<string | null> {
  return epicActivity(epicId).map((a) => a.reason);
}

function sessionRow(sessionId: string) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get()!;
}

function projectSessions(projectId: string) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.projectId, projectId))
    .all();
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fake timers drive BOTH the poll loops (waitForProcessCompletion, cancel
  // watch) and Date, so scripted CLI durations and findings windows advance
  // deterministically. nextTick/queueMicrotask stay real so plain async
  // plumbing is untouched.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  cliState.queue.length = 0;
  cliState.bySession.clear();
  cliState.starts.length = 0;
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
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* (a) clean pass                                                      */
/* ------------------------------------------------------------------ */

describe("pipeline e2e — clean pass", () => {
  it("build → review clean → succeeded, ticket left in review, coherent trace", async () => {
    const { projectId, epicId, storyId } = seed();
    scriptRun("build", cliOk("Implemented the ticket."));
    scriptRun(
      "review",
      cliOk("**Overall Verdict: Complete** — implementation matches the spec.")
    );

    const { runId, buildSessionId } = await dispatchPipelineBuild(
      projectId,
      epicId
    );
    const run = await waitForTerminalRun(runId);

    expect(run).toMatchObject({
      state: "succeeded",
      reason: null,
      fixCycles: 0,
      projectId,
      epicId,
      userStoryId: null,
    });
    expect(run.sessionIds).toHaveLength(2);
    expect(run.sessionIds[0]).toBe(buildSessionId);

    // The success end-state is REVIEW: the pipeline never auto-approves.
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("review");

    // Both sessions completed; review ran as review_code in plan mode.
    const reviewSessionId = run.sessionIds[1];
    expect(sessionRow(buildSessionId)).toMatchObject({
      status: "completed",
      agentType: "build",
      outcome: "answered",
    });
    expect(sessionRow(reviewSessionId)).toMatchObject({
      status: "completed",
      agentType: "review_code",
      mode: "plan",
    });

    // Labeled review comment on the ticket.
    const comments = db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all();
    expect(
      comments.some((c) => c.content.startsWith("**Code Review**"))
    ).toBe(true);

    // The activity log tells the whole story in order.
    expect(epicReasons(epicId)).toEqual([
      "Build agent started",
      `Story ${storyId} — Build agent started`,
      PIPELINE_REASONS.started,
      `Story ${storyId} — Build completed successfully`,
      "Build completed successfully",
      PIPELINE_REASONS.reviewStarted,
      PIPELINE_REASONS.finished,
    ]);
    // Pipeline entries are actor 'system' with from == to; the board moves
    // belong to the route/stage closures (actor 'agent').
    for (const entry of epicActivity(epicId)) {
      if (entry.reason?.startsWith("Pipeline ")) {
        expect(entry.actor).toBe("system");
        expect(entry.fromStatus).toBe(entry.toStatus);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* (b) findings → fix → clean                                          */
/* ------------------------------------------------------------------ */

describe("pipeline e2e — blocking findings and fix cycle", () => {
  it("review files [critical] → fix resumes the build session → re-review clean → succeeded (1 cycle)", async () => {
    const { projectId, epicId, storyId } = seed();

    scriptRun("build", cliOk("Implemented the ticket."));
    // The reviewer files a structured finding mid-session (submit_findings
    // writes a reviewComments row with an explicit ISO timestamp).
    scriptRun(
      "review-1",
      cliOk("I filed one blocking finding via submit_findings."),
      {
        onStart: () => {
          db.insert(reviewComments)
            .values({
              id: `rc-e2e-${counter}`,
              epicId,
              filePath: "src/auth.ts",
              lineNumber: 7,
              body: "[critical] Token never expires",
              author: "agent",
              status: "open",
              createdAt: new Date().toISOString(),
            })
            .run();
        },
      }
    );
    scriptRun("fix", cliOk("Fixed the token expiry."));
    scriptRun(
      "review-2",
      cliOk("**Overall Verdict: Complete** — the fix addresses the finding.")
    );

    const { runId, buildSessionId } = await dispatchPipelineBuild(
      projectId,
      epicId
    );
    const run = await waitForTerminalRun(runId);

    expect(run).toMatchObject({ state: "succeeded", reason: null });
    expect(run.fixCycles).toBe(1);
    expect(run.sessionIds).toHaveLength(4);

    // Fix stage: build semantics, resumed the initial build session.
    const buildRow = sessionRow(buildSessionId);
    const fixStart = cliState.starts[2];
    expect(fixStart.label).toBe("fix");
    const fixRow = sessionRow(fixStart.sessionId);
    expect(fixRow).toMatchObject({
      agentType: "build",
      mode: "code",
      cliSessionId: buildRow.cliSessionId,
    });
    expect(fixStart.opts).toMatchObject({
      cliSessionId: buildRow.cliSessionId,
      resumeSession: true,
    });
    // The fix prompt carries the open finding verbatim + the pipeline
    // instructions block.
    expect(fixRow.prompt).toContain("## Code Review Feedback");
    expect(fixRow.prompt).toContain("[critical] Token never expires");
    expect(fixRow.prompt).toContain(PIPELINE_FIX_INSTRUCTIONS_SECTION);

    // The pipeline never mutates findings: the row is still open, and the
    // second review passed anyway because the row sits OUTSIDE its stage
    // window (window semantics, not auto-resolution).
    const findingRows = db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.epicId, epicId))
      .all();
    expect(findingRows).toHaveLength(1);
    expect(findingRows[0].status).toBe("open");

    // Ticket ends in review, and the trace reads as one story:
    // dispatch → pipeline start → build done → review → fix cycle
    // (board re-sync + fix trace) → fix done → re-review → finished.
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("review");
    expect(epicReasons(epicId)).toEqual([
      "Build agent started",
      `Story ${storyId} — Build agent started`,
      PIPELINE_REASONS.started,
      `Story ${storyId} — Build completed successfully`,
      "Build completed successfully",
      PIPELINE_REASONS.reviewStarted,
      "Build agent started",
      `Story ${storyId} — Build agent started`,
      PIPELINE_REASONS.fixStarted(1, 2),
      `Story ${storyId} — Build completed successfully`,
      "Build completed successfully",
      PIPELINE_REASONS.reviewStarted,
      PIPELINE_REASONS.finished,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* (c) retry ladder → escalation → forensic                            */
/* ------------------------------------------------------------------ */

describe("pipeline e2e — build failure ladder and forensic hand-off", () => {
  it("fail → resume retry → fail → escalated provider → fail → forensic comment, run failed", async () => {
    const { projectId, epicId, storyId } = seed();
    // Per-project attempt cap 3 (scoped key so other tests keep the default).
    db.insert(settings)
      .values({ key: pipelineMaxAttemptsSettingKey(projectId), value: "3" })
      .run();

    scriptRun("build-1", cliFail("npm test exploded"));
    scriptRun("build-2", cliFail("still exploding"));
    scriptRun("build-3", cliFail("codex also failed"));
    scriptRun(
      "forensic",
      cliOk(
        "**Probable root cause**\n\nThe test runner crashes at import time.\n\n**Evidence**\n\n> npm test exploded\n\n**Recommended next action**\n\nPin the vitest version."
      )
    );

    const { runId, buildSessionId } = await dispatchPipelineBuild(
      projectId,
      epicId
    );
    const run = await waitForTerminalRun(runId);

    expect(run).toMatchObject({
      state: "failed",
      reason: "stage build failed after 3 attempts",
    });
    expect(run.sessionIds).toHaveLength(4);

    // Attempt cap respected: exactly three build sessions, all failed.
    const sessions = projectSessions(projectId);
    const buildSessions = sessions.filter((s) => s.agentType === "build");
    expect(buildSessions).toHaveLength(3);
    for (const s of buildSessions) expect(s.status).toBe("failed");

    // Attempt 2 resumed the dead attempt on the same provider.
    const buildRow = sessionRow(buildSessionId);
    const attempt2 = cliState.starts[1];
    expect(attempt2.label).toBe("build-2");
    expect(attempt2.provider).toBe("claude-code");
    expect(attempt2.opts).toMatchObject({
      cliSessionId: buildRow.cliSessionId,
      resumeSession: true,
    });

    // Attempt 3 escalated: fresh session on the alternative provider, no
    // named agent, no model, no resume (codex cannot resume).
    expect(
      resolutionMocks.pickAlternativeReviewProvider
    ).toHaveBeenCalledWith("claude-code");
    const attempt3 = cliState.starts[2];
    expect(attempt3.label).toBe("build-3");
    expect(attempt3.provider).toBe("codex");
    expect(attempt3.opts.resumeSession).toBe(false);
    expect(attempt3.opts.cliSessionId).toBeUndefined();
    expect(sessionRow(attempt3.sessionId)).toMatchObject({
      provider: "codex",
      namedAgentId: null,
      model: null,
    });

    // Forensic: dispatched on the LAST dead session, ticket-free row (no
    // epicId → the concurrency guards keep the ticket re-dispatchable),
    // diagnostic posted as an agent comment.
    const forensicStart = cliState.starts[3];
    expect(forensicStart.label).toBe("forensic");
    const forensicRow = sessionRow(forensicStart.sessionId);
    expect(forensicRow).toMatchObject({
      agentType: "forensic",
      mode: "plan",
      epicId: null,
      status: "completed",
    });
    expect(forensicRow.prompt).toContain("codex also failed");
    expect(forensicRow.prompt).toContain("Token auth epic");

    const comments = db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all();
    const diagnostic = comments.find((c) =>
      c.content.startsWith(FORENSIC_COMMENT_HEADING)
    );
    expect(diagnostic).toBeTruthy();
    expect(diagnostic!.content).toContain("Probable root cause");
    expect(diagnostic!.agentSessionId).toBe(forensicStart.sessionId);

    // The story: dispatch → pipeline start → retry (resume) → retry
    // (escalation) → stage failure → forensic diagnostic.
    expect(epicReasons(epicId)).toEqual([
      "Build agent started",
      `Story ${storyId} — Build agent started`,
      PIPELINE_REASONS.started,
      "Build failed; ticket held in in_progress: npm test exploded",
      PIPELINE_REASONS.retry("build", 2, 3),
      "Build agent started",
      "Build failed; ticket held in in_progress: still exploding",
      PIPELINE_REASONS.retry("build", 3, 3),
      "Build agent started",
      PIPELINE_REASONS.escalation("build", "codex"),
      "Build failed; ticket held in in_progress: codex also failed",
      PIPELINE_REASONS.failedStage("build", 3),
      PIPELINE_REASONS.forensic,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* (d) review asks a question                                          */
/* ------------------------------------------------------------------ */

describe("pipeline e2e — asked_question pause", () => {
  it("review asks a question → run paused, ticket held in review, no further sessions", async () => {
    const { projectId, epicId, storyId } = seed();
    scriptRun("build", cliOk("Implemented the ticket."));
    scriptRun(
      "review",
      cliOk("Quick question before sign-off: should refresh tokens rotate?", {
        endedWithQuestion: true,
      })
    );

    const { runId } = await dispatchPipelineBuild(projectId, epicId);
    const run = await waitForTerminalRun(runId);

    expect(run).toMatchObject({
      state: "paused_question",
      reason: "agent asked a question (review)",
    });
    expect(run.sessionIds).toHaveLength(2);

    // Ticket held where it was (review), review session classified.
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("review");
    expect(sessionRow(run.sessionIds[1])).toMatchObject({
      agentType: "review_code",
      outcome: "asked_question",
      status: "completed",
    });

    // The user was notified with the asked-question deep link.
    const notifs = db.select().from(notifications).all();
    expect(
      notifs.some(
        (n) =>
          n.projectId === projectId &&
          n.title.startsWith("Agent asked a question")
      )
    ).toBe(true);

    // No fix/retry was ever dispatched.
    expect(cliState.starts).toHaveLength(2);
    expect(cliState.queue).toHaveLength(0);
    expect(projectSessions(projectId)).toHaveLength(2);

    // Story: dispatch → pipeline start → build done → review → the hold
    // (workflow's own entry) → pipeline pause.
    expect(epicReasons(epicId)).toEqual([
      "Build agent started",
      `Story ${storyId} — Build agent started`,
      PIPELINE_REASONS.started,
      `Story ${storyId} — Build completed successfully`,
      "Build completed successfully",
      PIPELINE_REASONS.reviewStarted,
      AGENT_ASKED_QUESTION_REASON,
      PIPELINE_REASONS.pausedQuestion("review"),
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* (e) user stop mid-review                                            */
/* ------------------------------------------------------------------ */

describe("pipeline e2e — user stop mid-review", () => {
  it("stopping the live review session cancels the run cleanly with no orphan stages", async () => {
    const { projectId, epicId, storyId } = seed();
    scriptRun("build", cliOk("Implemented the ticket."));
    // The review spawns live; ~30 fake-ms in, the user hits Stop: replica of
    // the sessions DELETE route (scheduler removal is a no-op for a started
    // session, the process is cancelled, the row goes 'cancelled', and the
    // process manager reports the kill).
    const reviewScript = scriptRun(
      "review",
      cliFail("Cancelled by user"),
      {
        flipTo: null,
        onStart: (sessionId) => {
          expect(sessionRow(sessionId).status).toBe("running");
          setTimeout(() => {
            expect(agentScheduler.remove(sessionId)).toBe(false);
            processManager.cancel(sessionId);
            markSessionCancelled(
              sessionId,
              "Cancelled by user",
              new Date().toISOString()
            );
            reviewScript.statusRef.value = "cancelled";
          }, 30);
        },
      }
    );

    const { runId } = await dispatchPipelineBuild(projectId, epicId);
    const run = await waitForTerminalRun(runId);

    expect(run).toMatchObject({
      state: "cancelled",
      reason: "stopped by user",
    });
    expect(run.sessionIds).toHaveLength(2);

    const reviewSessionId = run.sessionIds[1];
    expect(sessionRow(reviewSessionId).status).toBe("cancelled");

    // No orphan stages: nothing scripted remains, nothing further spawned,
    // no session left holding a scheduler slot, ticket untouched since the
    // build's own sync.
    expect(cliState.starts).toHaveLength(2);
    expect(cliState.queue).toHaveLength(0);
    expect(projectSessions(projectId)).toHaveLength(2);
    expect(agentScheduler.getCounts(projectId)).toEqual({
      running: 0,
      queued: 0,
    });
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("review");

    // Story ends on the stop — and nothing after it.
    expect(epicReasons(epicId)).toEqual([
      "Build agent started",
      `Story ${storyId} — Build agent started`,
      PIPELINE_REASONS.started,
      `Story ${storyId} — Build completed successfully`,
      "Build completed successfully",
      PIPELINE_REASONS.reviewStarted,
      PIPELINE_REASONS.cancelled,
    ]);
  });
});
