/**
 * Integration tests for Full Auto Mode's merge step (lib/auto-mode/merge.ts)
 * against the migrated schema, with git and the CLI spawn mocked and the real
 * scheduler, lifecycle and workflow engine in the loop:
 *
 *   - a clean merge is pure git (no session row, no scheduler slot), moves the
 *     epic to done through applyTransition(source: 'merge'), clears the branch
 *     and re-exports arji.json,
 *   - the engine's `→ done` guards ARE the "review is OK" gate: an open review
 *     comment or a missing completed review blocks the merge, is logged, and
 *     leaves the epic UNPARKED (it retries once the comment is resolved),
 *   - a conflict dispatches one merge-fix agent and retries once; a second
 *     failure parks the epic and raises a notification,
 *   - POST .../approve is never involved (it would bulk-resolve the very
 *     findings that must stop an auto-merge).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

const gitMocks = vi.hoisted(() => ({
  mergeWorktree: vi.fn(),
  attachWorktree: vi.fn(),
  captureMergeCheckpoint: vi.fn(),
  rollbackMerge: vi.fn(),
}));

const processManagerState = vi.hoisted(() => ({
  result: { success: true } as Record<string, unknown> | undefined,
}));

const exportMock = vi.hoisted(() => ({ tryExportArjiJson: vi.fn() }));

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

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: exportMock.tryExportArjiJson,
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => ({
      status: "completed",
      result: processManagerState.result,
    })),
  },
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("merge system prompt"),
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
  agentSessions,
  reviewComments,
  ticketComments,
  ticketActivityLog,
  notifications,
  settings,
  verifyReports,
} = await import("@/lib/db/schema");
const { tryAutoMerge } = await import("@/lib/auto-mode/merge");
const { autoModeRegistry } = await import("@/lib/auto-mode/registry");
const { AUTO_MODE_REASONS, autoRunId } = await import(
  "@/lib/auto-mode/constants"
);

const PROJECT_ID = "proj-merge";
const EPIC_ID = "epic-merge";

let seq = 0;
function isoAt(minute: number): string {
  return new Date(Date.UTC(2026, 7, 19, 9, minute, 0)).toISOString();
}

function seed(options: { withCompletedReview?: boolean } = {}): void {
  db.insert(projects)
    .values({ id: PROJECT_ID, name: "Merge", gitRepoPath: "/repos/merge" })
    .run();
  db.insert(epics)
    .values({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: "Landable epic",
      status: "review",
      branchName: "feature/landable",
      position: 0,
      readableId: "E-merge-1",
      createdAt: isoAt(0),
      updatedAt: isoAt(0),
    })
    .run();

  // The worktree lookup takes the epic's most recent session.
  seq += 1;
  db.insert(agentSessions)
    .values({
      id: `build-${seq}`,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: "completed",
      agentType: "build",
      worktreePath: "/tmp/worktrees/landable",
      createdAt: isoAt(1),
      endedAt: isoAt(2),
    })
    .run();

  if (options.withCompletedReview !== false) {
    seq += 1;
    db.insert(agentSessions)
      .values({
        id: `review-${seq}`,
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        status: "completed",
        agentType: "review_code",
        outcome: "answered",
        worktreePath: "/tmp/worktrees/landable",
        createdAt: isoAt(3),
        endedAt: isoAt(4),
      })
      .run();
  }
}

function activityReasons(): string[] {
  return db
    .select()
    .from(ticketActivityLog)
    .where(eq(ticketActivityLog.epicId, EPIC_ID))
    .all()
    .map((row) => row.reason ?? "");
}

/** Lets the scheduler's launch closure (and its retry) run to completion. */
async function drainScheduler(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  db.delete(notifications).run();
  db.delete(ticketComments).run();
  db.delete(ticketActivityLog).run();
  db.delete(reviewComments).run();
  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(projects).run();
  autoModeRegistry.resetAll();
  gitMocks.mergeWorktree.mockReset();
  gitMocks.attachWorktree.mockReset();
  gitMocks.captureMergeCheckpoint.mockReset();
  gitMocks.rollbackMerge.mockReset();
  // mergeWorktree removes the worktree before merging, so the conflict path
  // has to re-attach one to the surviving branch before dispatching an agent.
  gitMocks.attachWorktree.mockResolvedValue({
    worktreePath: "/tmp/worktrees/landable",
    branchName: "feature/landable",
  });
  gitMocks.captureMergeCheckpoint.mockResolvedValue({
    mainBranch: "main",
    mainHead: "main-head",
    branchName: "feature/landable",
    branchHead: "branch-head",
  });
  gitMocks.rollbackMerge.mockResolvedValue({ restored: true });
  exportMock.tryExportArjiJson.mockReset();
  processManagerState.result = { success: true };
});

/* ------------------------------------------------------------------ */
/* The happy path                                                      */
/* ------------------------------------------------------------------ */

describe("tryAutoMerge — clean merge", () => {
  it("merges as pure git: no session created, no scheduler slot consumed", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({
      merged: true,
      commitHash: "abc123",
    });

    const sessionsBefore = db.select().from(agentSessions).all().length;
    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(outcome).toEqual({
      status: "merged",
      commitHash: "abc123",
      sessionId: null,
    });
    expect(db.select().from(agentSessions).all()).toHaveLength(sessionsBefore);
    expect(gitMocks.mergeWorktree).toHaveBeenCalledWith(
      "/repos/merge",
      "feature/landable",
      "/tmp/worktrees/landable"
    );
  });

  it("moves the epic to done, clears the branch and exports arji.json", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({
      merged: true,
      commitHash: "abc123",
    });

    await tryAutoMerge(PROJECT_ID, EPIC_ID);

    const epic = db.select().from(epics).where(eq(epics.id, EPIC_ID)).get()!;
    expect(epic.status).toBe("done");
    expect(epic.branchName).toBeNull();
    expect(exportMock.tryExportArjiJson).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("logs the transition through applyTransition with the auto-mode reason", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true });

    await tryAutoMerge(PROJECT_ID, EPIC_ID);

    const entry = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, EPIC_ID))
      .all()
      .find((row) => row.reason === AUTO_MODE_REASONS.merged);
    expect(entry).toMatchObject({
      fromStatus: "review",
      toStatus: "done",
      actor: "agent",
    });
  });
});

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

describe("tryAutoMerge — the workflow guards ARE the review gate", () => {
  it("never merges an epic with an open review comment", async () => {
    seed();
    db.insert(reviewComments)
      .values({
        id: "rc-1",
        epicId: EPIC_ID,
        filePath: "lib/x.ts",
        lineNumber: 3,
        body: "[critical] nope",
        author: "agent",
        status: "open",
      })
      .run();
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(outcome.status).toBe("skipped");
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
    expect(
      db.select().from(epics).where(eq(epics.id, EPIC_ID)).get()!.status
    ).toBe("review");
  });

  it("logs the refusal and leaves the epic UNPARKED so it retries later", async () => {
    seed();
    db.insert(reviewComments)
      .values({
        id: "rc-1",
        epicId: EPIC_ID,
        filePath: "lib/x.ts",
        lineNumber: 3,
        body: "[major] nope",
        author: "agent",
        status: "open",
      })
      .run();
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true });

    await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(
      activityReasons().some((reason) =>
        reason.startsWith("Auto mode skipped merge:")
      )
    ).toBe(true);
    expect(autoModeRegistry.isParked(PROJECT_ID, EPIC_ID)).toBe(false);

    // Resolve the finding → the very next attempt merges.
    db.update(reviewComments).set({ status: "resolved" }).run();
    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);
    expect(outcome.status).toBe("merged");
  });

  it("never merges an epic with no completed review", async () => {
    seed({ withCompletedReview: false });
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(outcome.status).toBe("skipped");
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
  });

  it("skips an epic with no branch without touching git", async () => {
    seed();
    db.update(epics).set({ branchName: null }).run();
    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Conflict handling                                                   */
/* ------------------------------------------------------------------ */

describe("tryAutoMerge — merge conflict", () => {
  it("dispatches one merge-fix agent tagged with the auto run id", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValueOnce({
      merged: false,
      error: "CONFLICT in lib/x.ts",
      reason: "conflict",
    });
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true, commitHash: "z9" });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);
    expect(outcome.status).toBe("conflict");
    expect(outcome.sessionId).toBeTruthy();

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, outcome.sessionId!))
      .get()!;
    expect(session).toMatchObject({
      agentType: "merge",
      epicId: EPIC_ID,
      batchRunId: autoRunId(PROJECT_ID),
    });
    expect(session.prompt).toContain("failed to merge into main");
    expect(session.prompt).toContain("/tmp/worktrees/landable");

    await drainScheduler();
  });

  it("retries the merge once after the agent succeeds and lands the epic", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValueOnce({
      merged: false,
      error: "CONFLICT in lib/x.ts",
      reason: "conflict",
    });
    gitMocks.mergeWorktree.mockResolvedValueOnce({
      merged: true,
      commitHash: "fixed1",
    });

    await tryAutoMerge(PROJECT_ID, EPIC_ID);
    await drainScheduler();

    expect(gitMocks.mergeWorktree).toHaveBeenCalledTimes(2);
    const epic = db.select().from(epics).where(eq(epics.id, EPIC_ID)).get()!;
    expect(epic.status).toBe("done");
    expect(epic.branchName).toBeNull();
    expect(activityReasons()).toContain(AUTO_MODE_REASONS.mergeFixRetried);
    expect(autoModeRegistry.isParked(PROJECT_ID, EPIC_ID)).toBe(false);
  });

  it("parks the epic and notifies when the retry also fails", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error: "CONFLICT in lib/x.ts",
      reason: "conflict",
    });

    await tryAutoMerge(PROJECT_ID, EPIC_ID);
    await drainScheduler();

    expect(gitMocks.mergeWorktree).toHaveBeenCalledTimes(2);
    expect(autoModeRegistry.isParked(PROJECT_ID, EPIC_ID)).toBe(true);
    expect(
      db.select().from(epics).where(eq(epics.id, EPIC_ID)).get()!.status
    ).toBe("review");

    const notification = db.select().from(notifications).all()[0];
    expect(notification).toMatchObject({
      projectId: PROJECT_ID,
      agentType: "merge",
      status: "failed",
    });
    expect(notification.title).toContain("Auto mode could not merge");
    expect(notification.targetUrl).toBe(
      `/projects/${PROJECT_ID}?ticket=${EPIC_ID}`
    );
  });

  it("parks without retrying when the merge-fix agent itself fails", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error: "CONFLICT in lib/x.ts",
      reason: "conflict",
    });
    processManagerState.result = { success: false, error: "agent crashed" };

    await tryAutoMerge(PROJECT_ID, EPIC_ID);
    await drainScheduler();

    // Only the initial merge attempt — a crashed agent resolved nothing.
    expect(gitMocks.mergeWorktree).toHaveBeenCalledTimes(1);
    expect(autoModeRegistry.isParked(PROJECT_ID, EPIC_ID)).toBe(true);
  });

  it("restores the worktree mergeWorktree deleted before dispatching the agent", async () => {
    seed();
    // The session row's worktree is stale/absent: mergeWorktree removes the
    // directory BEFORE attempting the merge and the conflict path aborts
    // without putting it back, so the agent needs a fresh one on the branch.
    db.update(agentSessions).set({ worktreePath: null }).run();
    gitMocks.mergeWorktree.mockResolvedValueOnce({
      merged: false,
      error: "CONFLICT in lib/x.ts",
      reason: "conflict",
    });
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true, commitHash: "z" });
    gitMocks.attachWorktree.mockResolvedValue({
      worktreePath: "/tmp/worktrees/restored",
      branchName: "feature/landable",
    });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(gitMocks.attachWorktree).toHaveBeenCalledWith(
      "/repos/merge",
      "feature/landable"
    );
    expect(outcome.status).toBe("conflict");
    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, outcome.sessionId!))
      .get()!;
    expect(session.worktreePath).toBe("/tmp/worktrees/restored");
    expect(session.prompt).toContain("/tmp/worktrees/restored");

    await drainScheduler();
  });

  it("reports a hard failure when the worktree cannot be restored", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error: "CONFLICT in lib/x.ts",
      reason: "conflict",
    });
    gitMocks.attachWorktree.mockRejectedValue(new Error("disk full"));

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(outcome).toMatchObject({ status: "failed" });
    expect(
      db
        .select()
        .from(agentSessions)
        .all()
        .some((s) => s.agentType === "merge")
    ).toBe(false);
  });

  it("skips the conflict agent when the caller has no build slot for it", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error: "CONFLICT in lib/x.ts",
      reason: "conflict",
    });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID, {
      dispatchConflictAgent: false,
    });

    expect(outcome).toMatchObject({ status: "skipped" });
    expect(
      db
        .select()
        .from(agentSessions)
        .all()
        .some((s) => s.agentType === "merge")
    ).toBe(false);
    // Deferred, not failed: it retries once a slot frees.
    expect(autoModeRegistry.isParked(PROJECT_ID, EPIC_ID)).toBe(false);

    // The worktree still comes back — mergeWorktree tore it down on the way
    // in, and leaving the epic worktree-less would break the next build.
    expect(gitMocks.attachWorktree).toHaveBeenCalledWith(
      "/repos/merge",
      "feature/landable"
    );

    // And the merge is held back, so the sweep does not re-run a doomed
    // `git merge` every 15 seconds until capacity happens to free up.
    expect(
      autoModeRegistry.mergeDeferredEpicIds(PROJECT_ID).has(EPIC_ID)
    ).toBe(true);
    expect(activityReasons()).toContain(
      AUTO_MODE_REASONS.mergeConflictDeferred
    );
  });

  it("keeps the epic parked even after its merge-fix session is reconciled", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error: "CONFLICT in lib/x.ts",
      reason: "conflict",
    });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);
    autoModeRegistry.addInFlight(PROJECT_ID, outcome.sessionId!, {
      kind: "build",
      ticketId: EPIC_ID,
      epicId: EPIC_ID,
    });
    await drainScheduler();

    expect(autoModeRegistry.isParked(PROJECT_ID, EPIC_ID)).toBe(true);

    // The merge-fix agent itself COMPLETED, so the engine's reconcile pass
    // credits it and clears the ticket's streak. Emulate that exactly. A
    // merge-conflict park is HARD and must survive it — otherwise the epic is
    // un-parked and the sweep loops on the same conflict forever.
    for (const { sessionId, entry } of autoModeRegistry.listInFlight(
      PROJECT_ID
    )) {
      autoModeRegistry.removeInFlight(PROJECT_ID, sessionId);
      autoModeRegistry.clearFailures(PROJECT_ID, entry.ticketId);
    }
    autoModeRegistry.clearFailures(PROJECT_ID, EPIC_ID);
    expect(autoModeRegistry.isParked(PROJECT_ID, EPIC_ID)).toBe(true);

    // Only a deliberate reversal lets it through again.
    autoModeRegistry.unpark(PROJECT_ID, EPIC_ID);
    expect(autoModeRegistry.isParked(PROJECT_ID, EPIC_ID)).toBe(false);
  });

  it("rolls main back when the post-merge guard refuses", async () => {
    seed();
    gitMocks.mergeWorktree.mockImplementation(async () => {
      // The review that was settling when the merge started bounces the epic
      // back — exactly the window a stale captured fromStatus would ignore.
      db.update(epics).set({ status: "in_progress" }).run();
      return { merged: true, commitHash: "raced" };
    });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(outcome.status).toBe("skipped");
    // main is put back where it was and the branch is restored, so the epic
    // can be built, reviewed and merged again for real.
    expect(gitMocks.rollbackMerge).toHaveBeenCalledWith("/repos/merge", {
      mainBranch: "main",
      mainHead: "main-head",
      branchName: "feature/landable",
      branchHead: "branch-head",
    });
    const epic = db.select().from(epics).where(eq(epics.id, EPIC_ID)).get()!;
    expect(epic.status).toBe("in_progress");
    expect(epic.branchName).toBe("feature/landable");
    expect(
      activityReasons().some((reason) =>
        reason.startsWith("Auto mode rolled the merge back off main")
      )
    ).toBe(true);
    expect(autoModeRegistry.isParked(PROJECT_ID, EPIC_ID)).toBe(false);
  });

  it("says so loudly when there is no checkpoint to roll back to", async () => {
    seed();
    gitMocks.captureMergeCheckpoint.mockResolvedValue(null);
    gitMocks.mergeWorktree.mockImplementation(async () => {
      db.update(epics).set({ status: "in_progress" }).run();
      return { merged: true, commitHash: "raced" };
    });

    await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(gitMocks.rollbackMerge).not.toHaveBeenCalled();
    expect(
      activityReasons().some((reason) =>
        reason.startsWith("Auto mode merged the branch but left the ticket")
      )
    ).toBe(true);
  });

  it("refuses a second concurrent merge of the same epic", async () => {
    seed();
    let releaseMerge!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    gitMocks.mergeWorktree.mockImplementation(async () => {
      await gate;
      return { merged: true, commitHash: "c1" };
    });

    const first = tryAutoMerge(PROJECT_ID, EPIC_ID);
    // Git is not transactional: a second merge on the same branch while the
    // first is still running is exactly what the lock exists to stop.
    const second = await tryAutoMerge(PROJECT_ID, EPIC_ID);
    expect(second).toMatchObject({ status: "skipped" });
    expect(gitMocks.mergeWorktree).toHaveBeenCalledTimes(1);

    releaseMerge();
    expect((await first).status).toBe("merged");
    expect(autoModeRegistry.isMergeInFlight(PROJECT_ID, EPIC_ID)).toBe(false);
  });

  it("holds the merge lock across the conflict agent and its retry", async () => {
    seed();
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let call = 0;
    gitMocks.mergeWorktree.mockImplementation(async () => {
      call += 1;
      // Hold the RETRY open so the assertion lands inside the exact window
      // the lock protects.
      if (call > 1) await retryGate;
      return {
        merged: false,
        error: "CONFLICT in lib/x.ts",
        reason: "conflict",
      };
    });

    await tryAutoMerge(PROJECT_ID, EPIC_ID);
    await drainScheduler();

    // The merge-fix session has already gone terminal (which fires the sweep
    // kick) while its retry is still running. The lock is what stops that
    // sweep from starting a second merge on the same branch.
    expect(call).toBe(2);
    expect(autoModeRegistry.isMergeInFlight(PROJECT_ID, EPIC_ID)).toBe(true);
    expect(await tryAutoMerge(PROJECT_ID, EPIC_ID)).toMatchObject({
      status: "skipped",
    });

    releaseRetry();
    await drainScheduler();
    expect(autoModeRegistry.isMergeInFlight(PROJECT_ID, EPIC_ID)).toBe(false);
  });

  it("never dispatches an agent for a non-conflict failure", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error: "Branch feature/landable not found",
      reason: "branch-missing",
    });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    // No agent can conjure a branch back — spending a build slot on one
    // would just burn a session.
    expect(outcome).toMatchObject({ status: "failed" });
    expect(gitMocks.attachWorktree).not.toHaveBeenCalled();
    expect(
      db
        .select()
        .from(agentSessions)
        .all()
        .some((s) => s.agentType === "merge")
    ).toBe(false);
  });
});


/* ------------------------------------------------------------------ */
/* The deterministic-verification gate                                 */
/* ------------------------------------------------------------------ */
  // The file-level beforeEach does not reset these two tables.
  afterEach(() => {
    db.delete(verifyReports).run();
    db.delete(settings).run();
  });

  function configureVerification(): void {
    db.insert(settings)
      .values({
        key: "verify_commands",
        value: JSON.stringify([{ name: "test", command: "npm test" }]),
      })
      .run();
  }
  function insertReport(status: "pass" | "fail", finishedMinute: number): void {
    db.insert(verifyReports)
      .values({
        id: `report-${status}-${finishedMinute}`,
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        status,
        startedAt: isoAt(finishedMinute - 1),
        finishedAt: isoAt(finishedMinute),
        commands: JSON.stringify([
          {
            name: "test",
            command: "npm test",
            exitCode: status === "pass" ? 0 : 1,
            durationMs: 1_000,
            tail: "output",
          },
        ]),
      })
      .run();
  }

  it("merges without a gate when verification is not configured", async () => {
    seed();
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(outcome.status).toBe("merged");
  });

  it("refuses to merge when verification is configured but has never run", async () => {
    seed();
    configureVerification();
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    // The mode that lands code on the default branch unattended may not do
    // so on agent prose alone — and the refusal must be visible.
    expect(outcome).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/never run/i),
    });
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
    expect(activityReasons()).toContainEqual(
      expect.stringMatching(/Auto mode skipped merge.*never run/i)
    );
    // Not parked: the next passing report unlocks the merge.
    expect(db.select().from(epics).get()!.status).toBe("review");
  });

  it("merges when a passing report is newer than the last build session", async () => {
    seed(); // build session ends at isoAt(2)
    configureVerification();
    insertReport("pass", 5);
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(outcome.status).toBe("merged");
    expect(gitMocks.mergeWorktree).toHaveBeenCalledTimes(1);
  });

  it("refuses to merge when the latest report did not pass", async () => {
    seed();
    configureVerification();
    insertReport("fail", 5);
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(outcome).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/did not pass/i),
    });
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
  });

  it("refuses to merge when the passing report predates a later code session", async () => {
    seed(); // build session ends at isoAt(2)
    configureVerification();
    seq += 1;
    db.insert(agentSessions)
      .values({
        id: `fix-${seq}`,
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        status: "completed",
        agentType: "fix",
        worktreePath: "/tmp/worktrees/landable",
        createdAt: isoAt(6),
        endedAt: isoAt(7),
      })
      .run();
    insertReport("pass", 5); // verified a tree the fix has since changed
    gitMocks.mergeWorktree.mockResolvedValue({ merged: true });

    const outcome = await tryAutoMerge(PROJECT_ID, EPIC_ID);

    expect(outcome).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/predates/i),
    });
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
  });
