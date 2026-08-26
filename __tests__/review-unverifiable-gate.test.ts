/**
 * Regression: a review that could not FILE anything must not read as "clean".
 *
 * The reported failure (epic "Providers Documentation", three consecutive
 * rounds): the reviewer's `submit_findings` calls were rejected 401 because
 * its MCP token never reached the child. Rounds 1-2 only blocked by accident,
 * because the prose fallback happened to find "changes requested" in the
 * markdown; round 3 phrased itself differently, so the gate saw
 *
 *     a completed review session  +  zero review_comments rows
 *
 * and read that as "reviewed, nothing found" — vacuously clean. The epic
 * became mergeable with its findings stranded in a ticket comment.
 *
 * The rule these cases pin down: for a provider that HAS the structured
 * channel, silence on that channel is missing evidence, not approval. A
 * provider without the channel keeps the prose fallback verbatim — that is
 * the non-regression half, and it is why the fallback exists at all.
 *
 * The MCP-less fixtures below name `gemini-cli` deliberately. Since the
 * 2026-08 cleanup every REGISTERED provider has the channel
 * (docs/architecture/mcp-provider-matrix.md), so the population the fallback
 * still serves is legacy session rows naming a removed provider — which is
 * exactly the shape these cases stand in for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createTestDb } from "@/lib/db/test-utils";
import { mockNextRequest } from "@/__tests__/helpers/db-mock";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<
    typeof import("@/lib/db/test-utils").createTestDb
  > | null,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.db;
  },
  get sqlite() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.sqlite;
  },
  ensureDbReady: vi.fn(),
}));

import {
  agentSessions,
  epics,
  notifications,
  projects,
  reviewComments,
  settings,
  ticketActivityLog,
} from "@/lib/db/schema";
import {
  assessReviewOutcome,
  listUnverifiableReviewEpicIds,
  readReviewChannelState,
  resolveReviewVerdict,
} from "@/lib/pipeline/findings";
import { buildTransitionContext } from "@/lib/workflow/context";
import { validateTransition } from "@/lib/workflow/engine";
import { loadAutoModeBoard, selectMergeCandidates } from "@/lib/auto-mode/select";
import {
  _resetMcpTokenStoreForTests,
  mintMcpToken,
  revokeMcpTokensForSession,
} from "@/lib/mcp/token-store";
import { POST as submitFindingsPost } from "@/app/api/mcp/submit-findings/route";

const PROJECT_ID = "proj-unverifiable";
const EPIC_ID = "epic-unverifiable";

const CODE_AT = "2026-08-20T09:00:00.000Z";
const REVIEW_STARTED_AT = "2026-08-20T10:00:00.000Z";
const REVIEW_ENDED_AT = "2026-08-20T10:30:00.000Z";

/** A reviewer's markdown that carries none of the prose fallback's triggers. */
const NEUTRAL_REVIEW_OUTPUT =
  "I read the diff and wrote up what I found. See the ticket comment.";

function db() {
  return testDb.instance!.db;
}

let counter = 0;

function seed(): void {
  db().insert(projects).values({ id: PROJECT_ID, name: "Unverifiable" }).run();
  db()
    .insert(epics)
    .values({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: "Providers Documentation",
      status: "review",
      position: 0,
      branchName: "feature/providers-documentation",
    })
    .run();
  // The build that produced the branch under review.
  db()
    .insert(agentSessions)
    .values({
      id: "session-build",
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: "completed",
      outcome: "answered",
      agentType: "build",
      provider: "claude-code",
      startedAt: CODE_AT,
      endedAt: CODE_AT,
      createdAt: CODE_AT,
    })
    .run();
}

/**
 * A finished epic-scoped review session. `reviewVerdict: null` is the shape
 * a 401'd `submit_findings` leaves behind: the session ran, answered, and
 * persisted nothing.
 */
function insertReviewSession(input: {
  provider: string;
  reviewVerdict?: string | null;
  status?: string;
}): string {
  counter += 1;
  const id = `session-review-${counter}`;
  db()
    .insert(agentSessions)
    .values({
      id,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: input.status ?? "completed",
      outcome: "answered",
      agentType: "review_code",
      provider: input.provider,
      reviewVerdict: input.reviewVerdict ?? null,
      startedAt: REVIEW_STARTED_AT,
      endedAt: REVIEW_ENDED_AT,
      createdAt: REVIEW_STARTED_AT,
    })
    .run();
  return id;
}

beforeEach(() => {
  testDb.instance = createTestDb();
  _resetMcpTokenStoreForTests();
  counter = 0;
  seed();
});

/* ------------------------------------------------------------------ */
/* The channel state                                                   */
/* ------------------------------------------------------------------ */

describe("readReviewChannelState", () => {
  it("marks a verdict-less claude-code review unverifiable", () => {
    const sessionId = insertReviewSession({ provider: "claude-code" });
    const state = readReviewChannelState(sessionId, db());
    expect(state).toMatchObject({
      mcpCapable: true,
      structuredVerdict: null,
      unverifiable: true,
    });
  });

  it("does not mark a verdict-less MCP-less review unverifiable", () => {
    const sessionId = insertReviewSession({ provider: "gemini-cli" });
    expect(readReviewChannelState(sessionId, db())).toMatchObject({
      mcpCapable: false,
      unverifiable: false,
    });
  });

  it("clears the flag once a structured verdict lands", () => {
    const sessionId = insertReviewSession({
      provider: "codex",
      reviewVerdict: "approved",
    });
    expect(readReviewChannelState(sessionId, db())).toMatchObject({
      mcpCapable: true,
      structuredVerdict: "approved",
      unverifiable: false,
    });
  });

  it("treats every provider as prose-only while mcp_tools_enabled is false", () => {
    db()
      .insert(settings)
      .values({ key: "mcp_tools_enabled", value: "false" })
      .run();
    const sessionId = insertReviewSession({ provider: "claude-code" });
    expect(readReviewChannelState(sessionId, db())).toMatchObject({
      mcpCapable: false,
      unverifiable: false,
    });
  });
});

/* ------------------------------------------------------------------ */
/* The pipeline verdict                                                */
/* ------------------------------------------------------------------ */

describe("assessReviewOutcome — the vacuous clean review", () => {
  it("blocks a verdict-less claude-code review that filed nothing", () => {
    const sessionId = insertReviewSession({ provider: "claude-code" });
    const assessment = assessReviewOutcome({
      epicId: EPIC_ID,
      sinceIso: REVIEW_STARTED_AT,
      sessionOutput: NEUTRAL_REVIEW_OUTPUT,
      reviewSessionId: sessionId,
      database: db(),
    });
    expect(assessment.blocking).toBe(true);
    expect(assessment.verdictSource).toBe("unverifiable");
    expect(assessment.blockingFindings).toHaveLength(0);
  });

  it("blocks a verdict-less omp review just the same", () => {
    const sessionId = insertReviewSession({ provider: "oh-my-pi" });
    expect(
      assessReviewOutcome({
        epicId: EPIC_ID,
        sinceIso: REVIEW_STARTED_AT,
        sessionOutput: NEUTRAL_REVIEW_OUTPUT,
        reviewSessionId: sessionId,
        database: db(),
      }).blocking
    ).toBe(true);
  });

  it("keeps the prose fallback for a provider without the channel", () => {
    const sessionId = insertReviewSession({ provider: "gemini-cli" });
    const assessment = assessReviewOutcome({
      epicId: EPIC_ID,
      sinceIso: REVIEW_STARTED_AT,
      sessionOutput: NEUTRAL_REVIEW_OUTPUT,
      reviewSessionId: sessionId,
      database: db(),
    });
    expect(assessment.blocking).toBe(false);
    expect(assessment.verdictSource).toBe("prose");
    expect(assessment.usedProseFallback).toBe(true);
  });

  it("still passes a structurally approved review", () => {
    const sessionId = insertReviewSession({
      provider: "claude-code",
      reviewVerdict: "approved_with_minor_issues",
    });
    const assessment = assessReviewOutcome({
      epicId: EPIC_ID,
      sinceIso: REVIEW_STARTED_AT,
      sessionOutput: NEUTRAL_REVIEW_OUTPUT,
      reviewSessionId: sessionId,
      database: db(),
    });
    expect(assessment.blocking).toBe(false);
    expect(assessment.verdictSource).toBe("structured");
  });

  it("does not fire when the caller has no review session to judge", () => {
    expect(
      assessReviewOutcome({
        epicId: EPIC_ID,
        sinceIso: REVIEW_STARTED_AT,
        sessionOutput: NEUTRAL_REVIEW_OUTPUT,
        reviewSessionId: null,
        database: db(),
      }).blocking
    ).toBe(false);
  });
});

describe("resolveReviewVerdict — the revert drivers", () => {
  /**
   * These drivers send the ticket back to `in_progress`, i.e. they dispatch a
   * BUILD. An unverifiable review says nothing about the code — no finding
   * was filed — so bouncing it would put a code agent on a branch nothing
   * faulted. The ticket stays in Review, un-mergeable, and earns another
   * REVIEW instead; `unverifiable` is what tells the caller which it is.
   */
  it("does not bounce the ticket for a verdict-less claude-code review", () => {
    const sessionId = insertReviewSession({ provider: "claude-code" });
    const decision = resolveReviewVerdict({
      epicId: EPIC_ID,
      reviewSessionId: sessionId,
      sessionOutput: NEUTRAL_REVIEW_OUTPUT,
      database: db(),
    });
    expect(decision.negative).toBe(false);
    expect(decision.unverifiable).toBe(true);
    expect(decision.source).toBe("unverifiable");
  });

  it("still bounces on an explicit changes_requested verdict", () => {
    const sessionId = insertReviewSession({
      provider: "claude-code",
      reviewVerdict: "changes_requested",
    });
    expect(
      resolveReviewVerdict({
        epicId: EPIC_ID,
        reviewSessionId: sessionId,
        sessionOutput: NEUTRAL_REVIEW_OUTPUT,
        database: db(),
      })
    ).toMatchObject({ negative: true, source: "structured" });
  });

  it("leaves an MCP-less reviewer's prose verdict untouched", () => {
    const sessionId = insertReviewSession({ provider: "gemini-cli" });
    expect(
      resolveReviewVerdict({
        epicId: EPIC_ID,
        reviewSessionId: sessionId,
        sessionOutput: NEUTRAL_REVIEW_OUTPUT,
        database: db(),
      })
    ).toMatchObject({ negative: false, source: "prose" });

    expect(
      resolveReviewVerdict({
        epicId: EPIC_ID,
        reviewSessionId: sessionId,
        sessionOutput: "Overall Verdict: changes requested",
        database: db(),
      })
    ).toMatchObject({ negative: true, source: "prose" });
  });
});

/* ------------------------------------------------------------------ */
/* The review -> done guard                                            */
/* ------------------------------------------------------------------ */

describe("review -> done guard", () => {
  it("does not accept an unverifiable review as a completed review", () => {
    insertReviewSession({ provider: "claude-code" });
    const ctx = buildTransitionContext({
      epicId: EPIC_ID,
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
    });
    expect(ctx.hasCompletedReview).toBe(false);
    expect(ctx.hasUnverifiableReview).toBe(true);
  });

  it("accepts a review that delivered its verdict", () => {
    insertReviewSession({
      provider: "claude-code",
      reviewVerdict: "approved",
    });
    const ctx = buildTransitionContext({
      epicId: EPIC_ID,
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
    });
    expect(ctx.hasCompletedReview).toBe(true);
    expect(ctx.hasUnverifiableReview).toBe(false);
  });

  it("accepts an MCP-less reviewer with no structured verdict", () => {
    insertReviewSession({ provider: "gemini-cli" });
    const ctx = buildTransitionContext({
      epicId: EPIC_ID,
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
    });
    expect(ctx.hasCompletedReview).toBe(true);
    expect(ctx.hasUnverifiableReview).toBe(false);
  });

  it("refuses the transition with a reason naming the broken channel", () => {
    const result = validateTransition({
      epicId: EPIC_ID,
      fromStatus: "review",
      toStatus: "done",
      hasOpenReviewComments: false,
      hasCompletedReview: false,
      hasUnverifiableReview: true,
      hasRunningSession: false,
      actor: "user",
      source: "approve",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/submit_findings/);
  });
});

/* ------------------------------------------------------------------ */
/* The Full Auto merge gate                                            */
/* ------------------------------------------------------------------ */

describe("selectMergeCandidates", () => {
  it("refuses to merge an epic whose only review filed no verdict", () => {
    insertReviewSession({ provider: "claude-code" });
    const board = loadAutoModeBoard(PROJECT_ID);
    expect(selectMergeCandidates(PROJECT_ID, board)).toHaveLength(0);
  });

  it("merges once the review delivers an approving verdict", () => {
    insertReviewSession({
      provider: "claude-code",
      reviewVerdict: "approved",
    });
    const board = loadAutoModeBoard(PROJECT_ID);
    expect(selectMergeCandidates(PROJECT_ID, board).map((c) => c.epicId)).toEqual([
      EPIC_ID,
    ]);
  });

  it("still merges on an MCP-less reviewer, which has no verdict to give", () => {
    insertReviewSession({ provider: "gemini-cli" });
    const board = loadAutoModeBoard(PROJECT_ID);
    expect(selectMergeCandidates(PROJECT_ID, board).map((c) => c.epicId)).toEqual([
      EPIC_ID,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* The board read model                                                */
/* ------------------------------------------------------------------ */

describe("listUnverifiableReviewEpicIds", () => {
  it("reports the epic whose latest delivered review filed nothing", () => {
    insertReviewSession({ provider: "claude-code" });
    expect([...listUnverifiableReviewEpicIds(PROJECT_ID, db())]).toEqual([
      EPIC_ID,
    ]);
  });

  it("clears once a later review delivers a verdict", () => {
    insertReviewSession({ provider: "claude-code" });
    db()
      .insert(agentSessions)
      .values({
        id: "session-review-late",
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        status: "completed",
        outcome: "answered",
        agentType: "review_code",
        provider: "claude-code",
        reviewVerdict: "approved",
        startedAt: "2026-08-20T11:00:00.000Z",
        endedAt: "2026-08-20T11:30:00.000Z",
        createdAt: "2026-08-20T11:00:00.000Z",
      })
      .run();
    expect(listUnverifiableReviewEpicIds(PROJECT_ID, db()).size).toBe(0);
  });

  it("spares a review that filed findings rows of its own", () => {
    const sessionId = insertReviewSession({ provider: "claude-code" });
    db()
      .insert(reviewComments)
      .values({
        id: "rc-1",
        epicId: EPIC_ID,
        filePath: "lib/providers/index.ts",
        lineNumber: 12,
        body: "[major] undocumented flag",
        author: "agent",
        status: "open",
        agentSessionId: sessionId,
        createdAt: "2026-08-20T10:20:00.000Z",
        updatedAt: "2026-08-20T10:20:00.000Z",
      })
      .run();
    expect(listUnverifiableReviewEpicIds(PROJECT_ID, db()).size).toBe(0);
  });

  it("spares MCP-less providers and a globally disabled channel", () => {
    insertReviewSession({ provider: "gemini-cli" });
    expect(listUnverifiableReviewEpicIds(PROJECT_ID, db()).size).toBe(0);

    db().delete(agentSessions).run();
    insertReviewSession({ provider: "claude-code" });
    db()
      .insert(settings)
      .values({ key: "mcp_tools_enabled", value: "false" })
      .run();
    expect(listUnverifiableReviewEpicIds(PROJECT_ID, db()).size).toBe(0);
  });

  it("ignores story-scoped reviews and reviews that never delivered", () => {
    db()
      .insert(agentSessions)
      .values([
        {
          id: "session-review-failed",
          projectId: PROJECT_ID,
          epicId: EPIC_ID,
          status: "failed",
          outcome: null,
          agentType: "review_code",
          provider: "claude-code",
          startedAt: REVIEW_STARTED_AT,
          endedAt: REVIEW_ENDED_AT,
          createdAt: REVIEW_STARTED_AT,
        },
        {
          id: "session-review-silent",
          projectId: PROJECT_ID,
          epicId: EPIC_ID,
          status: "completed",
          outcome: "silent",
          agentType: "review_code",
          provider: "claude-code",
          startedAt: REVIEW_STARTED_AT,
          endedAt: REVIEW_ENDED_AT,
          createdAt: REVIEW_STARTED_AT,
        },
      ])
      .run();
    expect(listUnverifiableReviewEpicIds(PROJECT_ID, db()).size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* The 401 trace                                                       */
/* ------------------------------------------------------------------ */

describe("submit_findings 401 tracing", () => {
  const BODY = {
    verdict: "changes_requested",
    summary: "Three blocking problems in the provider docs.",
    findings: [],
  };

  function call(bearer: string | undefined) {
    return submitFindingsPost(
      mockNextRequest({
        url: "http://localhost:3000/api/mcp/submit-findings",
        body: BODY,
        headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
      }) as NextRequest
    );
  }

  function activityRows() {
    return db()
      .select()
      .from(ticketActivityLog)
      .all()
      .filter((row) => row.epicId === EPIC_ID);
  }

  it("logs activity and notifies when a revoked review token is rejected", async () => {
    const sessionId = insertReviewSession({
      provider: "claude-code",
      status: "running",
    });
    const token = mintMcpToken({
      sessionId,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      agentType: "review_code",
    });
    revokeMcpTokensForSession(sessionId);

    const response = await call(token);
    expect(response.status).toBe(401);

    const rows = activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe(sessionId);
    expect(rows[0].reason).toMatch(/submit_findings/);

    const notified = db().select().from(notifications).all();
    expect(notified).toHaveLength(1);
    expect(notified[0].sessionId).toBe(sessionId);
    expect(notified[0].status).toBe("failed");
  });

  it("attributes an unknown token to the one review session still running", async () => {
    const sessionId = insertReviewSession({
      provider: "oh-my-pi",
      status: "running",
    });

    const response = await call("arij-mcp-never-minted");
    expect(response.status).toBe(401);

    const rows = activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe(sessionId);
  });

  it("traces a retrying reviewer once, not once per attempt", async () => {
    const sessionId = insertReviewSession({
      provider: "oh-my-pi",
      status: "running",
    });
    expect(sessionId).toBeTruthy();

    await call("arij-mcp-never-minted");
    await call("arij-mcp-never-minted");
    await call("arij-mcp-never-minted");

    expect(activityRows()).toHaveLength(1);
    expect(db().select().from(notifications).all()).toHaveLength(1);
  });

  it("does not blame a live review for a known non-review caller", async () => {
    // A build session whose token was revoked mid-call. Its identity is
    // KNOWN — and it is not a review — so the sole-running-review inference
    // must not run: the trace would land on a healthy epic whose channel is
    // fine, and the dedupe would key it to that innocent review's session.
    const reviewSessionId = insertReviewSession({
      provider: "claude-code",
      status: "running",
    });
    db()
      .insert(agentSessions)
      .values({
        id: "session-build-revoked",
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        status: "running",
        agentType: "build",
        provider: "claude-code",
        createdAt: CODE_AT,
      })
      .run();
    const buildToken = mintMcpToken({
      sessionId: "session-build-revoked",
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      agentType: "build",
    });
    revokeMcpTokensForSession("session-build-revoked");

    const response = await call(buildToken);
    expect(response.status).toBe(401);
    expect(activityRows()).toHaveLength(0);
    expect(db().select().from(notifications).all()).toHaveLength(0);
    expect(reviewSessionId).toBeTruthy();
  });

  it("stays silent when no review session can be identified", async () => {
    const response = await call("arij-mcp-never-minted");
    expect(response.status).toBe(401);
    expect(activityRows()).toHaveLength(0);
    expect(db().select().from(notifications).all()).toHaveLength(0);
  });

  it("leaves no trace on the happy path", async () => {
    const sessionId = insertReviewSession({
      provider: "claude-code",
      status: "running",
    });
    const token = mintMcpToken({
      sessionId,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      agentType: "review_code",
    });

    const response = await call(token);
    expect(response.status).toBe(200);
    expect(activityRows()).toHaveLength(0);
    expect(db().select().from(notifications).all()).toHaveLength(0);
    expect(
      db().select().from(reviewComments).all()
    ).toHaveLength(0);
  });
});
