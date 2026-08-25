/**
 * Tests for the Full Auto Mode candidate selectors (lib/auto-mode/select.ts).
 *
 * Everything is real against the migrated in-memory schema: the queries, the
 * awaiting-reply predicate, and the three in-memory registries the batch
 * route already refuses on. Only the database module is swapped for an
 * isolated `createTestDb()`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
} = await import("@/lib/db/schema");
const {
  loadAutoModeBoard,
  selectBuildCandidates,
  selectReviewCandidates,
  selectMergeCandidates,
} = await import("@/lib/auto-mode/select");
const { autoModeRegistry } = await import("@/lib/auto-mode/registry");
const { pipelineRegistry } = await import("@/lib/pipeline/registry");
const { dagBatchRegistry } = await import("@/lib/agents/dag-batch-registry");
const { nightRunRegistry } = await import("@/lib/night/registry");

const PROJECT_ID = "proj-auto";

/** Monotonic ISO clock so "newer than" assertions are unambiguous. */
let tick = 0;
function at(offsetMinutes: number): string {
  return new Date(Date.UTC(2026, 7, 19, 8, offsetMinutes, 0)).toISOString();
}
function nextId(prefix: string): string {
  tick += 1;
  return `${prefix}-${tick}`;
}

function seedProject(): void {
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Auto",
      gitRepoPath: "/tmp/auto",
      createdAt: at(0),
    })
    .run();
}

function addEpic(input: {
  id: string;
  status: string;
  priority?: number;
  position?: number;
  branchName?: string | null;
  title?: string;
}): void {
  db.insert(epics)
    .values({
      id: input.id,
      projectId: PROJECT_ID,
      title: input.title ?? input.id,
      status: input.status,
      priority: input.priority ?? 0,
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
  epicId?: string | null;
  userStoryId?: string | null;
  status: string;
  agentType?: string | null;
  /** Defaults to "answered" for completed sessions — what a real run stores. */
  outcome?: string | null;
  /** Structured submit_findings verdict persisted on the session row. */
  reviewVerdict?: string | null;
  createdAt: string;
  endedAt?: string | null;
}): string {
  const id = nextId("sess");
  db.insert(agentSessions)
    .values({
      id,
      projectId: PROJECT_ID,
      epicId: input.epicId ?? null,
      userStoryId: input.userStoryId ?? null,
      status: input.status,
      agentType: input.agentType ?? null,
      outcome:
        input.outcome !== undefined
          ? input.outcome
          : input.status === "completed"
            ? "answered"
            : null,
      reviewVerdict: input.reviewVerdict ?? null,
      createdAt: input.createdAt,
      endedAt: input.endedAt ?? null,
    })
    .run();
  return id;
}

function addUserComment(input: {
  epicId?: string | null;
  userStoryId?: string | null;
  createdAt: string;
}): void {
  db.insert(ticketComments)
    .values({
      id: nextId("cmt"),
      epicId: input.epicId ?? null,
      userStoryId: input.userStoryId ?? null,
      author: "user",
      content: "here you go",
      createdAt: input.createdAt,
    })
    .run();
}

function addOpenReviewComment(epicId: string): void {
  db.insert(reviewComments)
    .values({
      id: nextId("rc"),
      epicId,
      filePath: "lib/x.ts",
      lineNumber: 1,
      body: "[critical] fix this",
      author: "agent",
      status: "open",
      createdAt: at(1),
    })
    .run();
}

beforeEach(() => {
  db.delete(reviewComments).run();
  db.delete(ticketComments).run();
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  autoModeRegistry.resetAll();
  seedProject();
});

/* ------------------------------------------------------------------ */
/* Build candidates                                                    */
/* ------------------------------------------------------------------ */

describe("selectBuildCandidates", () => {
  it("picks backlog, todo and in_progress epics without stories, epic-scoped", () => {
    addEpic({ id: "e-todo", status: "todo" });
    addEpic({ id: "e-progress", status: "in_progress" });
    addEpic({ id: "e-backlog", status: "backlog" });
    addEpic({ id: "e-review", status: "review" });

    const ids = selectBuildCandidates(PROJECT_ID).map((c) => c.ticketId);
    expect(ids.sort()).toEqual(["e-backlog", "e-progress", "e-todo"]);
    expect(
      selectBuildCandidates(PROJECT_ID).every((c) => c.scope === "epic")
    ).toBe(true);
  });

  it("yields one story-scoped candidate for an epic that has stories", () => {
    addEpic({ id: "e1", status: "todo" });
    addStory({ id: "s1", epicId: "e1", status: "todo", position: 0 });
    addStory({ id: "s2", epicId: "e1", status: "todo", position: 1 });

    const candidates = selectBuildCandidates(PROJECT_ID);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      scope: "story",
      epicId: "e1",
      userStoryId: "s1",
      ticketId: "s1",
    });
  });

  it("skips stories already in review and moves to the next one", () => {
    addEpic({ id: "e1", status: "in_progress" });
    addStory({ id: "s1", epicId: "e1", status: "review", position: 0 });
    addStory({ id: "s2", epicId: "e1", status: "todo", position: 1 });

    expect(selectBuildCandidates(PROJECT_ID)[0].userStoryId).toBe("s2");
  });

  it("orders by epic priority DESC then position ASC", () => {
    addEpic({ id: "low", status: "todo", priority: 0, position: 0 });
    addEpic({ id: "high", status: "todo", priority: 3, position: 5 });
    addEpic({ id: "mid-a", status: "todo", priority: 1, position: 2 });
    addEpic({ id: "mid-b", status: "todo", priority: 1, position: 1 });

    expect(selectBuildCandidates(PROJECT_ID).map((c) => c.ticketId)).toEqual([
      "high",
      "mid-b",
      "mid-a",
      "low",
    ]);
  });

  it("never yields tickets whose epic is done or released", () => {
    addEpic({ id: "e-done", status: "done" });
    addEpic({ id: "e-released", status: "released" });
    addStory({ id: "s-done", epicId: "e-done", status: "todo" });

    expect(selectBuildCandidates(PROJECT_ID)).toEqual([]);
    expect(selectReviewCandidates(PROJECT_ID)).toEqual([]);
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("excludes a ticket holding an unanswered agent question", () => {
    addEpic({ id: "e1", status: "in_progress" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      outcome: "asked_question",
      createdAt: at(10),
      endedAt: at(11),
    });

    expect(selectBuildCandidates(PROJECT_ID)).toEqual([]);
  });

  it("re-admits the ticket once the user replies with a comment", () => {
    addEpic({ id: "e1", status: "in_progress" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      outcome: "asked_question",
      createdAt: at(10),
      endedAt: at(11),
    });
    addUserComment({ epicId: "e1", createdAt: at(20) });

    expect(selectBuildCandidates(PROJECT_ID).map((c) => c.ticketId)).toEqual([
      "e1",
    ]);
  });

  it("treats a bounced-back epic (in_progress, no agent) as buildable", () => {
    addEpic({ id: "e1", status: "in_progress" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      outcome: "answered",
      createdAt: at(10),
      endedAt: at(11),
    });

    expect(selectBuildCandidates(PROJECT_ID).map((c) => c.ticketId)).toEqual([
      "e1",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Shared exclusions                                                   */
/* ------------------------------------------------------------------ */

describe("shared exclusions", () => {
  it.each(["queued", "running"])(
    "excludes a ticket with a %s session from all three selectors",
    (status) => {
      addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
      addSession({
        epicId: "e1",
        status: "completed",
        agentType: "build",
        createdAt: at(1),
        endedAt: at(2),
      });
      addSession({
        epicId: "e1",
        status: "completed",
        agentType: "review_code",
        createdAt: at(3),
        endedAt: at(4),
      });
      addSession({
        epicId: "e1",
        status,
        agentType: "build",
        createdAt: at(10),
      });

      expect(selectBuildCandidates(PROJECT_ID)).toEqual([]);
      expect(selectReviewCandidates(PROJECT_ID)).toEqual([]);
      expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
    }
  );

  it("excludes a story whose PARENT epic has an active session", () => {
    addEpic({ id: "e1", status: "in_progress" });
    addStory({ id: "s1", epicId: "e1", status: "todo" });
    addSession({ epicId: "e1", status: "running", createdAt: at(5) });

    expect(selectBuildCandidates(PROJECT_ID)).toEqual([]);
  });

  it("excludes epics owned by a live pipeline run", () => {
    addEpic({ id: "e1", status: "todo" });
    addEpic({ id: "e2", status: "todo" });
    pipelineRegistry.register({
      runId: "run-1",
      projectId: PROJECT_ID,
      epicId: "e1",
      userStoryId: null,
      state: "running_build",
      stage: "build",
      stageAttempt: 1,
      fixCycles: 0,
      sessionIds: [],
      startedAt: at(0),
      endedAt: null,
      reason: null,
    });

    try {
      expect(selectBuildCandidates(PROJECT_ID).map((c) => c.ticketId)).toEqual([
        "e2",
      ]);
    } finally {
      pipelineRegistry.finish("run-1", "cancelled", null);
    }
  });

  it("excludes epics owned by a live night run", () => {
    addEpic({ id: "e1", status: "todo" });
    addEpic({ id: "e2", status: "todo" });
    nightRunRegistry.register({
      runId: "night_1",
      projectId: PROJECT_ID,
      failurePolicy: "halt",
      breakerThreshold: 0,
      costCapUsd: null,
      state: "running",
      startedAt: at(0),
      endedAt: null,
      currentWave: 1,
      totalWaves: 1,
      totalEpics: 1,
      counts: {
        pending: 1,
        running: 0,
        done: 0,
        asked: 0,
        failed: 0,
        skipped: 0,
      },
      epics: [
        { epicId: "e1", pipelineRunId: null, status: "pending", reason: null },
      ],
      stopRequested: false,
      abortReason: null,
      abortedAtWave: null,
    });

    try {
      expect(selectBuildCandidates(PROJECT_ID).map((c) => c.ticketId)).toEqual([
        "e2",
      ]);
    } finally {
      nightRunRegistry.finish("night_1");
    }
  });

  it("stands down entirely while a DAG wave batch owns the project", () => {
    addEpic({ id: "e1", status: "todo" });
    addEpic({ id: "e2", status: "review", branchName: "feat/e2" });
    dagBatchRegistry.start({
      batchId: "batch-1",
      projectId: PROJECT_ID,
      failurePolicy: "halt",
      totalWaves: 1,
      totalEpics: 1,
    });

    try {
      expect(selectBuildCandidates(PROJECT_ID)).toEqual([]);
      expect(selectReviewCandidates(PROJECT_ID)).toEqual([]);
      expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
    } finally {
      dagBatchRegistry.finish("batch-1");
    }
  });

  it("excludes parked tickets", () => {
    addEpic({ id: "e1", status: "todo" });
    addEpic({ id: "e2", status: "todo" });
    for (let i = 0; i < 3; i += 1) {
      autoModeRegistry.recordFailure(PROJECT_ID, "e1", "e1", "boom");
    }

    expect(selectBuildCandidates(PROJECT_ID).map((c) => c.ticketId)).toEqual([
      "e2",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Review candidates                                                   */
/* ------------------------------------------------------------------ */

describe("selectReviewCandidates", () => {
  it("selects an epic in review whose newest terminal session is a build", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });

    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
  });

  it("selects an epic in review that has never been reviewed", () => {
    addEpic({ id: "e1", status: "review" });
    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
  });

  it("does NOT re-review when the newest terminal review is newer than the code (infinite re-review guard)", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      createdAt: at(20),
      endedAt: at(21),
    });

    expect(selectReviewCandidates(PROJECT_ID)).toEqual([]);
  });

  it("re-reviews once new code lands after the last review", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      createdAt: at(20),
      endedAt: at(21),
    });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(30),
      endedAt: at(31),
    });

    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
  });

  it("tolerates SQLite CURRENT_TIMESTAMP formatting when comparing freshness", () => {
    addEpic({ id: "e1", status: "review" });
    // SQLite CURRENT_TIMESTAMP form (space separator) for the build...
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: "2026-08-19 09:00:00",
      endedAt: "2026-08-19 09:05:00",
    });
    // ...ISO form for the newer review.
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      createdAt: "2026-08-19T09:10:00.000Z",
      endedAt: "2026-08-19T09:15:00.000Z",
    });

    expect(selectReviewCandidates(PROJECT_ID)).toEqual([]);
  });

  it("ignores epics that are not in review", () => {
    addEpic({ id: "e1", status: "in_progress" });
    addEpic({ id: "e2", status: "done" });
    expect(selectReviewCandidates(PROJECT_ID)).toEqual([]);
  });

  it("retries a review that FAILED — a failed review is not a review", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "failed",
      agentType: "review_code",
      createdAt: at(20),
      endedAt: at(21),
    });

    // Otherwise the epic is stuck forever: never re-reviewed (a terminal
    // review exists) and never mergeable (no COMPLETED review), so the
    // parking ladder never even gets a second failure to count.
    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("retries a review that was CANCELLED", () => {
    addEpic({ id: "e1", status: "review" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "cancelled",
      agentType: "review_code",
      createdAt: at(20),
      endedAt: at(21),
    });

    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
  });

  it("retries a SILENT review, and never merges on one", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      outcome: "silent",
      createdAt: at(20),
      endedAt: at(21),
    });

    // A reviewer that produced no verdict reviewed nothing. Treating it as a
    // review would strand the epic — neither reviewable nor mergeable, with
    // no way to reach the parking threshold. The engine charges each silent
    // review as a failure instead, so the retries are bounded at three.
    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
    // …and it certainly did not approve anything.
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("never merges on a review with no recorded verdict (legacy rows)", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      outcome: null,
      createdAt: at(20),
      endedAt: at(21),
    });

    // Auto-merging on a verdict nobody ever recorded is precisely the thing
    // the gate exists to prevent; it earns one fresh, classified review.
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
  });

  it("re-reviews after an asked_question review once the user replies", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      outcome: "asked_question",
      createdAt: at(20),
      endedAt: at(21),
    });

    // Unanswered: held by the awaiting-reply guard.
    expect(selectReviewCandidates(PROJECT_ID)).toEqual([]);
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);

    addUserComment({ epicId: "e1", createdAt: at(30) });

    // Answered: the reviewer gets to finish its job — it must NOT become
    // mergeable just because a session with status 'completed' exists.
    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("ignores STORY-scoped review sessions at epic level", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addStory({ id: "s1", epicId: "e1", status: "review" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    // A story review is not the epic's review: reviews and merges are
    // epic-scoped because the branch is the integration unit.
    addSession({
      epicId: "e1",
      userStoryId: "s1",
      status: "completed",
      agentType: "review_code",
      createdAt: at(20),
      endedAt: at(21),
    });

    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("counts story BUILDS as code changes that stale an epic review", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addStory({ id: "s1", epicId: "e1", status: "review" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      createdAt: at(10),
      endedAt: at(11),
    });
    // A story build commits to the epic's branch, so the review above is now
    // stale even though it was epic-scoped.
    addSession({
      epicId: "e1",
      userStoryId: "s1",
      status: "completed",
      agentType: "ticket_build",
      createdAt: at(20),
      endedAt: at(21),
    });

    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });
});

describe("story questions do not hold the parent epic", () => {
  it("keeps the epic selectable when only a STORY asked a question", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addStory({ id: "s1", epicId: "e1", status: "review" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      userStoryId: "s1",
      status: "completed",
      agentType: "ticket_build",
      outcome: "asked_question",
      createdAt: at(20),
      endedAt: at(21),
    });

    // The story's question belongs to the story. Ranking it at epic level
    // would hold the epic hostage against a reply it cannot even see.
    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
  });

  it("accepts a reply on the EPIC as the answer to a story question", () => {
    addEpic({ id: "e1", status: "in_progress" });
    addStory({ id: "s1", epicId: "e1", status: "in_progress" });
    addSession({
      epicId: "e1",
      userStoryId: "s1",
      status: "completed",
      agentType: "ticket_build",
      outcome: "asked_question",
      createdAt: at(20),
      endedAt: at(21),
    });

    expect(selectBuildCandidates(PROJECT_ID)).toEqual([]);

    // handleAskedQuestionOutcome deep-links the notification to the EPIC, so
    // that is where the user actually replies.
    addUserComment({ epicId: "e1", createdAt: at(30) });

    expect(selectBuildCandidates(PROJECT_ID).map((c) => c.ticketId)).toEqual([
      "s1",
    ]);
  });

  it("also accepts a reply on the story itself", () => {
    addEpic({ id: "e1", status: "in_progress" });
    addStory({ id: "s1", epicId: "e1", status: "in_progress" });
    addSession({
      epicId: "e1",
      userStoryId: "s1",
      status: "completed",
      agentType: "ticket_build",
      outcome: "asked_question",
      createdAt: at(20),
      endedAt: at(21),
    });
    addUserComment({ userStoryId: "s1", createdAt: at(30) });

    expect(selectBuildCandidates(PROJECT_ID).map((c) => c.ticketId)).toEqual([
      "s1",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Merge candidates                                                    */
/* ------------------------------------------------------------------ */

describe("selectMergeCandidates", () => {
  function seedCleanlyReviewedEpic(): void {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      createdAt: at(20),
      endedAt: at(21),
    });
  }

  it("selects an epic reviewed clean since its last code change", () => {
    seedCleanlyReviewedEpic();
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([
      expect.objectContaining({ epicId: "e1", branchName: "feat/e1" }),
    ]);
  });

  it("never merges an epic with an open review comment", () => {
    seedCleanlyReviewedEpic();
    addOpenReviewComment("e1");
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("merges once the open review comment is resolved", () => {
    seedCleanlyReviewedEpic();
    addOpenReviewComment("e1");
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);

    db.update(reviewComments).set({ status: "resolved" }).run();
    expect(selectMergeCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
  });

  it("never merges an epic with no completed review", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("never merges when the only review FAILED", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "failed",
      agentType: "review_code",
      createdAt: at(20),
      endedAt: at(21),
    });
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("never merges an epic without a branch", () => {
    addEpic({ id: "e1", status: "review", branchName: null });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      createdAt: at(20),
      endedAt: at(21),
    });
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("never merges when code landed after the review", () => {
    seedCleanlyReviewedEpic();
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(30),
      endedAt: at(31),
    });
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
  });

  it("is mutually exclusive with the review selector", () => {
    seedCleanlyReviewedEpic();
    expect(selectReviewCandidates(PROJECT_ID)).toEqual([]);
    expect(selectMergeCandidates(PROJECT_ID)).toHaveLength(1);
  });

  it("never merges on an explicit changes_requested verdict, even with zero findings", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_code",
      reviewVerdict: "changes_requested",
      createdAt: at(20),
      endedAt: at(21),
    });

    // The reviewer said NO through the structured channel. Zero findings
    // must not launder that into a clean review — and the epic must stay
    // reviewable rather than stranded.
    expect(selectMergeCandidates(PROJECT_ID)).toEqual([]);
    expect(selectReviewCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
  });

  it("still merges on an explicit approved or approved_with_minor_issues verdict", () => {
    for (const verdict of ["approved", "approved_with_minor_issues"]) {
      db.delete(agentSessions).run();
      db.delete(epics).run();
      addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
      addSession({
        epicId: "e1",
        status: "completed",
        agentType: "build",
        createdAt: at(10),
        endedAt: at(11),
      });
      addSession({
        epicId: "e1",
        status: "completed",
        agentType: "review_code",
        reviewVerdict: verdict,
        createdAt: at(20),
        endedAt: at(21),
      });

      expect(selectMergeCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
        "e1",
      ]);
    }
  });

  it("keeps a NULL-verdict review clean (MCP-less providers)", () => {
    addEpic({ id: "e1", status: "review", branchName: "feat/e1" });
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "build",
      createdAt: at(10),
      endedAt: at(11),
    });
    // A provider without MCP support can never call submit_findings; its
    // prose verdict is the only signal, so the row stays NULL and the old
    // temporal gate applies unchanged.
    addSession({
      epicId: "e1",
      status: "completed",
      agentType: "review_compliance",
      createdAt: at(20),
      endedAt: at(21),
    });

    expect(selectMergeCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "e1",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Query budget                                                        */
/* ------------------------------------------------------------------ */

describe("query budget", () => {
  it("issues a bounded number of queries regardless of ticket count", () => {
    for (let i = 0; i < 40; i += 1) {
      addEpic({ id: `e${i}`, status: "todo", position: i });
      addStory({ id: `s${i}`, epicId: `e${i}`, status: "todo" });
      addSession({
        epicId: `e${i}`,
        status: "completed",
        agentType: "build",
        createdAt: at(i),
        endedAt: at(i + 1),
      });
    }

    const selectSpy = vi.spyOn(db, "select");
    try {
      const board = loadAutoModeBoard(PROJECT_ID);
      const queriesForBoard = selectSpy.mock.calls.length;
      // Nine board queries; the sub-selects of the two window-function CTEs
      // are built through the same `select` entry point, hence the ceiling.
      expect(queriesForBoard).toBeLessThanOrEqual(12);

      selectSpy.mockClear();
      selectBuildCandidates(PROJECT_ID, board);
      selectReviewCandidates(PROJECT_ID, board);
      selectMergeCandidates(PROJECT_ID, board);
      // With a pre-loaded board the selectors are pure in-memory filters.
      expect(selectSpy.mock.calls.length).toBe(0);

      expect(selectBuildCandidates(PROJECT_ID, board)).toHaveLength(40);
    } finally {
      selectSpy.mockRestore();
    }
  });
});
