/**
 * End-to-end verification of the safety guards that make Full Auto Mode
 * trustworthy when nobody is watching.
 *
 * Setup: the REAL engine, the REAL selectors, the REAL settings-backed config
 * resolver, the REAL merge module (with git mocked) and the REAL database.
 * Only the agent dispatch is simulated — by a fake that reproduces the
 * pipeline stage driver's board effects byte-for-byte
 * (lib/pipeline/stages.ts `finalizeCodeSession` / `finalizeReviewSession`),
 * so the loop under test is the real one:
 *
 *   build ok        → epic (and its stories) → review
 *   review negative → epic → in_progress, no agent on it
 *   review positive → epic stays in review
 *   asked_question  → ticket held where it is
 *
 * The four hazards from the design, plus restart behaviour:
 *   1. infinite re-review        — a passing review must review ONCE, then merge
 *   2. bulldozing a question     — asked_question is indistinguishable from
 *                                  "bounced back from review" without the guard
 *   3. coexistence               — a night run must never share a ticket
 *   4. story serialisation       — one story of an epic at a time
 *   5. restart                   — the mode resumes from settings, orphans die
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const gitMocks = vi.hoisted(() => ({
  mergeWorktree: vi.fn(),
  attachWorktree: vi.fn(),
  captureMergeCheckpoint: vi.fn(),
  rollbackMerge: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/git/manager", () => ({
  mergeWorktree: gitMocks.mergeWorktree,
  attachWorktree: gitMocks.attachWorktree,
  captureMergeCheckpoint: gitMocks.captureMergeCheckpoint,
  rollbackMerge: gitMocks.rollbackMerge,
}));

vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => ({ status: "completed", result: { success: true } })),
  },
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  })),
}));

vi.mock("@/lib/events/emit", () => ({
  emitTicketMoved: vi.fn(),
  emitSessionStarted: vi.fn(),
  emitSessionCompleted: vi.fn(),
  emitSessionFailed: vi.fn(),
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
  ticketComments,
  ticketActivityLog,
  reviewComments,
  notifications,
  settings,
  verifyReports,
} = await import("@/lib/db/schema");
const {
  sweepProject,
  defaultAutoModeDeps,
  kickAutoModeForSession,
  cancelPendingKicks,
} = await import("@/lib/auto-mode/engine");
const { markSessionTerminal } = await import("@/lib/agent-sessions/lifecycle");
const { setSessionTerminalHook } = await import(
  "@/lib/agent-sessions/terminal-hooks"
);
const { autoModeRegistry } = await import("@/lib/auto-mode/registry");
const { listAutoModeEnabledProjectIds } = await import("@/lib/auto-mode/config");
const {
  autoModeBuildConcurrencySettingKey,
  autoModeEnabledSettingKey,
  autoModeReviewConcurrencySettingKey,
} = await import("@/lib/auto-mode/constants");
const { handleAskedQuestionOutcome } = await import(
  "@/lib/workflow/agent-question"
);
const { nightRunRegistry } = await import("@/lib/night/registry");
const { cancelOrphanedQueuedSessions, resetBootCleanupGuard } = await import(
  "@/lib/agent-sessions/boot-cleanup"
);

const PROJECT_ID = "proj-e2e";

let clock = 0;
/** Monotonic ISO clock — the freshness guard is temporal, so order matters. */
function tick(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 7, 19, 6, 0, clock)).toISOString();
}

let seq = 0;

/* ------------------------------------------------------------------ */
/* The simulated agent                                                 */
/* ------------------------------------------------------------------ */

interface Dispatched {
  sessionId: string;
  stage: "build" | "review";
  scope: "epic" | "story";
  epicId: string;
  userStoryId: string | null;
}

const dispatched: Dispatched[] = [];

/** Reproduces the driver's dispatch-side board sync. */
async function simulateDispatch(input: {
  projectId: string;
  stage: "build" | "review";
  scope: "epic" | "story";
  epicId: string;
  userStoryId: string | null;
}): Promise<{
  sessionId: string | null;
  error: string | null;
  conflictSessionId: string | null;
}> {
  seq += 1;
  const sessionId = `sim-${input.stage}-${seq}`;

  db.insert(agentSessions)
    .values({
      id: sessionId,
      projectId: input.projectId,
      epicId: input.epicId,
      userStoryId: input.userStoryId,
      status: "running",
      mode: "code",
      agentType:
        input.stage === "review"
          ? "review_code"
          : input.scope === "epic"
            ? "build"
            : "ticket_build",
      branchName: `feature/${input.epicId}`,
      worktreePath: `/tmp/wt/${input.epicId}`,
      batchRunId: `auto_${input.projectId}`,
      createdAt: tick(),
    })
    .run();

  if (input.stage === "build") {
    // Mirror of the driver: epic scope moves the epic to in_progress and
    // stamps the branch; story scope moves the story and stamps the branch.
    if (input.scope === "epic") {
      db.update(epics)
        .set({
          status: "in_progress",
          branchName: `feature/${input.epicId}`,
          updatedAt: tick(),
        })
        .where(eq(epics.id, input.epicId))
        .run();
    } else {
      db.update(userStories)
        .set({ status: "in_progress" })
        .where(eq(userStories.id, input.userStoryId!))
        .run();
      db.update(epics)
        .set({ branchName: `feature/${input.epicId}`, updatedAt: tick() })
        .where(eq(epics.id, input.epicId))
        .run();
    }
  }

  dispatched.push({ sessionId, ...input });
  return { sessionId, error: null, conflictSessionId: null };
}

function finishSession(sessionId: string, outcome: string | null): void {
  db.update(agentSessions)
    .set({ status: "completed", outcome, endedAt: tick() })
    .where(eq(agentSessions.id, sessionId))
    .run();
}

/** Build succeeded: the driver moves epic/stories to review. */
function completeBuild(sessionId: string): void {
  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get()!;
  finishSession(sessionId, "answered");

  if (session.userStoryId) {
    db.update(userStories)
      .set({ status: "review" })
      .where(eq(userStories.id, session.userStoryId))
      .run();
    const siblings = db
      .select()
      .from(userStories)
      .where(eq(userStories.epicId, session.epicId!))
      .all();
    if (
      siblings.every((s) => s.status === "review" || s.status === "done")
    ) {
      db.update(epics)
        .set({ status: "review", updatedAt: tick() })
        .where(eq(epics.id, session.epicId!))
        .run();
    }
    return;
  }

  db.update(userStories)
    .set({ status: "review" })
    .where(eq(userStories.epicId, session.epicId!))
    .run();
  db.update(epics)
    .set({ status: "review", updatedAt: tick() })
    .where(eq(epics.id, session.epicId!))
    .run();
}

/** Review passed: the epic STAYS in review (the pipeline never auto-approves). */
function completeReviewPass(sessionId: string): void {
  finishSession(sessionId, "answered");
  // The approving submit_findings call, as the route persists it. Simulated
  // reviewers run on the default provider (claude-code), which HAS that
  // channel — a pass with nothing on the session row is an unverifiable
  // review, not a clean one (lib/pipeline/findings.ts).
  db.update(agentSessions)
    .set({ reviewVerdict: "approved" })
    .where(eq(agentSessions.id, sessionId))
    .run();
}

/** The reviewer ran but produced no verdict — nothing to approve with. */
function completeReviewSilently(sessionId: string): void {
  finishSession(sessionId, "silent");
}

/** Review rejected: the driver bounces the epic back to in_progress. */
function completeReviewChangesRequested(sessionId: string): void {
  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get()!;
  finishSession(sessionId, "answered");
  db.update(agentSessions)
    .set({ reviewVerdict: "changes_requested" })
    .where(eq(agentSessions.id, sessionId))
    .run();
  db.update(epics)
    .set({ status: "in_progress", updatedAt: tick() })
    .where(eq(epics.id, session.epicId!))
    .run();
  db.update(userStories)
    .set({ status: "in_progress" })
    .where(eq(userStories.epicId, session.epicId!))
    .run();
}

/** The agent asked the user something: the ticket is HELD where it is. */
function askQuestion(sessionId: string): void {
  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get()!;
  finishSession(sessionId, "asked_question");
  handleAskedQuestionOutcome({
    projectId: session.projectId,
    epicIds: [session.epicId],
    sessionId,
    ticketStatus: "in_progress",
  });
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function deps(overrides = {}) {
  return {
    ...defaultAutoModeDeps,
    dispatch: (input: Parameters<typeof simulateDispatch>[0]) =>
      simulateDispatch(input),
    ...overrides,
  } as typeof defaultAutoModeDeps;
}

function arm(build: number, review: number): void {
  db.insert(settings)
    .values([
      {
        key: autoModeEnabledSettingKey(PROJECT_ID),
        value: JSON.stringify(true),
      },
      {
        key: autoModeBuildConcurrencySettingKey(PROJECT_ID),
        value: JSON.stringify(build),
      },
      {
        key: autoModeReviewConcurrencySettingKey(PROJECT_ID),
        value: JSON.stringify(review),
      },
    ])
    .run();
}

function addEpic(id: string, status: string, position = 0): void {
  db.insert(epics)
    .values({
      id,
      projectId: PROJECT_ID,
      title: id,
      status,
      position,
      readableId: `E-${id}`,
      createdAt: tick(),
      updatedAt: tick(),
    })
    .run();
}

function addStory(id: string, epicId: string, position: number): void {
  db.insert(userStories)
    .values({
      id,
      epicId,
      title: id,
      status: "todo",
      position,
      createdAt: tick(),
    })
    .run();
}

function epicStatus(id: string): string | null {
  return (
    db.select().from(epics).where(eq(epics.id, id)).get()?.status ?? null
  );
}

function reviewSessionsFor(epicId: string): unknown[] {
  return db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.epicId, epicId),
        eq(agentSessions.agentType, "review_code")
      )
    )
    .all();
}

beforeEach(() => {
  db.delete(notifications).run();
  db.delete(ticketComments).run();
  db.delete(ticketActivityLog).run();
  db.delete(reviewComments).run();
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  db.delete(settings).run();
  db.delete(verifyReports).run();
  autoModeRegistry.resetAll();
  dispatched.length = 0;
  gitMocks.mergeWorktree.mockReset();
  gitMocks.mergeWorktree.mockResolvedValue({ merged: true, commitHash: "c1" });
  gitMocks.attachWorktree.mockReset();
  gitMocks.attachWorktree.mockImplementation(
    async (_repo: string, branchName: string) => ({
      worktreePath: `/tmp/wt/${branchName}`,
      branchName,
    })
  );
  gitMocks.captureMergeCheckpoint.mockReset();
  gitMocks.captureMergeCheckpoint.mockResolvedValue({
    mainBranch: "main",
    mainHead: "main-head",
    branchName: "feature/e1",
    branchHead: "branch-head",
  });
  gitMocks.rollbackMerge.mockReset();
  gitMocks.rollbackMerge.mockResolvedValue({ restored: true });

  db.insert(projects)
    .values({ id: PROJECT_ID, name: "E2E", gitRepoPath: "/repos/e2e" })
    .run();
});

/* ------------------------------------------------------------------ */
/* 1. The manual run                                                   */
/* ------------------------------------------------------------------ */

describe("manual run: 3 todo + 1 review, build 2 / review 1", () => {
  it("dispatches exactly 2 builders and 1 reviewer and leaves the third epic waiting", async () => {
    arm(2, 1);
    addEpic("t1", "todo", 0);
    addEpic("t2", "todo", 1);
    addEpic("t3", "todo", 2);
    addEpic("r1", "review", 3);
    db.insert(agentSessions)
      .values({
        id: "prior-build",
        projectId: PROJECT_ID,
        epicId: "r1",
        status: "completed",
        agentType: "build",
        createdAt: tick(),
        endedAt: tick(),
      })
      .run();

    const result = await sweepProject(PROJECT_ID, deps());

    expect(result.buildsDispatched).toHaveLength(2);
    expect(result.reviewsDispatched).toHaveLength(1);
    expect(
      dispatched.filter((d) => d.stage === "build").map((d) => d.epicId)
    ).toEqual(["t1", "t2"]);
    expect(epicStatus("t3")).toBe("todo");

    // A second sweep changes nothing while the budgets are full.
    const again = await sweepProject(PROJECT_ID, deps());
    expect(again.buildsDispatched).toEqual([]);
    expect(again.reviewsDispatched).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The bounce loop                                                  */
/* ------------------------------------------------------------------ */

describe("bounce loop", () => {
  it("re-picks an epic a negative review sent back to in_progress, with no manual action", async () => {
    arm(1, 1);
    addEpic("e1", "todo");

    const first = await sweepProject(PROJECT_ID, deps());
    completeBuild(first.buildsDispatched[0]);
    expect(epicStatus("e1")).toBe("review");

    const second = await sweepProject(PROJECT_ID, deps());
    expect(second.reviewsDispatched).toHaveLength(1);
    completeReviewChangesRequested(second.reviewsDispatched[0]);
    expect(epicStatus("e1")).toBe("in_progress");

    const third = await sweepProject(PROJECT_ID, deps());
    expect(third.buildsDispatched).toHaveLength(1);
    expect(epicStatus("e1")).toBe("in_progress");
  });
});

/* ------------------------------------------------------------------ */
/* 3. The re-review guard                                              */
/* ------------------------------------------------------------------ */

describe("re-review guard", () => {
  it("reviews a passing epic exactly once, then merges it", async () => {
    arm(1, 1);
    addEpic("e1", "todo");

    const s1 = await sweepProject(PROJECT_ID, deps());
    completeBuild(s1.buildsDispatched[0]);

    const s2 = await sweepProject(PROJECT_ID, deps());
    expect(s2.reviewsDispatched).toHaveLength(1);
    completeReviewPass(s2.reviewsDispatched[0]);

    // The epic is STILL in review — a naive selector would review it forever.
    expect(epicStatus("e1")).toBe("review");

    const s3 = await sweepProject(PROJECT_ID, deps());
    expect(s3.reviewsDispatched).toEqual([]);
    expect(s3.merged).toEqual(["e1"]);
    expect(reviewSessionsFor("e1")).toHaveLength(1);
    expect(epicStatus("e1")).toBe("done");

    // And nothing at all on the sweep after that.
    const s4 = await sweepProject(PROJECT_ID, deps());
    expect(s4.merged).toEqual([]);
    expect(s4.reviewsDispatched).toEqual([]);
    expect(reviewSessionsFor("e1")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 3b. Deterministic verification end to end                           */
/* ------------------------------------------------------------------ */

/**
 * Full Auto does not run lib/pipeline/runner.ts, so the pipeline's
 * build → verify → review ordering is not inherited: the engine runs the
 * checks itself in `reconcileInFlight`, and lib/auto-mode/merge.ts refuses to
 * merge without a fresh PASSING report.
 *
 * Those two halves have to be tested TOGETHER. Tested apart, a gate nothing
 * can satisfy still looks correct: it refuses, it logs, it does not park —
 * and the epic never completes. These sweeps are the only place that shows
 * the loop closing.
 */
describe("deterministic verification", () => {
  function configureVerification(): void {
    db.insert(settings)
      .values({
        key: "verify_commands",
        value: JSON.stringify([{ name: "test", command: "npm test" }]),
      })
      .run();
  }

  /**
   * Stands in for lib/verify/runner.ts (which would spawn `npm test`) while
   * writing the same `verify_reports` row the real one persists — the row the
   * merge gate reads.
   */
  function verifier(status: "pass" | "fail") {
    return async (input: {
      projectId: string;
      epicId: string;
      sessionId: string;
    }) => {
      const commands = [
        {
          name: "test",
          command: "npm test",
          exitCode: status === "pass" ? 0 : 1,
          durationMs: 12,
          tail: status === "pass" ? "ok" : "FAIL __tests__/x.test.ts",
        },
      ];
      const report = {
        id: `vr-${(seq += 1)}`,
        projectId: input.projectId,
        epicId: input.epicId,
        agentSessionId: input.sessionId,
        status,
        startedAt: tick(),
        finishedAt: tick(),
        commands,
      };
      db.insert(verifyReports)
        .values({ ...report, commands: JSON.stringify(commands) })
        .run();
      return { ran: true, result: report };
    };
  }

  it("builds, verifies, reviews and merges an epic with verification configured", async () => {
    arm(1, 1);
    configureVerification();
    addEpic("e1", "todo");
    const withVerify = deps({ runDeterministicVerification: verifier("pass") });

    const s1 = await sweepProject(PROJECT_ID, withVerify);
    completeBuild(s1.buildsDispatched[0]);

    // Reconciling the delivered build is what runs the checks.
    const s2 = await sweepProject(PROJECT_ID, withVerify);
    expect(db.select().from(verifyReports).all()).toHaveLength(1);
    expect(s2.reviewsDispatched).toHaveLength(1);
    completeReviewPass(s2.reviewsDispatched[0]);

    const s3 = await sweepProject(PROJECT_ID, withVerify);
    expect(s3.merged).toEqual(["e1"]);
    expect(epicStatus("e1")).toBe("done");
  });

  it("never merges an epic whose checks fail, and rebuilds it instead", async () => {
    arm(1, 1);
    configureVerification();
    addEpic("e1", "todo");
    const withVerify = deps({ runDeterministicVerification: verifier("fail") });

    const s1 = await sweepProject(PROJECT_ID, withVerify);
    completeBuild(s1.buildsDispatched[0]);
    expect(epicStatus("e1")).toBe("review");

    // Red branch: back to In Progress, no review dispatched, nothing merged.
    const s2 = await sweepProject(PROJECT_ID, withVerify);
    expect(epicStatus("e1")).toBe("in_progress");
    expect(s2.reviewsDispatched).toEqual([]);
    expect(s2.merged).toEqual([]);
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
    // And the loop closes: the same sweep re-dispatches a build.
    expect(s2.buildsDispatched).toHaveLength(1);
  });

  it("holds back an epic it cannot verify instead of logging a refusal every sweep", async () => {
    arm(1, 1);
    configureVerification();
    addEpic("e1", "review", 0);
    db.insert(agentSessions)
      .values({
        id: "prior-build",
        projectId: PROJECT_ID,
        epicId: "e1",
        status: "completed",
        agentType: "build",
        outcome: "answered",
        createdAt: tick(),
        endedAt: tick(),
      })
      .run();
    db.update(epics).set({ branchName: "feature/e1" }).run();

    const s1 = await sweepProject(PROJECT_ID, deps());
    completeReviewPass(s1.reviewsDispatched[0]);

    // An epic built before verification existed has no report, and this mode
    // never produced one for it. The merge is refused — once — and deferred.
    const s2 = await sweepProject(PROJECT_ID, deps());
    expect(s2.merged).toEqual([]);
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
    const refusals = () =>
      db
        .select()
        .from(ticketActivityLog)
        .all()
        .filter((row) => (row.reason ?? "").includes("skipped merge")).length;
    expect(refusals()).toBe(1);

    // The next sweeps must not re-refuse: without the backoff this is one
    // activity row every 15 seconds, forever.
    await sweepProject(PROJECT_ID, deps());
    await sweepProject(PROJECT_ID, deps());
    expect(refusals()).toBe(1);
    expect(autoModeRegistry.isParked(PROJECT_ID, "e1")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 4. The question guard                                               */
/* ------------------------------------------------------------------ */

describe("question guard", () => {
  it("leaves an epic that asked a question untouched until the user replies", async () => {
    arm(2, 0);
    addEpic("e1", "todo");

    const first = await sweepProject(PROJECT_ID, deps());
    askQuestion(first.buildsDispatched[0]);
    expect(epicStatus("e1")).toBe("in_progress");

    // Indistinguishable from "bounced back from review" without the guard.
    const second = await sweepProject(PROJECT_ID, deps());
    expect(second.buildsDispatched).toEqual([]);
    expect(epicStatus("e1")).toBe("in_progress");

    db.insert(ticketComments)
      .values({
        id: "reply-1",
        epicId: "e1",
        author: "user",
        content: "use postgres",
        createdAt: tick(),
      })
      .run();

    const third = await sweepProject(PROJECT_ID, deps());
    expect(third.buildsDispatched).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 5. The merge gate                                                   */
/* ------------------------------------------------------------------ */

describe("merge gate", () => {
  it("does not merge an epic with an open review comment, and merges once resolved", async () => {
    arm(1, 1);
    addEpic("e1", "todo");

    const s1 = await sweepProject(PROJECT_ID, deps());
    completeBuild(s1.buildsDispatched[0]);
    const s2 = await sweepProject(PROJECT_ID, deps());
    db.insert(reviewComments)
      .values({
        id: "rc-1",
        epicId: "e1",
        filePath: "lib/a.ts",
        lineNumber: 2,
        body: "[critical] leaks a handle",
        author: "agent",
        status: "open",
        createdAt: tick(),
      })
      .run();
    completeReviewPass(s2.reviewsDispatched[0]);

    const blocked = await sweepProject(PROJECT_ID, deps());
    expect(blocked.merged).toEqual([]);
    expect(epicStatus("e1")).toBe("review");
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
    // A blocked merge is a guard refusal, never a parked ticket.
    expect(autoModeRegistry.isParked(PROJECT_ID, "e1")).toBe(false);

    db.update(reviewComments)
      .set({ status: "resolved" })
      .where(eq(reviewComments.id, "rc-1"))
      .run();

    const merged = await sweepProject(PROJECT_ID, deps());
    expect(merged.merged).toEqual(["e1"]);
    expect(epicStatus("e1")).toBe("done");
  });

  it("parks the epic when the merge conflict survives the merge-fix agent", async () => {
    arm(2, 1);
    addEpic("e1", "todo");

    const s1 = await sweepProject(PROJECT_ID, deps());
    completeBuild(s1.buildsDispatched[0]);
    const s2 = await sweepProject(PROJECT_ID, deps());
    completeReviewPass(s2.reviewsDispatched[0]);

    gitMocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error: "CONFLICT (content): lib/a.ts",
      reason: "conflict",
    });

    const conflicted = await sweepProject(PROJECT_ID, deps());
    expect(conflicted.mergeConflicts).toEqual(["e1"]);
    // The merge-fix agent is charged to the build budget.
    expect(autoModeRegistry.countInFlight(PROJECT_ID).build).toBe(1);

    // Let the merge-fix launch closure and its single retry settle.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(gitMocks.mergeWorktree).toHaveBeenCalledTimes(2);
    expect(autoModeRegistry.isParked(PROJECT_ID, "e1")).toBe(true);
    expect(db.select().from(notifications).all()).toHaveLength(1);

    const after = await sweepProject(PROJECT_ID, deps());
    expect(after.merged).toEqual([]);
    expect(after.mergeConflicts).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Story granularity                                                */
/* ------------------------------------------------------------------ */

describe("story granularity", () => {
  it("builds an epic's 3 stories one at a time, then reviews the epic once", async () => {
    arm(3, 1);
    addEpic("e1", "todo");
    addStory("s1", "e1", 0);
    addStory("s2", "e1", 1);
    addStory("s3", "e1", 2);

    for (const expected of ["s1", "s2", "s3"]) {
      const sweepResult = await sweepProject(PROJECT_ID, deps());
      // A budget of 3 does NOT mean 3 stories of one epic in parallel: the
      // parent-epic guard serialises them.
      expect(sweepResult.buildsDispatched).toHaveLength(1);
      const last = dispatched[dispatched.length - 1];
      expect(last).toMatchObject({ scope: "story", userStoryId: expected });
      completeBuild(last.sessionId);
    }

    // All stories review/done → the epic flipped to review.
    expect(epicStatus("e1")).toBe("review");

    const reviewSweep = await sweepProject(PROJECT_ID, deps());
    expect(reviewSweep.reviewsDispatched).toHaveLength(1);
    expect(dispatched[dispatched.length - 1]).toMatchObject({
      stage: "review",
      scope: "epic",
      epicId: "e1",
    });
    completeReviewPass(reviewSweep.reviewsDispatched[0]);
    expect(reviewSessionsFor("e1")).toHaveLength(1);
  });

  it("runs many epics in parallel while serialising each epic's stories", async () => {
    arm(4, 0);
    addEpic("a", "todo", 0);
    addStory("a1", "a", 0);
    addStory("a2", "a", 1);
    addEpic("b", "todo", 1);
    addStory("b1", "b", 0);
    addStory("b2", "b", 1);

    const result = await sweepProject(PROJECT_ID, deps());
    expect(result.buildsDispatched).toHaveLength(2);
    expect(dispatched.map((d) => d.userStoryId).sort()).toEqual(["a1", "b1"]);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Coexistence                                                      */
/* ------------------------------------------------------------------ */

describe("coexistence with other autonomous runs", () => {
  it("never puts a second agent on a ticket a night run owns", async () => {
    arm(3, 0);
    addEpic("night-epic", "todo", 0);
    addEpic("free-epic", "todo", 1);

    nightRunRegistry.register({
      runId: "night_e2e",
      projectId: PROJECT_ID,
      failurePolicy: "halt",
      breakerThreshold: 0,
      costCapUsd: null,
      state: "running",
      startedAt: tick(),
      endedAt: null,
      currentWave: 1,
      totalWaves: 1,
      totalEpics: 1,
      counts: {
        pending: 0,
        running: 1,
        done: 0,
        asked: 0,
        failed: 0,
        skipped: 0,
      },
      epics: [
        {
          epicId: "night-epic",
          pipelineRunId: "run-1",
          status: "running",
          reason: null,
        },
      ],
      stopRequested: false,
      abortReason: null,
      abortedAtWave: null,
    });

    try {
      const result = await sweepProject(PROJECT_ID, deps());
      expect(result.buildsDispatched).toHaveLength(1);
      expect(dispatched[0].epicId).toBe("free-epic");
    } finally {
      nightRunRegistry.finish("night_e2e");
    }
  });

  it("never puts a second agent on a ticket a manual dispatch already took", async () => {
    arm(3, 0);
    addEpic("busy", "todo", 0);
    addEpic("free", "todo", 1);
    // A human clicked Build a moment ago: the row is still queued.
    db.insert(agentSessions)
      .values({
        id: "manual-1",
        projectId: PROJECT_ID,
        epicId: "busy",
        status: "queued",
        agentType: "build",
        createdAt: tick(),
      })
      .run();

    const result = await sweepProject(PROJECT_ID, deps());
    expect(result.buildsDispatched).toHaveLength(1);
    expect(dispatched[0].epicId).toBe("free");
  });
});

/* ------------------------------------------------------------------ */
/* 7a. The last-moment dispatch guards (real driver probe)             */
/* ------------------------------------------------------------------ */

describe("last-moment guards use the real driver probe", () => {
  /**
   * These two use the REAL dispatcher — the guard lives inside it, and a
   * guard refusal returns before `launchStage`, so nothing is ever spawned.
   * The activity log distinguishes the two possible outcomes: a refusal logs
   * "Auto mode skipped build:", while a dispatch that got through and then
   * blew up logs "Auto mode build dispatch failed:".
   */
  function autoReasons(epicId: string): string[] {
    return db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all()
      .map((row) => row.reason ?? "");
  }

  it("refuses a build onto an epic a human approved between snapshot and dispatch", async () => {
    arm(1, 0);
    addEpic("e1", "todo");

    // A board snapshot taken while the epic was still `todo`, then the epic
    // moves — exactly the window a human clicking Approve occupies.
    const board = defaultAutoModeDeps.loadBoard(PROJECT_ID);
    db.update(epics).set({ status: "done" }).where(eq(epics.id, "e1")).run();

    const result = await sweepProject(PROJECT_ID, {
      ...defaultAutoModeDeps,
      loadBoard: () => board,
    });

    expect(result.buildsDispatched).toEqual([]);
    // The build closure would otherwise have dragged it back to in_progress.
    expect(epicStatus("e1")).toBe("done");
    expect(
      autoReasons("e1").some((reason) =>
        reason.startsWith("Auto mode skipped build:")
      )
    ).toBe(true);
    expect(
      autoReasons("e1").some((reason) => reason.includes("dispatch failed"))
    ).toBe(false);
    expect(
      db.select().from(agentSessions).all().filter((s) => s.epicId === "e1")
    ).toEqual([]);
  });

  it("refuses a story build when the parent epic has been released", async () => {
    arm(1, 0);
    addEpic("e1", "todo");
    addStory("s1", "e1", 0);

    const board = defaultAutoModeDeps.loadBoard(PROJECT_ID);
    db.update(epics).set({ status: "released" }).where(eq(epics.id, "e1")).run();

    const result = await sweepProject(PROJECT_ID, {
      ...defaultAutoModeDeps,
      loadBoard: () => board,
    });

    // checkGuards reports the STORY's status for story scope, so the parent
    // epic needs a check of its own.
    expect(result.buildsDispatched).toEqual([]);
    expect(
      autoReasons("e1").some((reason) =>
        reason.startsWith("Auto mode skipped build: parent epic is released")
      )
    ).toBe(true);
    expect(
      db.select().from(agentSessions).all().filter((s) => s.epicId === "e1")
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 7b. The terminal-hook race                                          */
/* ------------------------------------------------------------------ */

describe("terminal-hook kick ordering", () => {
  /**
   * Reproduces the exact shape of the dispatch closures: `markSessionTerminal`
   * — which fires the session terminal hook SYNCHRONOUSLY — followed, in the
   * same synchronous block, by the ticket updates
   * (lib/pipeline/stages.ts `finalizeReviewSession`).
   */
  function settleReviewLikeTheDriver(
    sessionId: string,
    apply: () => void
  ): void {
    markSessionTerminal(
      sessionId,
      { success: true, outcome: "answered" },
      tick()
    );
    apply();
  }

  function seedReviewInFlight(): string {
    // Build → review already happened; the reviewer is running.
    addEpic("e1", "review");
    db.update(epics)
      .set({ branchName: "feature/e1" })
      .where(eq(epics.id, "e1"))
      .run();
    db.insert(agentSessions)
      .values({
        id: "build-1",
        projectId: PROJECT_ID,
        epicId: "e1",
        status: "completed",
        agentType: "build",
        outcome: "answered",
        createdAt: tick(),
        endedAt: tick(),
      })
      .run();
    db.insert(agentSessions)
      .values({
        id: "review-1",
        projectId: PROJECT_ID,
        epicId: "e1",
        status: "running",
        agentType: "review_code",
        startedAt: tick(),
        createdAt: tick(),
      })
      .run();
    return "review-1";
  }

  beforeEach(() => {
    setSessionTerminalHook((event) => kickAutoModeForSession(event.sessionId));
  });

  afterEach(() => {
    setSessionTerminalHook(null);
    cancelPendingKicks();
  });

  it("does NOT merge an epic whose negative review has not been applied yet", async () => {
    vi.useFakeTimers();
    try {
      // Merges only — this is about the merge gate, not about dispatch.
      arm(0, 0);
      const sessionId = seedReviewInFlight();

      settleReviewLikeTheDriver(sessionId, () => {
        // The driver's revert: a "changes requested" verdict bounces the epic.
        db.update(epics)
          .set({ status: "in_progress" })
          .where(eq(epics.id, "e1"))
          .run();
      });

      await vi.advanceTimersByTimeAsync(600);

      // Between markSessionTerminal and this revert, the epic looked exactly
      // like a clean review: in `review`, a completed reviewer newer than the
      // build, no open findings. A sweep running inside the hook would have
      // merged a REJECTED epic into main.
      expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
      expect(epicStatus("e1")).toBe("in_progress");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still merges promptly when the review really did pass", async () => {
    vi.useFakeTimers();
    try {
      arm(0, 0);
      const sessionId = seedReviewInFlight();

      // A passing review leaves the epic in `review` — the only thing to
      // apply is the approving verdict submit_findings persisted on the
      // session, without which the review would not count as clean.
      settleReviewLikeTheDriver(sessionId, () => {
        db.update(agentSessions)
          .set({ reviewVerdict: "approved" })
          .where(eq(agentSessions.id, sessionId))
          .run();
      });

      await vi.advanceTimersByTimeAsync(600);

      expect(gitMocks.mergeWorktree).toHaveBeenCalledTimes(1);
      expect(epicStatus("e1")).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 8. Restart                                                          */
/* ------------------------------------------------------------------ */

describe("restart behaviour", () => {
  it("resumes from settings with an empty in-flight set and cancels orphans", async () => {
    arm(2, 0);
    addEpic("e1", "todo", 0);
    addEpic("e2", "todo", 1);

    const before = await sweepProject(PROJECT_ID, deps());
    expect(before.buildsDispatched).toHaveLength(2);
    // Simulate the sessions the dead process left behind.
    db.update(agentSessions)
      .set({ status: "queued" })
      .where(eq(agentSessions.id, before.buildsDispatched[0]))
      .run();

    // --- process restart: in-memory state dies, settings survive ---
    autoModeRegistry.resetAll();
    expect(listAutoModeEnabledProjectIds()).toEqual([PROJECT_ID]);

    resetBootCleanupGuard();
    expect(cancelOrphanedQueuedSessions()).toBe(1);
    expect(
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, before.buildsDispatched[0]))
        .get()!.status
    ).toBe("cancelled");

    // The cancelled epic is free again; the still-running one is not.
    const after = await sweepProject(PROJECT_ID, deps());
    expect(after.buildsDispatched).toHaveLength(1);
    expect(dispatched[dispatched.length - 1].epicId).toBe("e1");
  });

  it("stays off after a restart when the setting says off", async () => {
    db.insert(settings)
      .values({
        key: autoModeEnabledSettingKey(PROJECT_ID),
        value: JSON.stringify(false),
      })
      .run();
    addEpic("e1", "todo");

    autoModeRegistry.resetAll();
    expect(listAutoModeEnabledProjectIds()).toEqual([]);
    const result = await sweepProject(PROJECT_ID, deps());
    expect(result.skipped).toBe("disabled");
    expect(dispatched).toEqual([]);
  });
});
