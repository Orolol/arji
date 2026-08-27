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
const { projects, epics, userStories, agentSessions, reviewComments } =
  await import("@/lib/db/schema");
const { GET } = await import("@/app/api/projects/[projectId]/epics/route");
const { selectMergeCandidates } = await import("@/lib/auto-mode/select");
const { buildTransitionContext } = await import("@/lib/workflow/context");
const { validateTransition } = await import("@/lib/workflow/engine");
type TransitionContext = import("@/lib/workflow/engine").TransitionContext;
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
  userStoryId?: string | null;
  startedAt?: string;
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

function addStory(id: string, epicId: string): void {
  db.insert(userStories)
    .values({
      id,
      epicId,
      title: id,
      status: "review",
      position: 0,
      createdAt: at(0),
    })
    .run();
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
  for (const table of [
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

  it("does not let a review that recorded NO verdict supersede a [major]", async () => {
    // The gap this pins: `isCleanReviewSql` accepts a NULL verdict on purpose
    // (that is every MCP-less provider, and it answers "how fresh is the
    // verdict"). The supersession cutoff asks a different question — "did a
    // reviewer re-read this finding and decline to re-report it" — and a
    // session that filed nothing answers it with no evidence at all.
    // Reachable via an MCP 401 mid-review, a provider with no MCP tools, or
    // prose a parser could not read.
    addEpic("silent-round-two");
    addSession({
      epicId: "silent-round-two",
      agentType: "build",
      endedAt: at(10),
    });
    addSession({
      epicId: "silent-round-two",
      agentType: "review_code",
      reviewVerdict: "changes_requested",
      startedAt: at(12),
      endedAt: at(16),
    });
    addFinding({
      epicId: "silent-round-two",
      body: "[critical] Token leaks into the log",
      createdAt: at(15),
    });
    addSession({ epicId: "silent-round-two", agentType: "build", endedAt: at(18) });
    // Round two: completed and answered, but deposited no verdict at all.
    addSession({
      epicId: "silent-round-two",
      agentType: "review_code",
      reviewVerdict: null,
      startedAt: at(20),
      endedAt: at(25),
    });

    expect(await readinessOf("silent-round-two")).toMatchObject({
      ready: false,
      blocker: "open_findings",
      openFindings: 1,
    });
    expect(engineSeesOpenComments("silent-round-two")).toBe(true);
  });

  it("does not let a STORY-scoped review move the epic's cutoff", async () => {
    // Stories share the epic's branch and are serialised, so a story review
    // finishing after an epic-level [major] is an ordinary sequence. It must
    // not clear that finding: reviews and merges are epic-level by design.
    seedApprovedEpic("story-cutoff");
    addFinding({
      epicId: "story-cutoff",
      body: "[major] Filed by the epic review at :22",
      createdAt: at(22),
    });
    addStory("story-cutoff-1", "story-cutoff");
    addSession({
      epicId: "story-cutoff",
      agentType: "review_code",
      reviewVerdict: "approved",
      userStoryId: "story-cutoff-1",
      startedAt: at(30),
      endedAt: at(35),
    });

    expect(await readinessOf("story-cutoff")).toMatchObject({
      blocker: "open_findings",
      openFindings: 1,
    });
    expect(engineSeesOpenComments("story-cutoff")).toBe(true);
  });

  it("matches severity prefixes case-sensitively, so [MAJOR] is unclassified", async () => {
    // `=` under BINARY collation, chosen over LIKE precisely for this. Filed
    // BEFORE the clean review, so a LIKE-based match would read it as a
    // superseded [major] and stop blocking; an unclassified row always blocks.
    seedApprovedEpic("shouty");
    addFinding({
      epicId: "shouty",
      body: "[MAJOR] Reviewer shouted the severity",
      createdAt: at(15),
    });
    expect(await readinessOf("shouty")).toMatchObject({
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

/**
 * Narrowing "open" to "blocking" removed an accidental backstop: an epic
 * whose newest review said `changes_requested` used to be refused
 * `review -> done` because that review's rows were open. Only `[critical]`/
 * `[major]` count now, so a changes-requested review carrying nothing worse
 * than `[minor]` no longer refuses on findings alone — and the engine's only
 * other review input, `hasCompletedReview`, is satisfied by ANY completed
 * review session ever.
 *
 * The merge paths land a branch on the base branch, so they must not be the
 * ones to discover that. An explicit human `approve` still may: the spec
 * makes human approval itself the review decision.
 */
describe("review -> done under a standing changes_requested verdict", () => {
  function seedChangesRequestedEpic(id: string): void {
    addEpic(id);
    addSession({ epicId: id, agentType: "build", endedAt: at(10) });
    addSession({
      epicId: id,
      agentType: "review_code",
      reviewVerdict: "changes_requested",
      startedAt: at(20),
      endedAt: at(25),
    });
    // Only non-blocking severities, so the findings half cannot be what
    // refuses the transition.
    addFinding({ epicId: id, body: "[minor] Tidy this up", createdAt: at(22) });
  }

  function refusalFor(
    epicId: string,
    source: NonNullable<TransitionContext["source"]>
  ): string | null {
    const ctx = buildTransitionContext({
      epicId,
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
    });
    ctx.source = source;
    return validateTransition(ctx).error ?? null;
  }

  it("refuses a merge that would land the branch anyway", () => {
    seedChangesRequestedEpic("cr-merge");
    expect(engineSeesOpenComments("cr-merge")).toBe(false);
    expect(refusalFor("cr-merge", "merge")).toMatch(/requested changes/i);
  });

  it("still lets an explicit human approval through", () => {
    seedChangesRequestedEpic("cr-approve");
    expect(refusalFor("cr-approve", "approve")).toBeNull();
  });

  it("does not refuse once a newer review recorded a clean verdict", () => {
    seedChangesRequestedEpic("cr-cleared");
    addSession({ epicId: "cr-cleared", agentType: "build", endedAt: at(30) });
    addSession({
      epicId: "cr-cleared",
      agentType: "review_code",
      reviewVerdict: "approved",
      startedAt: at(40),
      endedAt: at(45),
    });
    expect(refusalFor("cr-cleared", "merge")).toBeNull();
  });

  it("ignores a verdict-less review when deciding, so NULL never clears it", () => {
    seedChangesRequestedEpic("cr-silent");
    addSession({ epicId: "cr-silent", agentType: "build", endedAt: at(30) });
    addSession({
      epicId: "cr-silent",
      agentType: "review_code",
      reviewVerdict: null,
      startedAt: at(40),
      endedAt: at(45),
    });
    expect(refusalFor("cr-silent", "merge")).toMatch(/requested changes/i);
  });

  it("leaves story-scoped transitions alone", () => {
    // A story carries its own review decision; the epic's verdict is not it.
    // The story still refuses here — on the pre-existing "no completed
    // review" guard, because the epic-scoped review is not the story's — and
    // that is the point: the new guard must not be what speaks.
    seedChangesRequestedEpic("cr-story");
    addStory("cr-story-1", "cr-story");
    const ctx = buildTransitionContext({
      epicId: "cr-story",
      userStoryId: "cr-story-1",
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
    });
    ctx.source = "merge";
    expect(ctx.hasNegativeReviewVerdict).toBe(false);
    expect(validateTransition(ctx).error).not.toMatch(/requested changes/i);
  });
});

/**
 * The engine learned about a standing `changes_requested`; the board and the
 * merge selector have to learn the same thing or they hand Full Auto a
 * candidate the guard refuses — and `tryAutoMerge` merges with git FIRST, so
 * every sweep would land the branch, be refused, and roll itself back.
 *
 * `evaluateMergeReadiness` cannot infer it: `lastCleanReviewAt` is a MAX over
 * CLEAN reviews, so a later rejecting round is invisible to it — the value
 * simply stays at the older approving round.
 */
describe("a standing changes_requested keeps the board and the engine agreed", () => {
  /** Approved at :20-:25, then a SECOND review rejects at :30-:35. */
  function seedLateRejection(id: string, position = 0): void {
    addEpic(id, position);
    addSession({ epicId: id, agentType: "build", endedAt: at(10) });
    addSession({
      epicId: id,
      agentType: "review_code",
      reviewVerdict: "approved",
      startedAt: at(20),
      endedAt: at(25),
    });
    addSession({
      epicId: id,
      agentType: "review_security",
      reviewVerdict: "changes_requested",
      startedAt: at(30),
      endedAt: at(35),
    });
  }

  it("refuses on the board, in the selector and in the engine alike", async () => {
    seedLateRejection("cr-late");

    expect(await readinessOf("cr-late")).toMatchObject({
      ready: false,
      blocker: "changes_requested",
    });
    expect(selectMergeCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([]);

    const ctx = buildTransitionContext({
      epicId: "cr-late",
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
    });
    ctx.source = "merge";
    expect(validateTransition(ctx).error).toMatch(/requested changes/i);
  });

  it("clears once a newer review records a clean verdict", async () => {
    seedLateRejection("cr-recovered");
    addSession({ epicId: "cr-recovered", agentType: "build", endedAt: at(40) });
    addSession({
      epicId: "cr-recovered",
      agentType: "review_code",
      reviewVerdict: "approved",
      startedAt: at(50),
      endedAt: at(55),
    });

    expect(await readinessOf("cr-recovered")).toMatchObject({ ready: true });
    expect(selectMergeCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([
      "cr-recovered",
    ]);
  });

  it("is not cleared by a later review that recorded no verdict", async () => {
    seedLateRejection("cr-silent-after");
    addSession({
      epicId: "cr-silent-after",
      agentType: "build",
      endedAt: at(40),
    });
    addSession({
      epicId: "cr-silent-after",
      agentType: "review_code",
      reviewVerdict: null,
      startedAt: at(50),
      endedAt: at(55),
    });

    expect(await readinessOf("cr-silent-after")).toMatchObject({
      blocker: "changes_requested",
    });
    expect(selectMergeCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([]);
  });

  it("reports the rejection ahead of the vaguer 'no review' when it is the only one", async () => {
    // With no clean round at all `lastCleanReviewAt` is NULL, so the honest
    // blocker is the rejection rather than "awaiting review" — a review DID
    // run, and it said no.
    addEpic("cr-only");
    addSession({ epicId: "cr-only", agentType: "build", endedAt: at(10) });
    addSession({
      epicId: "cr-only",
      agentType: "review_code",
      reviewVerdict: "changes_requested",
      startedAt: at(20),
      endedAt: at(25),
    });
    expect(await readinessOf("cr-only")).toMatchObject({
      ready: false,
      blocker: "changes_requested",
    });
  });

  it("still reports a blocking finding first — it is the more actionable one", async () => {
    seedLateRejection("cr-with-finding");
    addFinding({
      epicId: "cr-with-finding",
      body: "[critical] Still standing",
      createdAt: at(32),
    });
    expect(await readinessOf("cr-with-finding")).toMatchObject({
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
