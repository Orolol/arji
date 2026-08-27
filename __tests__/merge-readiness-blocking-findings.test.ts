/**
 * Which OPEN review findings actually keep a reviewed epic out of "Ready to
 * merge" — and out of `review -> done`.
 *
 * The bug this pins: a ticket whose newest review came back APPROVED sat in
 * the Review column's lower section forever, reporting "N open findings",
 * because `review_comments` rows are never resolved by the pipeline (see the
 * "no auto-resolve" note in lib/pipeline/findings.ts) and the merge gate
 * counted every last one of them:
 *
 *   - a `[minor]`/`[info]` finding filed BY the approving review — the
 *     reviewer's own vocabulary for "not blocking", and exactly what an
 *     `approved_with_minor_issues` verdict means;
 *   - a `[critical]`/`[major]` from an EARLIER round that a later clean
 *     review, run on the fixed code, did not re-report.
 *
 * `lib/pipeline/findings.ts` has always defined blocking narrowly — open,
 * agent-authored, `[critical]`/`[major]`, and inside the CURRENT review
 * stage's window. The board, Full Auto's merge selector and the workflow
 * engine each counted "any open row" instead. This file is the parity
 * harness for the one shared definition.
 *
 * Everything runs against the real migrated schema, so the correlated
 * subquery behind the predicate is actually EXECUTED here.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockRouteContext } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions, reviewComments } = await import(
  "@/lib/db/schema"
);
const { GET } = await import("@/app/api/projects/[projectId]/epics/route");
const { selectMergeCandidates } = await import("@/lib/auto-mode/select");
const { buildTransitionContext } = await import("@/lib/workflow/context");
const { autoModeRegistry } = await import("@/lib/auto-mode/registry");

const PROJECT_ID = "proj-blocking";

/** Monotonic clock so "filed before / during the review" is unambiguous. */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 7, 26, 10, minute, 0)).toISOString();
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function addEpic(id: string, position = 0): void {
  db.insert(epics)
    .values({
      id,
      projectId: PROJECT_ID,
      title: id,
      status: "review",
      priority: 0,
      position,
      branchName: `feature/${id}`,
      readableId: `E-${id}`,
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
}

function addSession(input: {
  epicId: string;
  agentType: string;
  status?: string;
  outcome?: string | null;
  reviewVerdict?: string | null;
  startedAt?: string;
  endedAt: string;
}): void {
  db.insert(agentSessions)
    .values({
      id: nextId("sess"),
      projectId: PROJECT_ID,
      epicId: input.epicId,
      userStoryId: null,
      status: input.status ?? "completed",
      agentType: input.agentType,
      outcome: input.outcome === undefined ? "answered" : input.outcome,
      reviewVerdict: input.reviewVerdict ?? null,
      startedAt: input.startedAt ?? input.endedAt,
      endedAt: input.endedAt,
      createdAt: input.startedAt ?? input.endedAt,
    })
    .run();
}

function addFinding(input: {
  epicId: string;
  body: string;
  author?: string;
  status?: string;
  createdAt: string;
}): void {
  db.insert(reviewComments)
    .values({
      id: nextId("finding"),
      epicId: input.epicId,
      filePath: "lib/thing.ts",
      lineNumber: 12,
      body: input.body,
      author: input.author ?? "agent",
      status: input.status ?? "open",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    })
    .run();
}

/**
 * The shape of every epic here: built at :10, reviewed clean from :20 to :25.
 * A finding filed at :22 is IN that review's window; one filed at :15 belongs
 * to a superseded round.
 */
function seedApprovedEpic(id: string, position = 0): void {
  addEpic(id, position);
  addSession({ epicId: id, agentType: "build", endedAt: at(10) });
  addSession({
    epicId: id,
    agentType: "review_code",
    reviewVerdict: "approved",
    startedAt: at(20),
    endedAt: at(25),
  });
}

/** Round 1 requested changes at :15, a fix landed at :18, round 2 approved. */
function seedSecondRoundApprovedEpic(id: string, position = 0): void {
  addEpic(id, position);
  addSession({ epicId: id, agentType: "build", endedAt: at(10) });
  addSession({
    epicId: id,
    agentType: "review_code",
    reviewVerdict: "changes_requested",
    startedAt: at(12),
    endedAt: at(16),
  });
  addSession({ epicId: id, agentType: "build", endedAt: at(18) });
  addSession({
    epicId: id,
    agentType: "review_code",
    reviewVerdict: "approved",
    startedAt: at(20),
    endedAt: at(25),
  });
}

async function readinessOf(epicId: string) {
  const response = await GET(
    {} as never,
    mockRouteContext({ projectId: PROJECT_ID })
  );
  expect(response.status).toBe(200);
  const json = await response.json();
  const row = json.data.find(
    (candidate: { id: string }) => candidate.id === epicId
  );
  expect(row, `epic ${epicId} missing from the board payload`).toBeDefined();
  return row.mergeReadiness as {
    ready: boolean;
    blocker: string | null;
    openFindings: number;
  };
}

function engineSeesOpenComments(epicId: string): boolean {
  return buildTransitionContext({
    epicId,
    fromStatus: "review",
    toStatus: "done",
    actor: "user",
  }).hasOpenReviewComments;
}

beforeEach(() => {
  for (const table of [reviewComments, agentSessions, epics, projects]) {
    db.delete(table).run();
  }
  autoModeRegistry.resetAll();
  seq = 0;
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Blocking",
      gitRepoPath: "/tmp/blocking",
      createdAt: at(0),
    })
    .run();
});

describe("merge readiness — which open findings block", () => {
  it("keeps blocking on a [critical] filed by the approving review", async () => {
    seedApprovedEpic("critical-now");
    addFinding({
      epicId: "critical-now",
      body: "[critical] Token leaks into the log",
      createdAt: at(22),
    });
    expect(await readinessOf("critical-now")).toEqual({
      ready: false,
      blocker: "open_findings",
      openFindings: 1,
    });
    expect(engineSeesOpenComments("critical-now")).toBe(true);
  });

  it("keeps blocking on a [major] filed by the approving review", async () => {
    seedApprovedEpic("major-now");
    addFinding({
      epicId: "major-now",
      body: "[major] Race can merge stale code",
      createdAt: at(22),
    });
    expect(await readinessOf("major-now")).toMatchObject({
      ready: false,
      blocker: "open_findings",
      openFindings: 1,
    });
    expect(engineSeesOpenComments("major-now")).toBe(true);
  });

  it("does not block on a [minor] the approving review itself filed", async () => {
    seedApprovedEpic("minor-now");
    addFinding({
      epicId: "minor-now",
      body: "[minor] **Coverage**: worth a case for the empty list",
      createdAt: at(22),
    });
    expect(await readinessOf("minor-now")).toEqual({
      ready: true,
      blocker: null,
      openFindings: 0,
    });
    expect(engineSeesOpenComments("minor-now")).toBe(false);
  });

  it("does not block on an [info] note", async () => {
    seedApprovedEpic("info-now");
    addFinding({
      epicId: "info-now",
      body: "[info] Residual robustness gap, not a confirmed break",
      createdAt: at(22),
    });
    expect(await readinessOf("info-now")).toMatchObject({ ready: true });
    expect(engineSeesOpenComments("info-now")).toBe(false);
  });

  it("stops blocking on a [major] a later clean review superseded", async () => {
    seedSecondRoundApprovedEpic("superseded");
    addFinding({
      epicId: "superseded",
      body: "[major] Retry reuses the reviewer's agent",
      createdAt: at(15),
    });
    expect(await readinessOf("superseded")).toEqual({
      ready: true,
      blocker: null,
      openFindings: 0,
    });
    expect(engineSeesOpenComments("superseded")).toBe(false);
  });

  it("keeps blocking on a [critical] no clean review has superseded yet", async () => {
    addEpic("unreviewed-critical");
    addSession({ epicId: "unreviewed-critical", agentType: "build", endedAt: at(10) });
    addFinding({
      epicId: "unreviewed-critical",
      body: "[critical] Deletes the worktree of another epic",
      createdAt: at(12),
    });
    expect(await readinessOf("unreviewed-critical")).toMatchObject({
      blocker: "open_findings",
      openFindings: 1,
    });
    expect(engineSeesOpenComments("unreviewed-critical")).toBe(true);
  });

  it("always blocks on a human's own open review comment", async () => {
    seedApprovedEpic("human-hold");
    addFinding({
      epicId: "human-hold",
      body: "Not until we discuss the migration",
      author: "user",
      createdAt: at(15),
    });
    expect(await readinessOf("human-hold")).toMatchObject({
      ready: false,
      blocker: "open_findings",
      openFindings: 1,
    });
    expect(engineSeesOpenComments("human-hold")).toBe(true);
  });

  it("blocks on an agent finding with no severity prefix", async () => {
    seedApprovedEpic("unprefixed");
    addFinding({
      epicId: "unprefixed",
      body: "This needs another look before merging",
      createdAt: at(22),
    });
    expect(await readinessOf("unprefixed")).toMatchObject({
      blocker: "open_findings",
      openFindings: 1,
    });
  });

  it("still ignores resolved rows whatever their severity", async () => {
    seedApprovedEpic("resolved");
    addFinding({
      epicId: "resolved",
      body: "[critical] Already handled",
      status: "resolved",
      createdAt: at(22),
    });
    expect(await readinessOf("resolved")).toMatchObject({ ready: true });
    expect(engineSeesOpenComments("resolved")).toBe(false);
  });

  it("counts only the blocking rows when several kinds are open", async () => {
    seedSecondRoundApprovedEpic("mixed");
    addFinding({
      epicId: "mixed",
      body: "[major] Superseded by the second round",
      createdAt: at(15),
    });
    addFinding({
      epicId: "mixed",
      body: "[minor] Cosmetic",
      createdAt: at(22),
    });
    addFinding({
      epicId: "mixed",
      body: "[critical] Still standing",
      createdAt: at(22),
    });
    expect(await readinessOf("mixed")).toMatchObject({
      ready: false,
      blocker: "open_findings",
      openFindings: 1,
    });
  });

  it("scopes the supersession window to the finding's own epic", async () => {
    // A clean review on a NEIGHBOUR must not clear this epic's [major].
    seedApprovedEpic("neighbour", 0);
    addEpic("laggard", 1);
    addSession({ epicId: "laggard", agentType: "build", endedAt: at(10) });
    addFinding({
      epicId: "laggard",
      body: "[major] Still open here",
      createdAt: at(12),
    });
    expect(await readinessOf("neighbour")).toMatchObject({ ready: true });
    expect(await readinessOf("laggard")).toMatchObject({
      blocker: "open_findings",
      openFindings: 1,
    });
  });
});

describe("board / Full Auto parity on blocking findings", () => {
  it("agrees with selectMergeCandidates once the definition narrows", async () => {
    seedApprovedEpic("p-minor", 0);
    addFinding({
      epicId: "p-minor",
      body: "[minor] Cosmetic",
      createdAt: at(22),
    });
    seedSecondRoundApprovedEpic("p-superseded", 1);
    addFinding({
      epicId: "p-superseded",
      body: "[major] Superseded",
      createdAt: at(15),
    });
    seedApprovedEpic("p-critical", 2);
    addFinding({
      epicId: "p-critical",
      body: "[critical] Standing",
      createdAt: at(22),
    });

    const response = await GET(
      {} as never,
      mockRouteContext({ projectId: PROJECT_ID })
    );
    const json = await response.json();
    const boardReady = json.data
      .filter(
        (row: { mergeReadiness: { ready: boolean } | null }) =>
          row.mergeReadiness?.ready
      )
      .map((row: { id: string }) => row.id)
      .sort();

    const autoReady = selectMergeCandidates(PROJECT_ID)
      .map((candidate) => candidate.epicId)
      .sort();

    expect(boardReady).toEqual(["p-minor", "p-superseded"]);
    expect(autoReady).toEqual(boardReady);
  });
});
