/**
 * The board list route's merge-readiness signal
 * (GET /api/projects/[projectId]/epics).
 *
 * Everything runs against the real migrated schema, so this is also the only
 * place the three new subqueries are actually EXECUTED — the sibling
 * epics-route.test.ts mocks drizzle, which can prove a join was requested but
 * never that the SQL parses.
 *
 * The parity test at the bottom is the point of the whole epic: the same
 * board is handed to Full Auto's `selectMergeCandidates`, and the two must
 * agree on which epics are ready.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockRouteContext } from "@/__tests__/helpers/db-mock";

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
  reviewComments,
  ticketActivityLog,
} = await import("@/lib/db/schema");
const { GET } = await import("@/app/api/projects/[projectId]/epics/route");
const { selectMergeCandidates } = await import("@/lib/auto-mode/select");
const { AUTO_MODE_REASONS } = await import("@/lib/auto-mode/constants");
const { buildApprovalMergeBlockedReason } = await import(
  "@/lib/workflow/merge-failure"
);
const { autoModeRegistry } = await import("@/lib/auto-mode/registry");

const PROJECT_ID = "proj-board";

/** Monotonic clock so "newer than" is unambiguous in every assertion. */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 7, 20, 10, minute, 0)).toISOString();
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function seedProject(): void {
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Board",
      gitRepoPath: "/tmp/board",
      createdAt: at(0),
    })
    .run();
}

function addEpic(input: {
  id: string;
  status?: string;
  branchName?: string | null;
  position?: number;
}): void {
  db.insert(epics)
    .values({
      id: input.id,
      projectId: PROJECT_ID,
      title: input.id,
      status: input.status ?? "review",
      priority: 0,
      position: input.position ?? 0,
      branchName:
        input.branchName === undefined ? `feature/${input.id}` : input.branchName,
      readableId: `E-${input.id}`,
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
}

function addStory(input: { id: string; epicId: string }): void {
  db.insert(userStories)
    .values({
      id: input.id,
      epicId: input.epicId,
      title: input.id,
      status: "review",
      position: 0,
      createdAt: at(0),
    })
    .run();
}

function addSession(input: {
  epicId: string;
  agentType: string;
  status?: string;
  outcome?: string | null;
  reviewVerdict?: string | null;
  userStoryId?: string | null;
  endedAt: string;
}): void {
  db.insert(agentSessions)
    .values({
      id: nextId("sess"),
      projectId: PROJECT_ID,
      epicId: input.epicId,
      userStoryId: input.userStoryId ?? null,
      status: input.status ?? "completed",
      agentType: input.agentType,
      outcome: input.outcome === undefined ? "answered" : input.outcome,
      reviewVerdict: input.reviewVerdict ?? null,
      endedAt: input.endedAt,
      createdAt: input.endedAt,
    })
    .run();
}

function addOpenFinding(epicId: string): void {
  db.insert(reviewComments)
    .values({
      id: nextId("finding"),
      epicId,
      filePath: "lib/thing.ts",
      lineNumber: 12,
      body: "[major] Needs work",
      author: "agent",
      status: "open",
      createdAt: at(30),
      updatedAt: at(30),
    })
    .run();
}

function addActivity(input: {
  epicId: string;
  reason: string;
  createdAt: string;
}): void {
  db.insert(ticketActivityLog)
    .values({
      id: nextId("act"),
      projectId: PROJECT_ID,
      epicId: input.epicId,
      fromStatus: "review",
      toStatus: "review",
      actor: "system",
      reason: input.reason,
      createdAt: input.createdAt,
    })
    .run();
}

/** A clean, freshly reviewed epic: build at :10, review at :20. */
function seedReadyEpic(id: string, position = 0): void {
  addEpic({ id, position });
  addSession({ epicId: id, agentType: "build", endedAt: at(10) });
  addSession({ epicId: id, agentType: "review_code", endedAt: at(20) });
}

async function readBoard(): Promise<
  Array<Record<string, unknown> & { id: string }>
> {
  const response = await GET(
    {} as never,
    mockRouteContext({ projectId: PROJECT_ID })
  );
  expect(response.status).toBe(200);
  const json = await response.json();
  return json.data;
}

async function readinessOf(epicId: string) {
  const rows = await readBoard();
  const row = rows.find((r) => r.id === epicId);
  expect(row, `epic ${epicId} missing from the board payload`).toBeDefined();
  return row!.mergeReadiness as {
    ready: boolean;
    blocker: string | null;
    openFindings: number;
  };
}

beforeEach(() => {
  for (const table of [
    ticketActivityLog,
    reviewComments,
    agentSessions,
    userStories,
    epics,
    projects,
  ]) {
    db.delete(table).run();
  }
  autoModeRegistry.resetAll();
  seq = 0;
  seedProject();
});

describe("GET /api/projects/[projectId]/epics — merge readiness", () => {
  it("marks a freshly reviewed epic with no findings as ready", async () => {
    seedReadyEpic("ready");
    expect(await readinessOf("ready")).toEqual({
      ready: true,
      blocker: null,
      openFindings: 0,
    });
  });

  it("blocks on open findings and reports the count", async () => {
    seedReadyEpic("findings");
    addOpenFinding("findings");
    addOpenFinding("findings");
    expect(await readinessOf("findings")).toEqual({
      ready: false,
      blocker: "open_findings",
      openFindings: 2,
    });
  });

  it("ignores findings that were resolved", async () => {
    seedReadyEpic("resolved");
    addOpenFinding("resolved");
    db.update(reviewComments).set({ status: "resolved" }).run();
    expect(await readinessOf("resolved")).toMatchObject({ ready: true });
  });

  it("goes stale when a build lands after the review", async () => {
    seedReadyEpic("stale");
    addSession({ epicId: "stale", agentType: "build", endedAt: at(30) });
    expect(await readinessOf("stale")).toMatchObject({
      ready: false,
      blocker: "stale_review",
    });
  });

  it("goes stale when a STORY build commits to the epic's branch", async () => {
    seedReadyEpic("story-stale");
    addStory({ id: "story-stale-1", epicId: "story-stale" });
    addSession({
      epicId: "story-stale",
      agentType: "build",
      userStoryId: "story-stale-1",
      endedAt: at(30),
    });
    expect(await readinessOf("story-stale")).toMatchObject({
      blocker: "stale_review",
    });
  });

  it("does not count a changes_requested verdict as a review", async () => {
    addEpic({ id: "rejected" });
    addSession({ epicId: "rejected", agentType: "build", endedAt: at(10) });
    addSession({
      epicId: "rejected",
      agentType: "review_code",
      reviewVerdict: "changes_requested",
      endedAt: at(20),
    });
    expect(await readinessOf("rejected")).toMatchObject({
      blocker: "no_review",
    });
  });

  it("does not count a review that only asked a question", async () => {
    addEpic({ id: "asked" });
    addSession({ epicId: "asked", agentType: "build", endedAt: at(10) });
    addSession({
      epicId: "asked",
      agentType: "review_code",
      outcome: "asked_question",
      endedAt: at(20),
    });
    expect(await readinessOf("asked")).toMatchObject({ blocker: "no_review" });
  });

  it("does not let a STORY-scoped review satisfy the epic's gate", async () => {
    addEpic({ id: "story-review" });
    addSession({ epicId: "story-review", agentType: "build", endedAt: at(10) });
    addStory({ id: "story-review-1", epicId: "story-review" });
    addSession({
      epicId: "story-review",
      agentType: "review_code",
      userStoryId: "story-review-1",
      endedAt: at(20),
    });
    expect(await readinessOf("story-review")).toMatchObject({
      blocker: "no_review",
    });
  });

  it("reports an epic in review with no branch as having nothing to land", async () => {
    addEpic({ id: "branchless", branchName: null });
    addSession({ epicId: "branchless", agentType: "review_code", endedAt: at(20) });
    expect(await readinessOf("branchless")).toMatchObject({
      blocker: "no_branch",
    });
  });

  it("never marks a ticket outside Review as ready", async () => {
    addEpic({ id: "building", status: "in_progress" });
    addSession({ epicId: "building", agentType: "review_code", endedAt: at(20) });
    expect(await readinessOf("building")).toMatchObject({
      ready: false,
      blocker: "not_in_review",
    });
  });

  it("surfaces a failed approve-merge as a conflict, outranking the findings", async () => {
    seedReadyEpic("conflict");
    addOpenFinding("conflict");
    addActivity({
      epicId: "conflict",
      reason: buildApprovalMergeBlockedReason({
        branchName: "feature/conflict",
        error: "CONFLICT (content)",
      }),
      createdAt: at(40),
    });
    expect(await readinessOf("conflict")).toMatchObject({
      ready: false,
      blocker: "merge_conflict",
      openFindings: 1,
    });
  });

  it("surfaces auto-mode's conflict trace too", async () => {
    seedReadyEpic("auto-conflict");
    addActivity({
      epicId: "auto-conflict",
      reason: AUTO_MODE_REASONS.mergeConflict,
      createdAt: at(40),
    });
    expect(await readinessOf("auto-conflict")).toMatchObject({
      blocker: "merge_conflict",
    });
  });

  it("does not turn an ordinary guard refusal into a conflict", async () => {
    seedReadyEpic("refused");
    addActivity({
      epicId: "refused",
      reason: AUTO_MODE_REASONS.mergeRefused("Review comments are still open"),
      createdAt: at(40),
    });
    expect(await readinessOf("refused")).toMatchObject({ ready: true });
  });

  it("clears the conflict once the merge-fix agent rewrote the branch", async () => {
    seedReadyEpic("repaired");
    addActivity({
      epicId: "repaired",
      reason: AUTO_MODE_REASONS.mergeConflict,
      createdAt: at(40),
    });
    addSession({ epicId: "repaired", agentType: "merge", endedAt: at(50) });
    // The repair invalidated the review, which is the honest next blocker.
    expect(await readinessOf("repaired")).toMatchObject({
      blocker: "stale_review",
    });
  });

  it("reads SQLite-style activity timestamps as well as ISO ones", async () => {
    seedReadyEpic("sqlite-stamp");
    addActivity({
      epicId: "sqlite-stamp",
      reason: AUTO_MODE_REASONS.mergeConflict,
      createdAt: "2026-08-20 10:40:00",
    });
    expect(await readinessOf("sqlite-stamp")).toMatchObject({
      blocker: "merge_conflict",
    });
  });

  it("does not leak the raw readiness inputs into the payload", async () => {
    seedReadyEpic("clean-payload");
    const [row] = await readBoard();
    expect(row).not.toHaveProperty("openFindings");
    expect(row).not.toHaveProperty("lastCleanReviewAt");
    expect(row).not.toHaveProperty("lastTerminalCodeAt");
    expect(row).not.toHaveProperty("lastMergeFailureAt");
  });

  it("scopes every fact to its own epic", async () => {
    seedReadyEpic("clean", 0);
    seedReadyEpic("dirty", 1);
    addOpenFinding("dirty");
    addActivity({
      epicId: "dirty",
      reason: AUTO_MODE_REASONS.mergeConflict,
      createdAt: at(40),
    });

    expect(await readinessOf("clean")).toMatchObject({
      ready: true,
      openFindings: 0,
    });
    expect(await readinessOf("dirty")).toMatchObject({
      blocker: "merge_conflict",
    });
  });
});

describe("board / Full Auto parity", () => {
  it("agrees with selectMergeCandidates on the same board", async () => {
    seedReadyEpic("ready-a", 0);
    seedReadyEpic("ready-b", 1);
    seedReadyEpic("has-findings", 2);
    addOpenFinding("has-findings");
    seedReadyEpic("went-stale", 3);
    addSession({ epicId: "went-stale", agentType: "build", endedAt: at(40) });
    addEpic({ id: "never-reviewed", position: 4 });

    const boardReady = (await readBoard())
      .filter(
        (row) => (row.mergeReadiness as { ready: boolean } | null)?.ready
      )
      .map((row) => row.id)
      .sort();

    const autoReady = selectMergeCandidates(PROJECT_ID)
      .map((candidate) => candidate.epicId)
      .sort();

    expect(boardReady).toEqual(["ready-a", "ready-b"]);
    expect(autoReady).toEqual(boardReady);
  });
});
