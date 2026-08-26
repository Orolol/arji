/**
 * Tests for the Full Auto Mode sweep engine (lib/auto-mode/engine.ts).
 *
 * The dispatcher, the config resolver, the merge primitive and the session
 * status reader are injected as fakes; the registry, the selectors, the
 * activity log and the real database are in the loop. That split is what
 * makes the N/M caps, the per-project mutex and the parking ladder testable
 * without spawning a CLI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
// Type-only imports are erased, so they can sit above the vi.mock hoisting.
import type {
  AutoModeDispatchInput,
  AutoModeEngineDeps,
} from "@/lib/auto-mode/engine";
import type { SmartDispatchPick } from "@/lib/agent-config/smart-dispatch";
import type { SecondOpinionState } from "@/lib/auto-mode/second-opinion";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const {
  projects,
  epics,
  userStories,
  agentSessions,
  ticketComments,
  reviewComments,
  ticketActivityLog,
  settings,
} = await import("@/lib/db/schema");
const {
  sweep,
  sweepProject,
  startAutoMode,
  stopAutoMode,
  isAutoModeRunning,
  kickAutoMode,
  cancelPendingKicks,
} = await import("@/lib/auto-mode/engine");
const { autoModeRegistry } = await import("@/lib/auto-mode/registry");
const { loadAutoModeBoard } = await import("@/lib/auto-mode/select");
const {
  AUTO_MODE_REASON_PREFIX,
  DEFAULT_AUTO_BUILD_CONCURRENCY,
  DEFAULT_AUTO_REVIEW_CONCURRENCY,
} = await import("@/lib/auto-mode/constants");

const PROJECT_ID = "proj-engine";

let seq = 0;
function at(minute: number): string {
  return new Date(Date.UTC(2026, 7, 19, 10, minute, 0)).toISOString();
}

function seedProject(id = PROJECT_ID): void {
  db.insert(projects)
    .values({ id, name: "Engine", gitRepoPath: `/repos/${id}` })
    .run();
}

function addEpic(input: {
  id: string;
  status: string;
  projectId?: string;
  branchName?: string | null;
  position?: number;
}): void {
  db.insert(epics)
    .values({
      id: input.id,
      projectId: input.projectId ?? PROJECT_ID,
      title: input.id,
      status: input.status,
      position: input.position ?? 0,
      branchName: input.branchName ?? null,
      readableId: `E-${input.id}`,
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
}

function addStory(input: {
  id: string;
  epicId: string;
  status: string;
  position?: number;
}): void {
  db.insert(userStories)
    .values({
      id: input.id,
      epicId: input.epicId,
      title: input.id,
      status: input.status,
      position: input.position ?? 0,
      createdAt: at(0),
    })
    .run();
}

function addSession(input: {
  id?: string;
  projectId?: string;
  epicId: string;
  userStoryId?: string | null;
  status: string;
  agentType: string;
  /** Defaults to "answered" for completed sessions — what a real run stores. */
  outcome?: string | null;
  createdAt: string;
  endedAt?: string | null;
}): string {
  seq += 1;
  const id = input.id ?? `s-${seq}`;
  db.insert(agentSessions)
    .values({
      id,
      projectId: input.projectId ?? PROJECT_ID,
      epicId: input.epicId,
      userStoryId: input.userStoryId ?? null,
      status: input.status,
      agentType: input.agentType,
      outcome:
        input.outcome !== undefined
          ? input.outcome
          : input.status === "completed"
            ? "answered"
            : null,
      createdAt: input.createdAt,
      endedAt: input.endedAt ?? null,
    })
    .run();
  return id;
}

/* ------------------------------------------------------------------ */
/* Injectable fakes                                                    */
/* ------------------------------------------------------------------ */

interface Fakes {
  deps: AutoModeEngineDeps;
  dispatches: AutoModeDispatchInput[];
  merges: string[];
  /** Options the engine passed to each merge attempt, in order. */
  mergeOptions: Array<{
    namedAgentId: string | null;
    dispatchConflictAgent: boolean;
  }>;
  /** Stages the engine asked the smart selector about, in order. */
  smartLookups: Array<"build" | "review">;
  /** Sessions the fake dispatcher created, keyed by id → status. */
  sessionStatus: Map<string, string>;
  /** Delivery verdicts, keyed by session id. */
  sessionOutcome: Map<string, string>;
  secondOpinionDispatches: string[];
  secondOpinionNotifications: Array<{
    epicId: string;
    sessionId: string;
    reason: string;
  }>;
  setSecondOpinionState(epicId: string, state: SecondOpinionState): void;
  setConfig(patch: Partial<ReturnType<AutoModeEngineDeps["resolveConfig"]>>): void;
  failNextDispatch(times: number, error?: string): void;
  conflictNextDispatch(sessionId: string): void;
  mergeOutcome(outcome: unknown): void;
  mergeImplementation(fn: () => unknown): void;
  /** What the (stubbed) reliability argmax returns for a stage. */
  smartPick(stage: "build" | "review", pick: SmartDispatchPick | null): void;
}

function makeFakes(): Fakes {
  const dispatches: AutoModeDispatchInput[] = [];
  const merges: string[] = [];
  const mergeOptions: Fakes["mergeOptions"] = [];
  const smartLookups: Array<"build" | "review"> = [];
  const smartPicks = new Map<string, SmartDispatchPick | null>();
  const sessionStatus = new Map<string, string>();
  const sessionOutcome = new Map<string, string>();
  const secondOpinionStates = new Map<string, SecondOpinionState>();
  const secondOpinionDispatches: string[] = [];
  const secondOpinionNotifications: Fakes["secondOpinionNotifications"] = [];
  let dispatchFailures = 0;
  let dispatchError = "dispatch exploded";
  let conflictSessionId: string | null = null;
  let mergeResult: unknown = { status: "skipped", reason: "n/a", sessionId: null };
  let mergeImpl: (() => unknown) | null = null;

  let config = {
    enabled: true,
    buildAgent: "build-agent" as string | null,
    buildConcurrency: DEFAULT_AUTO_BUILD_CONCURRENCY,
    reviewAgent: "review-agent" as string | null,
    reviewConcurrency: DEFAULT_AUTO_REVIEW_CONCURRENCY,
    smartDispatch: false,
    secondOpinion: false,
  };

  const deps: AutoModeEngineDeps = {
    listEnabledProjectIds: () => (config.enabled ? [PROJECT_ID] : []),
    selectSmartAgent: async ({ stage }) => {
      smartLookups.push(stage);
      return smartPicks.get(stage) ?? null;
    },
    resolveConfig: () => ({ ...config }),
    loadBoard: (projectId) => loadAutoModeBoard(projectId),
    dispatchSecondOpinion: async ({ projectId, epicId }) => {
      secondOpinionDispatches.push(epicId);
      seq += 1;
      const sessionId = `fake-second-opinion-${seq}`;
      sessionStatus.set(sessionId, "running");
      secondOpinionStates.set(epicId, { status: "pending", sessionId });
      db.insert(agentSessions)
        .values({
          id: sessionId,
          projectId,
          epicId,
          status: "running",
          agentType: "review_second_opinion",
          batchRunId: `auto_${projectId}`,
          createdAt: at(50 + seq),
        })
        .run();
      return { sessionId, error: null, conflictSessionId: null };
    },
    readSecondOpinionState: (_projectId, epicId) =>
      secondOpinionStates.get(epicId) ?? {
        status: "missing",
        sessionId: null,
      },
    notifySecondOpinionRejected: ({ epicId, sessionId, reason }) => {
      secondOpinionNotifications.push({ epicId, sessionId, reason });
    },
    dispatch: async (input) => {
      dispatches.push(input);
      if (conflictSessionId) {
        const id = conflictSessionId;
        conflictSessionId = null;
        return { sessionId: null, error: null, conflictSessionId: id };
      }
      if (dispatchFailures > 0) {
        dispatchFailures -= 1;
        return { sessionId: null, error: dispatchError, conflictSessionId: null };
      }
      seq += 1;
      const sessionId = `fake-${input.stage}-${seq}`;
      sessionStatus.set(sessionId, "running");
      // A real dispatch writes a session row, which is what makes the target
      // busy for the next sweep — reproduce that so the guards behave.
      db.insert(agentSessions)
        .values({
          id: sessionId,
          projectId: input.projectId,
          epicId: input.epicId,
          userStoryId: input.userStoryId,
          status: "running",
          agentType: input.stage === "review" ? "review_code" : "build",
          batchRunId: `auto_${input.projectId}`,
          createdAt: at(50 + seq),
        })
        .run();
      return { sessionId, error: null, conflictSessionId: null };
    },
    merge: async (_projectId, epicId, options) => {
      merges.push(epicId);
      mergeOptions.push(options);
      return (mergeImpl ? mergeImpl() : mergeResult) as never;
    },
    readSessionStatus: (sessionId) =>
      sessionStatus.get(sessionId) ??
      db
        .select({ status: agentSessions.status })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get()?.status ??
      null,
    readSessionOutcome: (sessionId) =>
      sessionOutcome.get(sessionId) ??
      db
        .select({ outcome: agentSessions.outcome })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get()?.outcome ??
      null,
    readEpicStatus: (epicId) =>
      db.select({ status: epics.status }).from(epics).where(eq(epics.id, epicId)).get()
        ?.status ?? null,
  };

  return {
    deps,
    dispatches,
    merges,
    mergeOptions,
    smartLookups,
    sessionStatus,
    sessionOutcome,
    secondOpinionDispatches,
    secondOpinionNotifications,
    setSecondOpinionState(epicId, state) {
      secondOpinionStates.set(epicId, state);
    },
    setConfig(patch) {
      config = { ...config, ...patch };
    },
    failNextDispatch(times, error) {
      dispatchFailures = times;
      if (error) dispatchError = error;
    },
    conflictNextDispatch(sessionId) {
      conflictSessionId = sessionId;
    },
    mergeOutcome(outcome) {
      mergeResult = outcome;
    },
    mergeImplementation(fn) {
      mergeImpl = fn;
    },
    smartPick(stage, pick) {
      smartPicks.set(stage, pick);
    },
  };
}

/** Marks a fake session terminal so the next sweep reconciles it. */
function settle(
  fakes: Fakes,
  sessionId: string,
  status: string,
  outcome: string | null = status === "completed" ? "answered" : null
): void {
  fakes.sessionStatus.set(sessionId, status);
  if (outcome) fakes.sessionOutcome.set(sessionId, outcome);
  else fakes.sessionOutcome.delete(sessionId);
  db.update(agentSessions)
    .set({ status, outcome, endedAt: at(90) })
    .where(eq(agentSessions.id, sessionId))
    .run();
}

function autoReasons(epicId: string): string[] {
  return db
    .select()
    .from(ticketActivityLog)
    .where(eq(ticketActivityLog.epicId, epicId))
    .all()
    .map((row) => row.reason ?? "")
    .filter((reason) => reason.startsWith(AUTO_MODE_REASON_PREFIX));
}

beforeEach(() => {
  db.delete(reviewComments).run();
  db.delete(ticketComments).run();
  db.delete(ticketActivityLog).run();
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  autoModeRegistry.resetAll();
  seedProject();
});

afterEach(() => {
  stopAutoMode();
});

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

describe("budgets", () => {
  it("dispatches exactly N builders and M reviewers, leaving the rest waiting", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 2, reviewConcurrency: 1 });
    addEpic({ id: "t1", status: "todo", position: 0 });
    addEpic({ id: "t2", status: "todo", position: 1 });
    addEpic({ id: "t3", status: "todo", position: 2 });
    addEpic({ id: "r1", status: "review", position: 3 });
    addSession({
      epicId: "r1",
      status: "completed",
      agentType: "build",
      createdAt: at(1),
      endedAt: at(2),
    });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(result.buildsDispatched).toHaveLength(2);
    expect(result.reviewsDispatched).toHaveLength(1);
    expect(result.inFlight).toEqual({ build: 2, review: 1 });

    const builtEpics = fakes.dispatches
      .filter((d) => d.stage === "build")
      .map((d) => d.epicId);
    expect(builtEpics).toEqual(["t1", "t2"]);
  });

  it("never exceeds the budgets across consecutive sweeps", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 1, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo", position: 0 });
    addEpic({ id: "t2", status: "todo", position: 1 });

    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);

    expect(autoModeRegistry.countInFlight(PROJECT_ID).build).toBe(1);
    expect(fakes.dispatches.filter((d) => d.stage === "build")).toHaveLength(1);
  });

  it("refills the freed slot once the in-flight session goes terminal", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 1, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo", position: 0 });
    addEpic({ id: "t2", status: "todo", position: 1 });

    const first = await sweepProject(PROJECT_ID, fakes.deps);
    settle(fakes, first.buildsDispatched[0], "completed");
    db.update(epics).set({ status: "review" }).where(eq(epics.id, "t1")).run();

    const second = await sweepProject(PROJECT_ID, fakes.deps);
    expect(second.buildsDispatched).toHaveLength(1);
    expect(
      fakes.dispatches.filter((d) => d.stage === "build").map((d) => d.epicId)
    ).toEqual(["t1", "t2"]);
  });

  it("a build concurrency of 0 disables builds without disabling reviews", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 0, reviewConcurrency: 2 });
    addEpic({ id: "t1", status: "todo" });
    addEpic({ id: "r1", status: "review", position: 1 });
    addSession({
      epicId: "r1",
      status: "completed",
      agentType: "build",
      createdAt: at(1),
      endedAt: at(2),
    });

    const result = await sweepProject(PROJECT_ID, fakes.deps);
    expect(result.buildsDispatched).toEqual([]);
    expect(result.reviewsDispatched).toHaveLength(1);
  });

  it("a review concurrency of 0 disables reviews without disabling builds", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 2, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo" });
    addEpic({ id: "r1", status: "review", position: 1 });
    addSession({
      epicId: "r1",
      status: "completed",
      agentType: "build",
      createdAt: at(1),
      endedAt: at(2),
    });

    const result = await sweepProject(PROJECT_ID, fakes.deps);
    expect(result.reviewsDispatched).toEqual([]);
    expect(result.buildsDispatched).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Dispatch shape                                                      */
/* ------------------------------------------------------------------ */

describe("dispatch shape", () => {
  it("passes the configured build and review agents and the auto batch id", async () => {
    const fakes = makeFakes();
    addEpic({ id: "r1", status: "review" });
    addSession({
      epicId: "r1",
      status: "completed",
      agentType: "build",
      createdAt: at(1),
      endedAt: at(2),
    });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.dispatches[0]).toMatchObject({
      stage: "review",
      scope: "epic",
      epicId: "r1",
      buildNamedAgentId: "build-agent",
      reviewNamedAgentId: "review-agent",
    });
    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.reviewsDispatched[0]))
      .get()!;
    expect(row.batchRunId).toBe(`auto_${PROJECT_ID}`);
  });

  it("dispatches story scope for an epic with stories and epic scope otherwise", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ reviewConcurrency: 0 });
    addEpic({ id: "with", status: "todo", position: 0 });
    addStory({ id: "s1", epicId: "with", status: "todo" });
    addEpic({ id: "without", status: "todo", position: 1 });

    await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.dispatches).toEqual([
      expect.objectContaining({
        scope: "story",
        epicId: "with",
        userStoryId: "s1",
      }),
      expect.objectContaining({
        scope: "epic",
        epicId: "without",
        userStoryId: null,
      }),
    ]);
  });

  it("hands the driver its own session ids for the race check", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 2, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo", position: 0 });
    addEpic({ id: "t2", status: "todo", position: 1 });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.dispatches[0].ownSessionIds).toEqual([]);
    expect(fakes.dispatches[1].ownSessionIds).toEqual([
      result.buildsDispatched[0],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Smart dispatch (auto_mode_smart_dispatch)                           */
/* ------------------------------------------------------------------ */

describe("smart dispatch", () => {
  const BUILD_PICK = {
    namedAgentId: "measured-builder",
    agentName: "Measured Builder",
    role: "build" as const,
    successRate: 0.92,
    sampleSize: 25,
    medianDurationMs: 252_000,
  };
  const REVIEW_PICK = {
    namedAgentId: "measured-reviewer",
    agentName: "Measured Reviewer",
    role: "review" as const,
    successRate: 0.8,
    sampleSize: 10,
    medianDurationMs: 60_000,
  };

  it("changes nothing while the setting is off", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildAgent: null, reviewAgent: null, smartDispatch: false });
    fakes.smartPick("build", BUILD_PICK);
    addEpic({ id: "t1", status: "todo" });

    await sweepProject(PROJECT_ID, fakes.deps);

    // The selector is not even consulted, so a slow stats read cannot cost a
    // sweep anything when the feature is off.
    expect(fakes.smartLookups).toEqual([]);
    expect(fakes.dispatches[0].buildNamedAgentId).toBeNull();
    expect(autoReasons("t1")).toEqual([
      "Auto mode dispatched a build (epic scope)",
    ]);
  });

  it("never overrides an explicitly configured agent", async () => {
    const fakes = makeFakes();
    fakes.setConfig({
      buildAgent: "chosen-by-hand",
      reviewAgent: "chosen-by-hand-too",
      smartDispatch: true,
    });
    fakes.smartPick("build", BUILD_PICK);
    fakes.smartPick("review", REVIEW_PICK);
    addEpic({ id: "t1", status: "todo" });

    await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.smartLookups).toEqual([]);
    expect(fakes.dispatches[0].buildNamedAgentId).toBe("chosen-by-hand");
    expect(autoReasons("t1").some((r) => r.includes("picked"))).toBe(false);
  });

  it("only overrides the role that has no agent of its own", async () => {
    const fakes = makeFakes();
    fakes.setConfig({
      buildAgent: "chosen-by-hand",
      reviewAgent: null,
      smartDispatch: true,
    });
    fakes.smartPick("build", BUILD_PICK);
    fakes.smartPick("review", REVIEW_PICK);
    addEpic({ id: "r1", status: "review" });

    await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.smartLookups).toEqual(["review"]);
    expect(fakes.dispatches[0]).toMatchObject({
      stage: "review",
      reviewNamedAgentId: "measured-reviewer",
      // The build agent field still carries the configured value untouched.
      buildNamedAgentId: "chosen-by-hand",
    });
  });

  it("dispatches the measured agent and records WHY in the activity log", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildAgent: null, reviewAgent: null, smartDispatch: true });
    fakes.smartPick("build", BUILD_PICK);
    addEpic({ id: "t1", status: "todo" });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.dispatches[0].buildNamedAgentId).toBe("measured-builder");
    expect(autoReasons("t1")).toContain(
      "Auto mode picked Measured Builder for the build: best 92% success over 25 runs in the last 30 days"
    );

    // The trace hangs off the session it explains, so the feed can link them.
    const traced = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, "t1"))
      .all()
      .find((row) => (row.reason ?? "").includes("picked"))!;
    expect(traced.sessionId).toBe(result.buildsDispatched[0]);
    expect(traced.actor).toBe("system");
  });

  it("keeps the current default when nothing clears the sample threshold", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildAgent: null, reviewAgent: null, smartDispatch: true });
    fakes.smartPick("build", null);
    addEpic({ id: "t1", status: "todo" });

    await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.smartLookups).toEqual(["build"]);
    // null = "resolve through the normal project -> global -> builtin chain".
    expect(fakes.dispatches[0].buildNamedAgentId).toBeNull();
    expect(autoReasons("t1")).toEqual([
      "Auto mode dispatched a build (epic scope)",
    ]);
  });

  it("asks once per sweep, not once per ticket", async () => {
    const fakes = makeFakes();
    fakes.setConfig({
      buildAgent: null,
      reviewAgent: null,
      smartDispatch: true,
      buildConcurrency: 3,
      reviewConcurrency: 0,
    });
    fakes.smartPick("build", BUILD_PICK);
    addEpic({ id: "t1", status: "todo", position: 0 });
    addEpic({ id: "t2", status: "todo", position: 1 });
    addEpic({ id: "t3", status: "todo", position: 2 });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(result.buildsDispatched).toHaveLength(3);
    expect(fakes.smartLookups).toEqual(["build"]);
    for (const dispatch of fakes.dispatches) {
      expect(dispatch.buildNamedAgentId).toBe("measured-builder");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Activity trace                                                      */
/* ------------------------------------------------------------------ */

describe("activity trace", () => {
  it("logs every dispatch with actor system and an 'Auto mode ' reason", async () => {
    const fakes = makeFakes();
    addEpic({ id: "t1", status: "todo" });

    await sweepProject(PROJECT_ID, fakes.deps);

    const entries = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, "t1"))
      .all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "system",
      fromStatus: "todo",
      toStatus: "todo",
      reason: "Auto mode dispatched a build (epic scope)",
    });
    expect(entries[0].sessionId).toBeTruthy();
  });

  it("logs a skip when another agent took the ticket first", async () => {
    const fakes = makeFakes();
    addEpic({ id: "t1", status: "todo" });
    fakes.conflictNextDispatch("someone-elses-session");

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(result.buildsDispatched).toEqual([]);
    expect(autoReasons("t1")).toContain(
      "Auto mode skipped: another agent is already on this ticket"
    );
    // A conflict is not the ticket's fault — no failure is charged.
    expect(autoModeRegistry.listParked(PROJECT_ID)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Parking                                                             */
/* ------------------------------------------------------------------ */

describe("parking", () => {
  it("parks a ticket after 3 consecutive dispatch failures and skips it after", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo" });

    fakes.failNextDispatch(3, "boom");
    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);
    const third = await sweepProject(PROJECT_ID, fakes.deps);

    expect(third.parked).toEqual(["t1"]);
    expect(autoModeRegistry.isParked(PROJECT_ID, "t1")).toBe(true);
    expect(autoReasons("t1")).toContain(
      "Auto mode parked this ticket after 3 consecutive failures"
    );

    const dispatchesBefore = fakes.dispatches.length;
    await sweepProject(PROJECT_ID, fakes.deps);
    expect(fakes.dispatches.length).toBe(dispatchesBefore);
  });

  it("parks a ticket whose dispatched sessions keep failing", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 1, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo" });

    for (let i = 0; i < 3; i += 1) {
      const result = await sweepProject(PROJECT_ID, fakes.deps);
      expect(result.buildsDispatched).toHaveLength(1);
      settle(fakes, result.buildsDispatched[0], "failed");
    }

    const final = await sweepProject(PROJECT_ID, fakes.deps);
    expect(final.parked).toEqual(["t1"]);
    expect(final.buildsDispatched).toEqual([]);
  });

  it("a completed session clears the failure streak", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 1, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo" });

    let result = await sweepProject(PROJECT_ID, fakes.deps);
    settle(fakes, result.buildsDispatched[0], "failed");
    result = await sweepProject(PROJECT_ID, fakes.deps);
    settle(fakes, result.buildsDispatched[0], "completed");
    result = await sweepProject(PROJECT_ID, fakes.deps);
    settle(fakes, result.buildsDispatched[0], "failed");
    result = await sweepProject(PROJECT_ID, fakes.deps);
    settle(fakes, result.buildsDispatched[0], "failed");

    // 1 failure, reset, then 2 more — still below the cap of 3.
    const final = await sweepProject(PROJECT_ID, fakes.deps);
    expect(autoModeRegistry.isParked(PROJECT_ID, "t1")).toBe(false);
    expect(final.buildsDispatched).toHaveLength(1);
  });

  it("a user-cancelled session counts neither as success nor failure", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 1, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo" });

    for (let i = 0; i < 4; i += 1) {
      const result = await sweepProject(PROJECT_ID, fakes.deps);
      if (result.buildsDispatched[0]) {
        settle(fakes, result.buildsDispatched[0], "cancelled");
      }
    }

    expect(autoModeRegistry.isParked(PROJECT_ID, "t1")).toBe(false);
  });

  it("un-parks a ticket the user comments on", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo" });

    fakes.failNextDispatch(3, "boom");
    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);
    expect(autoModeRegistry.isParked(PROJECT_ID, "t1")).toBe(true);

    db.insert(ticketComments)
      .values({
        id: "cmt-unpark",
        epicId: "t1",
        author: "user",
        content: "try again",
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .run();

    const result = await sweepProject(PROJECT_ID, fakes.deps);
    expect(autoModeRegistry.isParked(PROJECT_ID, "t1")).toBe(false);
    expect(result.buildsDispatched).toHaveLength(1);
  });

  it("clears parks when the mode is switched off", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo" });
    fakes.failNextDispatch(3, "boom");
    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);

    fakes.setConfig({ enabled: false });
    const off = await sweepProject(PROJECT_ID, fakes.deps);
    expect(off.skipped).toBe("disabled");
    expect(autoModeRegistry.isParked(PROJECT_ID, "t1")).toBe(false);
    expect(autoModeRegistry.snapshot(PROJECT_ID).enabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Merge step                                                          */
/* ------------------------------------------------------------------ */

describe("merge step", () => {
  function seedMergeable(id = "m1"): void {
    addEpic({ id, status: "review", branchName: `feat/${id}` });
    addSession({
      epicId: id,
      status: "completed",
      agentType: "build",
      createdAt: at(1),
      endedAt: at(2),
    });
    addSession({
      epicId: id,
      status: "completed",
      agentType: "review_code",
      createdAt: at(3),
      endedAt: at(4),
    });
  }

  it("merges before dispatching anything, and a clean merge costs no slot", async () => {
    const fakes = makeFakes();
    seedMergeable();
    fakes.mergeOutcome({ status: "merged", commitHash: "c1", sessionId: null });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.merges).toEqual(["m1"]);
    expect(result.merged).toEqual(["m1"]);
    expect(result.inFlight).toEqual({ build: 0, review: 0 });
    expect(fakes.secondOpinionDispatches).toEqual([]);
  });

  it("spends one review-budget slot on an opted-in second opinion before merge", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ secondOpinion: true, reviewConcurrency: 1 });
    seedMergeable();
    fakes.mergeOutcome({ status: "merged", commitHash: "c1", sessionId: null });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.merges).toEqual([]);
    expect(fakes.secondOpinionDispatches).toEqual(["m1"]);
    expect(result.secondOpinionsDispatched).toHaveLength(1);
    expect(result.inFlight).toEqual({ build: 0, review: 1 });
    expect(autoModeRegistry.snapshot(PROJECT_ID).recentDispatches[0]).toMatchObject({
      kind: "second-opinion",
      epicId: "m1",
      sessionId: result.secondOpinionsDispatched[0],
    });
  });

  it("waits for review capacity instead of merging around the second-opinion budget", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ secondOpinion: true, reviewConcurrency: 1 });
    seedMergeable();
    fakes.sessionStatus.set("review-slot", "running");
    autoModeRegistry.setEnabled(PROJECT_ID, true);
    autoModeRegistry.addInFlight(PROJECT_ID, "review-slot", {
      kind: "review",
      ticketId: "other",
      epicId: "other",
    });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(result.secondOpinionsDispatched).toEqual([]);
    expect(fakes.secondOpinionDispatches).toEqual([]);
    expect(fakes.merges).toEqual([]);
    expect(result.inFlight.review).toBe(1);
  });

  it("holds the merge and traces an unavailable verdict provider only once", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ secondOpinion: true, reviewConcurrency: 1 });
    seedMergeable();
    fakes.deps.dispatchSecondOpinion = async () => ({
      sessionId: null,
      error: null,
      conflictSessionId: null,
      skipReason:
        "no installed provider differs from both the builder and reviewer",
    });
    fakes.mergeOutcome({ status: "merged", commitHash: "forbidden", sessionId: null });

    const result = await sweepProject(PROJECT_ID, fakes.deps);
    const repeated = await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.merges).toEqual([]);
    expect(result.secondOpinionsDispatched).toEqual([]);
    expect(repeated.secondOpinionsDispatched).toEqual([]);
    expect(result.parked).toEqual([]);
    expect(
      autoReasons("m1").filter(
        (reason) =>
          reason ===
          "Auto mode skipped second opinion: no installed provider differs from both the builder and reviewer"
      )
    ).toHaveLength(1);
  });

  it("holds and traces once when second opinion is enabled with a zero review budget", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ secondOpinion: true, reviewConcurrency: 0 });
    seedMergeable();
    fakes.mergeOutcome({ status: "merged", commitHash: "forbidden", sessionId: null });

    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.secondOpinionDispatches).toEqual([]);
    expect(fakes.merges).toEqual([]);
    expect(
      autoReasons("m1").filter(
        (reason) =>
          reason ===
          "Auto mode skipped second opinion: the review concurrency budget is 0, so no second opinion can be dispatched"
      )
    ).toHaveLength(1);
  });

  it("bounds missing structured verdicts with the review failure ladder", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ secondOpinion: true, reviewConcurrency: 0 });
    seedMergeable();
    autoModeRegistry.setEnabled(PROJECT_ID, true);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const sessionId = `second-opinion-no-verdict-${attempt}`;
      fakes.sessionStatus.set(sessionId, "completed");
      fakes.sessionOutcome.set(sessionId, "answered");
      fakes.setSecondOpinionState("m1", {
        status: "retry",
        sessionId,
        reason: "no submit_findings or Overall Verdict evidence was recorded",
      });
      autoModeRegistry.addInFlight(PROJECT_ID, sessionId, {
        kind: "review",
        purpose: "second-opinion",
        ticketId: "m1",
        epicId: "m1",
      });

      const result = await sweepProject(PROJECT_ID, fakes.deps);
      expect(result.parked).toEqual(attempt === 3 ? ["m1"] : []);
    }

    expect(fakes.merges).toEqual([]);
    expect(fakes.secondOpinionNotifications).toEqual([
      {
        epicId: "m1",
        sessionId: "second-opinion-no-verdict-3",
        reason:
          "gate failed to return usable evidence after 3 attempts: no submit_findings or Overall Verdict evidence was recorded",
      },
    ]);
    expect(autoModeRegistry.isParked(PROJECT_ID, "m1")).toBe(true);
  });

  it("does not charge or relaunch a cancelled second opinion", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ secondOpinion: true, reviewConcurrency: 1 });
    seedMergeable();

    const first = await sweepProject(PROJECT_ID, fakes.deps);
    const sessionId = first.secondOpinionsDispatched[0];
    settle(fakes, sessionId, "cancelled", null);
    fakes.setSecondOpinionState("m1", {
      status: "cancelled",
      sessionId,
    });

    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.secondOpinionDispatches).toEqual(["m1"]);
    expect(fakes.merges).toEqual([]);
    expect(autoModeRegistry.isParked(PROJECT_ID, "m1")).toBe(false);
    expect(
      autoReasons("m1").filter((reason) =>
        reason.includes("the second-opinion session was cancelled")
      )
    ).toHaveLength(1);
  });

  it("merges only after a fresh structured second opinion approves", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ secondOpinion: true });
    seedMergeable();
    fakes.setSecondOpinionState("m1", {
      status: "approved",
      sessionId: "second-opinion-ok",
    });
    fakes.mergeOutcome({ status: "merged", commitHash: "c1", sessionId: null });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.secondOpinionDispatches).toEqual([]);
    expect(fakes.merges).toEqual(["m1"]);
    expect(result.merged).toEqual(["m1"]);
  });

  it("parks, notifies and never merges on a negative second opinion", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ secondOpinion: true });
    seedMergeable();
    fakes.setSecondOpinionState("m1", {
      status: "rejected",
      sessionId: "second-opinion-no",
      reason: "1 blocking finding",
    });
    // The open finding removes m1 from the merge selector. Reconciliation of
    // the tracked gate must still park and notify before candidate selection.
    db.insert(reviewComments)
      .values({
        id: "second-opinion-blocker",
        epicId: "m1",
        filePath: "lib/unsafe.ts",
        lineNumber: 7,
        body: "[major] unsafe merge",
        author: "agent",
        status: "open",
        agentSessionId: "second-opinion-no",
      })
      .run();
    fakes.sessionStatus.set("second-opinion-no", "completed");
    autoModeRegistry.setEnabled(PROJECT_ID, true);
    autoModeRegistry.addInFlight(PROJECT_ID, "second-opinion-no", {
      kind: "review",
      purpose: "second-opinion",
      ticketId: "m1",
      epicId: "m1",
    });
    fakes.mergeOutcome({ status: "merged", commitHash: "forbidden", sessionId: null });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.merges).toEqual([]);
    expect(result.parked).toEqual(["m1"]);
    expect(autoModeRegistry.isParked(PROJECT_ID, "m1")).toBe(true);
    expect(fakes.secondOpinionNotifications).toEqual([
      {
        epicId: "m1",
        sessionId: "second-opinion-no",
        reason: "1 blocking finding",
      },
    ]);
    expect(autoReasons("m1")).toContain(
      "Auto mode parked this ticket after the second opinion rejected the merge: 1 blocking finding"
    );
  });

  it("charges a merge-fix session to the build budget", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 1, reviewConcurrency: 0 });
    seedMergeable();
    addEpic({ id: "t1", status: "todo", position: 5 });
    fakes.mergeOutcome({
      status: "conflict",
      error: "CONFLICT",
      sessionId: "merge-fix-1",
    });

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(result.mergeConflicts).toEqual(["m1"]);
    expect(autoModeRegistry.countInFlight(PROJECT_ID).build).toBe(1);
    // The budget of 1 is spent on the merge fix, so no build goes out.
    expect(result.buildsDispatched).toEqual([]);
  });

  it("refuses to dispatch a conflict agent when the build budget is 0", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 0, reviewConcurrency: 0 });
    seedMergeable();
    fakes.mergeOutcome({ status: "merged", commitHash: "c", sessionId: null });

    await sweepProject(PROJECT_ID, fakes.deps);

    // 0 builds means "run no code agents" — and a merge-fix agent is one.
    expect(fakes.mergeOptions[0]).toMatchObject({
      dispatchConflictAgent: false,
    });
  });

  it("refuses a second conflict agent once the build budget is spent", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 1, reviewConcurrency: 0 });
    seedMergeable();
    seedMergeable("m2");
    let call = 0;
    fakes.mergeImplementation(() => {
      call += 1;
      return call === 1
        ? { status: "conflict", error: "CONFLICT", sessionId: "fix-1" }
        : { status: "merged", commitHash: "c", sessionId: null };
    });

    await sweepProject(PROJECT_ID, fakes.deps);

    expect(fakes.mergeOptions).toHaveLength(2);
    expect(fakes.mergeOptions[0]).toMatchObject({
      dispatchConflictAgent: true,
    });
    // The first conflict took the only build slot.
    expect(fakes.mergeOptions[1]).toMatchObject({
      dispatchConflictAgent: false,
    });
  });

  it("does not park an epic whose merge was refused by a guard", async () => {
    const fakes = makeFakes();
    seedMergeable();
    fakes.mergeOutcome({
      status: "skipped",
      reason: "unresolved review comments",
      sessionId: null,
    });

    for (let i = 0; i < 4; i += 1) await sweepProject(PROJECT_ID, fakes.deps);

    expect(autoModeRegistry.isParked(PROJECT_ID, "m1")).toBe(false);
  });

  it("parks an epic after three hard merge failures", async () => {
    const fakes = makeFakes();
    seedMergeable();
    fakes.mergeOutcome({
      status: "failed",
      error: "Branch not found",
      sessionId: null,
    });

    await sweepProject(PROJECT_ID, fakes.deps);
    await sweepProject(PROJECT_ID, fakes.deps);
    const third = await sweepProject(PROJECT_ID, fakes.deps);

    expect(third.parked).toContain("m1");
    expect(autoModeRegistry.isParked(PROJECT_ID, "m1")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Mutex + lifecycle                                                   */
/* ------------------------------------------------------------------ */

describe("per-project mutex", () => {
  it("never lets two sweeps of the same project overlap", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 4, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo", position: 0 });
    addEpic({ id: "t2", status: "todo", position: 1 });

    // Make the dispatcher await a gate so the first sweep is still inside its
    // critical section when the second one starts.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const inner = fakes.deps.dispatch;
    let firstCall = true;
    fakes.deps.dispatch = async (input) => {
      if (firstCall) {
        firstCall = false;
        await gate;
      }
      return inner(input);
    };

    const firstSweep = sweepProject(PROJECT_ID, fakes.deps);
    const secondSweep = sweepProject(PROJECT_ID, fakes.deps);

    expect((await secondSweep).skipped).toBe("locked");
    releaseGate();
    const first = await firstSweep;
    expect(first.skipped).toBeNull();
    expect(first.buildsDispatched).toHaveLength(2);
  });

  it("releases the lock even when the sweep throws", async () => {
    const fakes = makeFakes();
    addEpic({ id: "t1", status: "todo" });
    fakes.deps.loadBoard = () => {
      throw new Error("board exploded");
    };

    const result = await sweepProject(PROJECT_ID, fakes.deps);
    expect(result.skipped).toBeNull();
    expect(autoModeRegistry.isSweeping(PROJECT_ID)).toBe(false);

    fakes.deps.loadBoard = (projectId) => loadAutoModeBoard(projectId);
    const recovered = await sweepProject(PROJECT_ID, fakes.deps);
    expect(recovered.buildsDispatched).toHaveLength(1);
  });
});

describe("sweep() across projects", () => {
  it("sweeps every enabled project and records the sweep timestamp", async () => {
    const fakes = makeFakes();
    addEpic({ id: "t1", status: "todo" });

    const results = await sweep(new Date(Date.UTC(2026, 7, 19, 12, 0, 0)), fakes.deps);

    expect(results.map((r) => r.projectId)).toEqual([PROJECT_ID]);
    expect(autoModeRegistry.snapshot(PROJECT_ID).lastSweepAt).toBe(
      "2026-08-19T12:00:00.000Z"
    );
  });

  it("gives a project just switched off one final state-clearing sweep", async () => {
    const fakes = makeFakes();
    addEpic({ id: "t1", status: "todo" });
    await sweep(new Date(), fakes.deps);
    expect(autoModeRegistry.snapshot(PROJECT_ID).enabled).toBe(true);

    fakes.setConfig({ enabled: false });
    const results = await sweep(new Date(), fakes.deps);
    expect(results.map((r) => r.skipped)).toEqual(["disabled"]);
    expect(autoModeRegistry.snapshot(PROJECT_ID).enabled).toBe(false);
    expect(autoModeRegistry.snapshot(PROJECT_ID).inFlight).toEqual({
      build: 0,
      review: 0,
    });
  });
});

describe("mid-sweep disable", () => {
  it("stops dispatching the moment the user switches the mode off", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 5, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo", position: 0 });
    addEpic({ id: "t2", status: "todo", position: 1 });
    addEpic({ id: "t3", status: "todo", position: 2 });

    // A sweep spends real seconds inside git and agent dispatch. "Off" has to
    // mean off NOW, not "after the work already selected finishes".
    const inner = fakes.deps.dispatch;
    fakes.deps.dispatch = async (input) => {
      const result = await inner(input);
      fakes.setConfig({ enabled: false });
      return result;
    };

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(result.buildsDispatched).toHaveLength(1);
    expect(result.skipped).toBe("disabled");
    expect(fakes.dispatches).toHaveLength(1);
  });

  it("stops merging mid-sweep too", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 0, reviewConcurrency: 0 });
    addEpic({ id: "m1", status: "review", branchName: "feat/m1", position: 0 });
    addEpic({ id: "m2", status: "review", branchName: "feat/m2", position: 1 });
    for (const epicId of ["m1", "m2"]) {
      addSession({
        epicId,
        status: "completed",
        agentType: "build",
        createdAt: at(1),
        endedAt: at(2),
      });
      addSession({
        epicId,
        status: "completed",
        agentType: "review_code",
        createdAt: at(3),
        endedAt: at(4),
      });
    }

    fakes.mergeImplementation(() => {
      fakes.setConfig({ enabled: false });
      return { status: "merged", commitHash: "c", sessionId: null };
    });

    const result = await sweepProject(PROJECT_ID, fakes.deps);
    expect(fakes.merges).toHaveLength(1);
    expect(result.skipped).toBe("disabled");
  });
});

describe("silent reviews", () => {
  it("retries a silent review and parks the epic after three of them", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 0, reviewConcurrency: 1 });
    addEpic({ id: "r1", status: "review" });
    addSession({
      epicId: "r1",
      status: "completed",
      agentType: "build",
      createdAt: at(1),
      endedAt: at(2),
    });

    for (let i = 0; i < 3; i += 1) {
      const result = await sweepProject(PROJECT_ID, fakes.deps);
      expect(result.reviewsDispatched).toHaveLength(1);
      // Completed, but with nothing to approve with.
      settle(fakes, result.reviewsDispatched[0], "completed", "silent");
    }

    const final = await sweepProject(PROJECT_ID, fakes.deps);
    expect(final.parked).toEqual(["r1"]);
    expect(final.reviewsDispatched).toEqual([]);
    expect(autoReasons("r1")).toContain(
      "Auto mode parked this ticket after 3 consecutive failures"
    );
  });

  it("does not charge an asked_question review as a failure", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 0, reviewConcurrency: 1 });
    addEpic({ id: "r1", status: "review" });
    addSession({
      epicId: "r1",
      status: "completed",
      agentType: "build",
      createdAt: at(1),
      endedAt: at(2),
    });

    const first = await sweepProject(PROJECT_ID, fakes.deps);
    settle(fakes, first.reviewsDispatched[0], "completed", "asked_question");
    await sweepProject(PROJECT_ID, fakes.deps);

    expect(autoModeRegistry.listParked(PROJECT_ID)).toEqual([]);
  });
});

describe("refused terminal build transitions", () => {
  it("charges the failure ladder and parks instead of crediting success", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 1, reviewConcurrency: 0 });
    addEpic({ id: "held-build", status: "in_progress" });

    for (let i = 0; i < 3; i += 1) {
      const result = await sweepProject(PROJECT_ID, fakes.deps);
      expect(result.buildsDispatched).toHaveLength(1);
      settle(
        fakes,
        result.buildsDispatched[0],
        "completed",
        "transition_refused"
      );
    }

    const final = await sweepProject(PROJECT_ID, fakes.deps);
    expect(final.parked).toEqual(["held-build"]);
    expect(autoModeRegistry.isParked(PROJECT_ID, "held-build")).toBe(true);
    expect(fakes.dispatches.filter((d) => d.stage === "build")).toHaveLength(3);
  });
});

describe("last-moment build guard", () => {
  it("does not dispatch onto a ticket a human just moved to done", async () => {
    const fakes = makeFakes();
    fakes.setConfig({ buildConcurrency: 2, reviewConcurrency: 0 });
    addEpic({ id: "t1", status: "todo", position: 0 });
    addEpic({ id: "t2", status: "todo", position: 1 });

    // The board snapshot is milliseconds old; a human approving a ticket in
    // that window must win, or the build closure would drag it back to
    // in_progress.
    fakes.deps.dispatch = async (input) => {
      if (input.epicId === "t1") {
        return {
          sessionId: null,
          error: null,
          conflictSessionId: null,
          skipReason: "target is no longer buildable (now done)",
        };
      }
      return { sessionId: `late-${input.epicId}`, error: null, conflictSessionId: null };
    };

    const result = await sweepProject(PROJECT_ID, fakes.deps);

    expect(result.buildsDispatched).toEqual(["late-t2"]);
    // Not the ticket's fault, so nothing is charged…
    expect(autoModeRegistry.listParked(PROJECT_ID)).toEqual([]);
    // …but the skip is visible rather than silent.
    expect(autoReasons("t1")).toContain(
      "Auto mode skipped build: target is no longer buildable (now done)"
    );
  });
});

describe("kick deferral", () => {
  it("never sweeps synchronously — the caller's finalization must land first", async () => {
    vi.useFakeTimers();
    try {
      const fakes = makeFakes();
      addEpic({ id: "e1", status: "in_progress" });
      autoModeRegistry.setEnabled(PROJECT_ID, true);

      // The terminal hook fires from INSIDE markSessionTerminal, before the
      // dispatch closure applies the session's board effects. A sweep that
      // ran synchronously there would read the board mid-flight — and could
      // merge an epic whose negative review has not been applied yet.
      const sweeping = autoModeRegistry.isSweeping(PROJECT_ID);
      kickAutoMode(PROJECT_ID, 250);
      expect(autoModeRegistry.isSweeping(PROJECT_ID)).toBe(sweeping);
      expect(fakes.dispatches).toEqual([]);

      await vi.advanceTimersByTimeAsync(300);
    } finally {
      cancelPendingKicks();
      vi.useRealTimers();
    }
  });

  it("collapses a burst of kicks into a single sweep", async () => {
    vi.useFakeTimers();
    const sweeps: string[] = [];
    try {
      addEpic({ id: "e1", status: "todo" });
      db.insert(settings)
        .values({
          key: `auto_mode_enabled:${PROJECT_ID}`,
          value: JSON.stringify(false),
        })
        .run();

      // Ten sessions settling together are worth one sweep, not ten.
      for (let i = 0; i < 10; i += 1) kickAutoMode(PROJECT_ID, 250);
      await vi.advanceTimersByTimeAsync(300);
      sweeps.push("done");

      expect(autoModeRegistry.snapshot(PROJECT_ID).enabled).toBe(false);
    } finally {
      db.delete(settings).run();
      cancelPendingKicks();
      vi.useRealTimers();
    }
    expect(sweeps).toEqual(["done"]);
  });

  it("cancels pending kicks when the mode is stopped", async () => {
    vi.useFakeTimers();
    try {
      kickAutoMode(PROJECT_ID, 250);
      stopAutoMode();
      await vi.advanceTimersByTimeAsync(500);
      // Nothing ran: a stopped supervisor stays stopped.
      expect(autoModeRegistry.snapshot(PROJECT_ID).lastSweepAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("timer lifecycle", () => {
  it("start is idempotent and the interval never keeps the process alive", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      startAutoMode();
      startAutoMode();
      startAutoMode();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(isAutoModeRunning()).toBe(true);
      const timer = setIntervalSpy.mock.results[0].value as {
        unref?: () => void;
      };
      // Node timers expose unref(); the engine calls it so `npm run build`
      // and one-shot scripts can still exit.
      expect(typeof timer.unref).toBe("function");
    } finally {
      setIntervalSpy.mockRestore();
    }

    stopAutoMode();
    expect(isAutoModeRunning()).toBe(false);
    stopAutoMode();
    expect(isAutoModeRunning()).toBe(false);
  });

  it("survives a module re-evaluation through the globalThis slot", async () => {
    startAutoMode();
    expect(isAutoModeRunning()).toBe(true);
    vi.resetModules();
    const reloaded = await import("@/lib/auto-mode/engine");
    expect(reloaded.isAutoModeRunning()).toBe(true);
    reloaded.stopAutoMode();
    expect(isAutoModeRunning()).toBe(false);
  });
});
