/**
 * Which OPEN review findings a To Merge card still reports — and the one
 * review fact that keeps an epic out of "Ready to merge".
 *
 * Since merge-as-approval, an open finding does NOT block: the merge itself
 * resolves whatever is left (lib/workflow/merge-approval.ts), and a review
 * that found something blocking files `changes_requested` and sends the epic
 * back to `in_progress` rather than promoting it. What the count still does
 * is ride along on the card, so it has to be HONEST — `review_comments` rows
 * are never resolved by the pipeline (see the "no auto-resolve" note in
 * lib/pipeline/findings.ts), and counting every last one of them reported
 * "N open findings" on epics that had nothing left to fix:
 *
 *   - a `[minor]`/`[info]` finding filed BY the approving review — the
 *     reviewer's own vocabulary for "not blocking", and exactly what an
 *     `approved_with_minor_issues` verdict means;
 *   - a `[critical]`/`[major]` from an EARLIER round that a later clean
 *     review, run on the fixed code, did not re-report.
 *
 * `lib/pipeline/findings.ts` has always defined blocking narrowly — open,
 * agent-authored, `[critical]`/`[major]`, and inside the CURRENT review
 * stage's window. The board and Full Auto's merge selector counted "any open
 * row" instead. This file is the parity harness for the one shared
 * definition (lib/workflow/blocking-findings.ts), and for the standing
 * `changes_requested` verdict that the board, the selector and the engine
 * must all read the same way.
 *
 * Everything runs against the real migrated schema, so the SQL behind the
 * predicate is actually EXECUTED here.
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
      // The merge column: `evaluateMergeReadiness` and `selectMergeCandidates`
      // only ever consider `to_merge`, which IS the passing review verdict.
      status: "to_merge",
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

describe("the finding count a To Merge card reports", () => {
  // Findings do not gate any more, so every case here asserts `ready: true`
  // and pins the COUNT. The rules deciding which rows are counted are
  // unchanged — they are the same `blocksMergeSql` the engine's promotion
  // gate reads, which is why the narrowing still has to be exact.
  it("counts a [critical] filed by the approving review", async () => {
    seedApprovedEpic("critical-now");
    addFinding({
      epicId: "critical-now",
      body: "[critical] Token leaks into the log",
      createdAt: at(22),
    });
    expect(await readinessOf("critical-now")).toEqual({
      ready: true,
      blocker: null,
      openFindings: 1,
    });
  });

  it("counts a [major] filed by the approving review", async () => {
    seedApprovedEpic("major-now");
    addFinding({
      epicId: "major-now",
      body: "[major] Race can merge stale code",
      createdAt: at(22),
    });
    expect(await readinessOf("major-now")).toMatchObject({
      ready: true,
      blocker: null,
      openFindings: 1,
    });
  });

  it("does not count a [minor] the approving review itself filed", async () => {
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
  });

  it("does not count an [info] note", async () => {
    seedApprovedEpic("info-now");
    addFinding({
      epicId: "info-now",
      body: "[info] Residual robustness gap, not a confirmed break",
      createdAt: at(22),
    });
    expect(await readinessOf("info-now")).toMatchObject({ ready: true });
  });

  it("stops counting a [major] a later clean review superseded", async () => {
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
  });

  it("keeps counting a [critical] no clean review has superseded yet", async () => {
    addEpic("unreviewed-critical");
    addSession({ epicId: "unreviewed-critical", agentType: "build", endedAt: at(10) });
    addFinding({
      epicId: "unreviewed-critical",
      body: "[critical] Deletes the worktree of another epic",
      createdAt: at(12),
    });
    expect(await readinessOf("unreviewed-critical")).toMatchObject({
      ready: true,
      openFindings: 1,
    });
  });

  it("always counts a human's own open review comment", async () => {
    seedApprovedEpic("human-hold");
    addFinding({
      epicId: "human-hold",
      body: "Not until we discuss the migration",
      author: "user",
      createdAt: at(15),
    });
    expect(await readinessOf("human-hold")).toMatchObject({
      ready: true,
      openFindings: 1,
    });
  });

  it("counts an agent finding with no severity prefix", async () => {
    seedApprovedEpic("unprefixed");
    addFinding({
      epicId: "unprefixed",
      body: "This needs another look before merging",
      createdAt: at(22),
    });
    expect(await readinessOf("unprefixed")).toMatchObject({
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
      ready: true,
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
      openFindings: 1,
    });
  });

  it("does not let a review of another dimension supersede an unfixed [critical]", async () => {
    // The gap this pins: the cutoff maxed over every review type and never
    // asked whether the branch had CHANGED, while its own justification is
    // both dimension- and change-specific ("a round a later reviewer re-read
    // on fixed code"). A Security pass never re-read the code-quality
    // dimension, and on an untouched branch nothing could have fixed it.
    addEpic("cross-dimension");
    addSession({
      epicId: "cross-dimension",
      agentType: "build",
      endedAt: at(10),
    });
    addSession({
      epicId: "cross-dimension",
      agentType: "review_code",
      reviewVerdict: "changes_requested",
      startedAt: at(20),
      endedAt: at(30),
    });
    addFinding({
      epicId: "cross-dimension",
      body: "[critical] Token leaks into the log",
      createdAt: at(25),
    });
    // Approves, files nothing, and touches no code — the branch is byte-for
    // byte the one the [critical] was filed against.
    addSession({
      epicId: "cross-dimension",
      agentType: "review_security",
      reviewVerdict: "approved",
      startedAt: at(40),
      endedAt: at(50),
    });

    expect(await readinessOf("cross-dimension")).toMatchObject({
      // The rejection, not the finding, is what keeps it off the merge list.
      ready: false,
      blocker: "changes_requested",
      openFindings: 1,
    });
    expect(selectMergeCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([]);
  });

  it("does not let a re-review supersede a [major] when the branch never changed", async () => {
    // Same dimension this time, so only the "on fixed code" half is doing the
    // work: a reviewer that re-ran on the SAME commit and stayed silent has
    // adjudicated nothing — the [major] it declined to re-report is still in
    // the code it just read.
    addEpic("unchanged-branch");
    addSession({
      epicId: "unchanged-branch",
      agentType: "build",
      endedAt: at(10),
    });
    addSession({
      epicId: "unchanged-branch",
      agentType: "review_code",
      reviewVerdict: "changes_requested",
      startedAt: at(12),
      endedAt: at(16),
    });
    addFinding({
      epicId: "unchanged-branch",
      body: "[major] Race can merge stale code",
      createdAt: at(15),
    });
    addSession({
      epicId: "unchanged-branch",
      agentType: "review_code",
      reviewVerdict: "approved",
      startedAt: at(20),
      endedAt: at(25),
    });

    expect(await readinessOf("unchanged-branch")).toMatchObject({
      openFindings: 1,
    });
  });

  it("does not resurrect a settled finding when a later build lands", async () => {
    // The other side of the same rule, and the reason the cutoff is a WINDOW
    // (`MAX(code) BEFORE the newest clean verdict`) rather than the cheaper
    // "the newest code session, if it happens to predate that verdict":
    // round two read the fix at :18 and declined to re-report the [major], so
    // it is settled. A build at :30 does not un-settle it — review freshness
    // is no longer a readiness input, so the card stays ready with nothing
    // left to report.
    seedSecondRoundApprovedEpic("code-after-review");
    addFinding({
      epicId: "code-after-review",
      body: "[major] Retry reuses the reviewer's agent",
      createdAt: at(15),
    });
    addSession({
      epicId: "code-after-review",
      agentType: "build",
      endedAt: at(30),
    });

    expect(await readinessOf("code-after-review")).toMatchObject({
      ready: true,
      blocker: null,
      openFindings: 0,
    });
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
    // A story build lands on the epic's branch, THEN the story is reviewed:
    // without this the epic's own code session would be the newest one either
    // way and the cutoff could not tell the two reviews apart.
    addSession({
      epicId: "story-cutoff",
      agentType: "ticket_build",
      userStoryId: "story-cutoff-1",
      endedAt: at(26),
    });
    addSession({
      epicId: "story-cutoff",
      agentType: "review_code",
      reviewVerdict: "approved",
      userStoryId: "story-cutoff-1",
      startedAt: at(30),
      endedAt: at(35),
    });

    expect(await readinessOf("story-cutoff")).toMatchObject({
      openFindings: 1,
    });
  });

  it("matches severity prefixes case-sensitively, so [MAJOR] is unclassified", async () => {
    // `=` under BINARY collation, chosen over LIKE precisely for this. Filed
    // before the fix that the clean review read, so a LIKE-based match would
    // read it as a superseded [major] and stop blocking; an unclassified row
    // always blocks.
    seedSecondRoundApprovedEpic("shouty");
    addFinding({
      epicId: "shouty",
      body: "[MAJOR] Reviewer shouted the severity",
      createdAt: at(15),
    });
    expect(await readinessOf("shouty")).toMatchObject({
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
    expect(await readinessOf("neighbour")).toMatchObject({
      ready: true,
      openFindings: 0,
    });
    expect(await readinessOf("laggard")).toMatchObject({
      openFindings: 1,
    });
  });
});

/**
 * Merge-as-approval removed every accidental backstop around findings: open
 * rows do not refuse a transition, and the engine's only other review input,
 * `hasCompletedReview`, is satisfied by ANY completed review session ever.
 * So an epic sitting in `to_merge` whose newest verdict says
 * `changes_requested` — a second reviewer landing after the promotion, a
 * refused rejection transition, a human drag — has exactly one guard left.
 *
 * The merge paths land a branch on the base branch, so they must not be the
 * ones to discover that.
 */
describe("to_merge -> done under a standing changes_requested verdict", () => {
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
      fromStatus: "to_merge",
      toStatus: "done",
      actor: "user",
    });
    ctx.source = source;
    return validateTransition(ctx).error ?? null;
  }

  it("refuses a merge that would land the branch anyway", () => {
    seedChangesRequestedEpic("cr-merge");
    expect(refusalFor("cr-merge", "merge")).toMatch(/requested changes/i);
  });

  it("has no approve escape hatch — the merge IS the approval", () => {
    // The epic approve route is gone, and with it the human override this
    // guard used to leave open. The way out is a fix and a fresh review.
    seedChangesRequestedEpic("cr-approve");
    expect(refusalFor("cr-approve", "approve")).toMatch(/successful merge/i);
  });

  it("does not refuse once a newer review recorded a clean verdict", () => {
    seedChangesRequestedEpic("cr-cleared");
    // The fix, then the review that read it — both halves are required.
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

  it("is not cleared by a clean verdict that read no new code", () => {
    // Same rule as the supersession cutoff, on the other half of the verdict
    // pair: a rejection is answered by a FIX a reviewer has since read, not by
    // another opinion of the same commit. Here a second dimension approves the
    // very branch the code reviewer rejected, with nothing changed in between.
    seedChangesRequestedEpic("cr-unfixed");
    addSession({
      epicId: "cr-unfixed",
      agentType: "review_security",
      reviewVerdict: "approved",
      startedAt: at(40),
      endedAt: at(45),
    });
    expect(refusalFor("cr-unfixed", "merge")).toMatch(/requested changes/i);
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
    // The epic here has a standing rejection, and the story's own cascade to
    // Done still goes through — the fact is never computed on a story-scoped
    // context, so the guard has nothing to speak with.
    seedChangesRequestedEpic("cr-story");
    addStory("cr-story-1", "cr-story");
    const ctx = buildTransitionContext({
      epicId: "cr-story",
      userStoryId: "cr-story-1",
      targetKind: "story",
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
    });
    ctx.source = "merge";
    expect(ctx.hasNegativeReviewVerdict).toBe(false);
    expect(validateTransition(ctx)).toEqual({ valid: true });
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
      fromStatus: "to_merge",
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

  it("keeps the rejection standing on the board when nothing was fixed", async () => {
    // The board reads the same rule as the engine — it has to, or Full Auto
    // lands the branch with git before the guard refuses it.
    seedLateRejection("cr-no-fix");
    addSession({
      epicId: "cr-no-fix",
      agentType: "review_code",
      reviewVerdict: "approved",
      startedAt: at(40),
      endedAt: at(45),
    });

    expect(await readinessOf("cr-no-fix")).toMatchObject({
      ready: false,
      blocker: "changes_requested",
    });
    expect(selectMergeCandidates(PROJECT_ID).map((c) => c.epicId)).toEqual([]);
  });

  it("reports the rejection when it is the epic's only review round", async () => {
    // With no clean round at all `lastCleanReviewAt` is NULL, which the card
    // no longer reads — the `to_merge` status is the verdict. The rejection
    // is the one review fact that still speaks.
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

  it("echoes a still-standing finding alongside the rejection", async () => {
    // Both facts reach the card, but only the rejection blocks: the count is
    // information the merge would resolve on its way through.
    seedLateRejection("cr-with-finding");
    addFinding({
      epicId: "cr-with-finding",
      body: "[critical] Still standing",
      createdAt: at(32),
    });
    expect(await readinessOf("cr-with-finding")).toMatchObject({
      ready: false,
      blocker: "changes_requested",
      openFindings: 1,
    });
  });
});

describe("board / Full Auto parity on the finding count", () => {
  it("agrees with selectMergeCandidates on readiness and on the count", async () => {
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

    // All three are mergeable — none carries a standing rejection, and a
    // finding is not a gate. What the narrowing still decides is the count
    // each card reports, and both sides derive it from the same SQL.
    expect(boardReady).toEqual(["p-critical", "p-minor", "p-superseded"]);
    expect(autoReady).toEqual(boardReady);
    expect(
      Object.fromEntries(
        json.data.map((row: { id: string; mergeReadiness: { openFindings: number } }) => [
          row.id,
          row.mergeReadiness.openFindings,
        ])
      )
    ).toEqual({ "p-minor": 0, "p-superseded": 0, "p-critical": 1 });
  });
});
