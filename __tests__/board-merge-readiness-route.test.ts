/**
 * The board list route's merge-readiness signal
 * (GET /api/projects/[projectId]/epics).
 *
 * Everything runs against the real migrated schema, so this is also the only
 * place the readiness subqueries are actually EXECUTED — the sibling
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
const {
  APPROVAL_MERGE_BLOCKED_PREFIX,
  APPROVAL_CONFLICT_MARKERS_BLOCKED_PREFIX,
  buildMergeBlockedReason,
  buildMergeConflictMarkersBlockedReason,
} = await import("@/lib/workflow/merge-failure");
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
      status: input.status ?? "to_merge",
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
  mcpChannel?: string | null;
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
      mcpChannel: input.mcpChannel ?? null,
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
      fromStatus: "to_merge",
      toStatus: "to_merge",
      actor: "system",
      reason: input.reason,
      createdAt: input.createdAt,
    })
    .run();
}

/**
 * A To Merge epic with the history that puts one there: build at :10, review
 * with an approving verdict at :20, then the review-driven promotion. The
 * sessions no longer gate readiness — the `to_merge` STATUS is the review's
 * verdict — but seeding them keeps the fixture the shape production data has,
 * which is what the Full Auto parity test at the bottom leans on.
 */
function seedReadyEpic(id: string, position = 0): void {
  addEpic({ id, position });
  addSession({ epicId: id, agentType: "build", endedAt: at(10) });
  addSession({
    epicId: id,
    agentType: "review_code",
    reviewVerdict: "approved",
    endedAt: at(20),
  });
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
  it("marks a To Merge epic with a branch and no conflict as ready", async () => {
    seedReadyEpic("ready");
    expect(await readinessOf("ready")).toEqual({
      ready: true,
      blocker: null,
      openFindings: 0,
    });
  });

  it("echoes open findings as information without blocking the merge", async () => {
    // The merge IS the approval: whatever stays open is resolved by the merge
    // itself, so the count rides along for the card but gates nothing.
    seedReadyEpic("findings");
    addOpenFinding("findings");
    addOpenFinding("findings");
    expect(await readinessOf("findings")).toEqual({
      ready: true,
      blocker: null,
      openFindings: 2,
    });
  });

  it("does not count findings that were resolved", async () => {
    seedReadyEpic("resolved");
    addOpenFinding("resolved");
    db.update(reviewComments).set({ status: "resolved" }).run();
    expect(await readinessOf("resolved")).toMatchObject({
      ready: true,
      openFindings: 0,
    });
  });

  it("stays ready when a build lands after the promotion", async () => {
    // Review freshness is no longer a readiness input: the `to_merge` status
    // carries the verdict, and a later code session earns a re-review through
    // the workflow, not a blocked card.
    seedReadyEpic("rebuilt");
    addSession({ epicId: "rebuilt", agentType: "build", endedAt: at(30) });
    expect(await readinessOf("rebuilt")).toMatchObject({
      ready: true,
      blocker: null,
    });
  });

  it("stays ready when a STORY build commits to the epic's branch", async () => {
    seedReadyEpic("story-rebuilt");
    addStory({ id: "story-rebuilt-1", epicId: "story-rebuilt" });
    addSession({
      epicId: "story-rebuilt",
      agentType: "build",
      userStoryId: "story-rebuilt-1",
      endedAt: at(30),
    });
    expect(await readinessOf("story-rebuilt")).toMatchObject({ ready: true });
  });

  it("reads the status as the verdict, except for a standing rejection", async () => {
    // A missing review round is not the card's business: an epic that reaches
    // `to_merge` without one (drag, import) is the transition service's
    // problem, and the board must not second-guess the status.
    addEpic({ id: "no-review-history" });
    expect(await readinessOf("no-review-history")).toMatchObject({
      ready: true,
    });

    addEpic({ id: "rejected-history", position: 1 });
    addSession({
      epicId: "rejected-history",
      agentType: "review_code",
      reviewVerdict: "changes_requested",
      endedAt: at(20),
    });
    // The one review fact the status cannot carry, and the only one the card
    // still reads: a `changes_requested` verdict with no fix a reviewer has
    // since read. The workflow engine refuses THAT merge
    // (lib/workflow/engine.ts), so the board must refuse it too — offering
    // Full Auto a candidate the engine then rejects costs a real merge and a
    // rollback on every sweep.
    expect(await readinessOf("rejected-history")).toMatchObject({
      ready: false,
      blocker: "changes_requested",
    });
  });

  it("is ready again once a fix and a clean verdict answer the rejection", async () => {
    // A rejection is answered by a fix a reviewer has since READ: the build
    // at :25 and the clean verdict at :30 that read it clear it together.
    // The build at :40 does not put the card back — review freshness stopped
    // being a readiness input when `to_merge` became the verdict.
    addEpic({ id: "cleared-then-rebuilt" });
    addSession({
      epicId: "cleared-then-rebuilt",
      agentType: "build",
      endedAt: at(10),
    });
    addSession({
      epicId: "cleared-then-rebuilt",
      agentType: "review_code",
      reviewVerdict: "changes_requested",
      endedAt: at(20),
    });
    addSession({
      epicId: "cleared-then-rebuilt",
      agentType: "build",
      endedAt: at(25),
    });
    addSession({
      epicId: "cleared-then-rebuilt",
      agentType: "review_code",
      reviewVerdict: "approved",
      endedAt: at(30),
    });
    addSession({
      epicId: "cleared-then-rebuilt",
      agentType: "build",
      endedAt: at(40),
    });
    expect(await readinessOf("cleared-then-rebuilt")).toMatchObject({
      ready: true,
      blocker: null,
    });
  });

  it("reports a To Merge epic with no branch as having nothing to land", async () => {
    addEpic({ id: "branchless", branchName: null });
    expect(await readinessOf("branchless")).toMatchObject({
      blocker: "no_branch",
    });
  });

  it("never marks a ticket outside To Merge as ready", async () => {
    for (const status of ["backlog", "todo", "in_progress", "review", "done"]) {
      addEpic({ id: `outside-${status}`, status });
    }
    for (const status of ["backlog", "todo", "in_progress", "review", "done"]) {
      expect(await readinessOf(`outside-${status}`)).toMatchObject({
        ready: false,
        blocker: "not_to_merge",
      });
    }
  });

  it("surfaces the merge route's failed merge as a conflict, echoing the findings", async () => {
    seedReadyEpic("conflict");
    addOpenFinding("conflict");
    addActivity({
      epicId: "conflict",
      reason: buildMergeBlockedReason({
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

  it("surfaces the merge route's conflict-markers refusal as conflict_markers", async () => {
    seedReadyEpic("markers");
    addActivity({
      epicId: "markers",
      reason: buildMergeConflictMarkersBlockedReason({
        branchName: "feature/markers",
        error: "Unresolved conflict markers in lib/foo.ts",
      }),
      createdAt: at(40),
    });
    expect(await readinessOf("markers")).toMatchObject({
      ready: false,
      blocker: "conflict_markers",
    });
  });

  it("still reads the RETIRED approve route's historical conflict rows", async () => {
    // The approve route is gone, but the rows it wrote are permanent activity
    // history — reconstructed inline from the surviving prefixes.
    seedReadyEpic("legacy-conflict");
    addActivity({
      epicId: "legacy-conflict",
      reason: `${APPROVAL_MERGE_BLOCKED_PREFIX}feature/legacy-conflict failed — CONFLICT (content)`,
      createdAt: at(40),
    });
    expect(await readinessOf("legacy-conflict")).toMatchObject({
      blocker: "merge_conflict",
    });

    seedReadyEpic("legacy-markers", 1);
    addActivity({
      epicId: "legacy-markers",
      reason: `${APPROVAL_CONFLICT_MARKERS_BLOCKED_PREFIX}feature/legacy-markers — Unresolved conflict markers in lib/foo.ts`,
      createdAt: at(40),
    });
    expect(await readinessOf("legacy-markers")).toMatchObject({
      blocker: "conflict_markers",
    });
  });

  it("surfaces auto-mode's conflict-markers trace as conflict_markers blocker", async () => {
    seedReadyEpic("auto-markers");
    addActivity({
      epicId: "auto-markers",
      reason: AUTO_MODE_REASONS.mergeFailed(
        "conflict-markers",
        "Unresolved markers in lib/foo.ts"
      ),
      createdAt: at(40),
    });
    expect(await readinessOf("auto-markers")).toMatchObject({
      blocker: "conflict_markers",
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
      reason: AUTO_MODE_REASONS.mergeRefused("A story is still to build"),
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
    // The conflict is no longer the branch's current state, so the epic is
    // simply ready again — nothing else stands between it and main.
    expect(await readinessOf("repaired")).toMatchObject({
      ready: true,
      blocker: null,
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
    expect(row).not.toHaveProperty("lastMergeConflictAt");
    expect(row).not.toHaveProperty("lastConflictMarkersAt");
  });

  it("ignores another project's merge-failure rows", async () => {
    // The subquery is narrowed by projectId so the index bounds the scan
    // before the LIKEs run. That narrowing must be behaviour-preserving —
    // and it must not have been load-bearing for correctness either, since
    // the join to `epics` already scopes the result.
    seedReadyEpic("mine");

    db.insert(projects)
      .values({
        id: "other-project",
        name: "Other",
        gitRepoPath: "/tmp/other",
        createdAt: at(0),
      })
      .run();
    db.insert(epics)
      .values({
        id: "theirs",
        projectId: "other-project",
        title: "theirs",
        status: "to_merge",
        priority: 0,
        position: 0,
        branchName: "feature/theirs",
        createdAt: at(0),
        updatedAt: at(0),
      })
      .run();
    db.insert(ticketActivityLog)
      .values({
        id: nextId("act"),
        projectId: "other-project",
        epicId: "theirs",
        fromStatus: "to_merge",
        toStatus: "to_merge",
        actor: "system",
        reason: AUTO_MODE_REASONS.mergeConflict,
        createdAt: at(40),
      })
      .run();

    expect(await readinessOf("mine")).toMatchObject({ ready: true });
    const rows = await readBoard();
    expect(rows.map((row) => row.id)).toEqual(["mine"]);
  });

  it("ignores another project's open findings rows", async () => {
    seedReadyEpic("mine");

    db.insert(projects)
      .values({
        id: "other-project-findings",
        name: "Other",
        gitRepoPath: "/tmp/other-findings",
        createdAt: at(0),
      })
      .run();
    db.insert(epics)
      .values({
        id: "theirs-findings",
        projectId: "other-project-findings",
        title: "theirs",
        status: "to_merge",
        priority: 0,
        position: 0,
        branchName: "feature/theirs-findings",
        createdAt: at(0),
        updatedAt: at(0),
      })
      .run();
    addOpenFinding("theirs-findings");
    expect(await readinessOf("mine")).toMatchObject({
      ready: true,
      openFindings: 0,
    });
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
      openFindings: 1,
    });
  });
});

describe("board / Full Auto parity", () => {
  it("agrees with selectMergeCandidates on the same board", async () => {
    seedReadyEpic("ready-a", 0);
    seedReadyEpic("ready-b", 1);
    // Open findings block neither side any more — the merge resolves them.
    seedReadyEpic("with-findings", 2);
    addOpenFinding("with-findings");
    addEpic({ id: "branchless", branchName: null, position: 3 });
    addEpic({ id: "still-in-review", status: "review", position: 4 });

    const boardReady = (await readBoard())
      .filter(
        (row) => (row.mergeReadiness as { ready: boolean } | null)?.ready
      )
      .map((row) => row.id)
      .sort();

    const autoReady = selectMergeCandidates(PROJECT_ID)
      .map((candidate) => candidate.epicId)
      .sort();

    expect(boardReady).toEqual(["ready-a", "ready-b", "with-findings"]);
    expect(autoReady).toEqual(boardReady);
  });
});
