/**
 * The unverifiable-review rule has to give the SAME answer everywhere.
 *
 * Two gates ask it. `lib/pipeline/findings.ts` answers in JS for the pipeline,
 * the workflow guard and the board badge; `lib/auto-mode/select.ts` answers in
 * SQL for the Full Auto merge gate. When they disagree, the epic falls into a
 * gap neither of them bounds:
 *
 *   - findings says "verifiable" → `reconcileInFlight` charges nothing;
 *   - select says "not clean"    → `needsReview` is true every sweep.
 *
 * That is a review dispatched forever and never parked. It is not theoretical:
 * it is what `mcp_channel = 'unavailable'` produced while only findings.ts read
 * the column.
 *
 * The relationship the two must satisfy, per delivered epic-scoped review:
 *
 *     clean  ==  !unverifiable  &&  verdict != 'changes_requested'
 *
 * Every row below pins one line of that table on both sides at once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { createTestDb } from "@/lib/db/test-utils";
import {
  agentSessions,
  epics,
  projects,
  reviewComments,
  settings,
} from "@/lib/db/schema";
import {
  MCP_CHANNEL_INJECTED,
  MCP_CHANNEL_UNAVAILABLE,
} from "@/lib/claude/mcp-injection";
import {
  isReviewSessionUnverifiable,
  readReviewChannelState,
} from "@/lib/pipeline/findings";
import { hasFreshCleanReview, loadAutoModeBoard } from "@/lib/auto-mode/select";
import { buildTransitionContext } from "@/lib/workflow/context";

const PROJECT_ID = "proj-consistency";
const EPIC_ID = "epic-consistency";

function db() {
  return testDb.instance!.db;
}

beforeEach(() => {
  testDb.instance = createTestDb();
  db().insert(projects).values({ id: PROJECT_ID, name: "Consistency" }).run();
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
      startedAt: "2026-08-26T09:00:00.000Z",
      endedAt: "2026-08-26T09:30:00.000Z",
      createdAt: "2026-08-26T09:00:00.000Z",
    })
    .run();
});

interface ReviewShape {
  provider?: string;
  mcpChannel?: string | null;
  reviewVerdict?: string | null;
  agentType?: string;
  filedRows?: boolean;
}

function insertReview(shape: ReviewShape): string {
  const id = "session-review";
  db()
    .insert(agentSessions)
    .values({
      id,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: "completed",
      outcome: "answered",
      agentType: shape.agentType ?? "review_code",
      provider: shape.provider ?? "claude-code",
      mcpChannel: shape.mcpChannel ?? null,
      reviewVerdict: shape.reviewVerdict ?? null,
      startedAt: "2026-08-26T10:00:00.000Z",
      endedAt: "2026-08-26T10:30:00.000Z",
      createdAt: "2026-08-26T10:00:00.000Z",
    })
    .run();
  if (shape.filedRows) {
    db()
      .insert(reviewComments)
      .values({
        id: "rc-1",
        epicId: EPIC_ID,
        filePath: "lib/providers/index.ts",
        lineNumber: 4,
        body: "[minor] undocumented flag",
        author: "agent",
        // Resolved: an OPEN row would block the merge on its own, which would
        // mask whether the verdict rule agreed with findings.ts.
        status: "resolved",
        agentSessionId: id,
        createdAt: "2026-08-26T10:10:00.000Z",
        updatedAt: "2026-08-26T10:10:00.000Z",
      })
      .run();
  }
  return id;
}

/**
 * True when the SQL side of the rule (`cleanReviewVerdictSql`, aggregated
 * into the sweep snapshot's `lastCleanReviewAt`) counts the review as clean.
 *
 * Merge candidacy itself is status-driven now (`to_merge` carries the
 * verdict), so the SQL predicate's observable is the anti-loop gate it
 * feeds: a clean review is FRESH (newer than the build above) and stops
 * `needsReview` from dispatching another identical review every sweep.
 */
function mergeGateSaysClean(): boolean {
  const board = loadAutoModeBoard(PROJECT_ID);
  return hasFreshCleanReview(board.sessionFactsByEpic.get(EPIC_ID));
}

/* ------------------------------------------------------------------ */
/* The agreement table                                                 */
/* ------------------------------------------------------------------ */

const MATRIX: Array<{
  name: string;
  shape: ReviewShape;
  unverifiable: boolean;
  clean: boolean;
}> = [
  {
    name: "wired channel, approving verdict",
    shape: { mcpChannel: MCP_CHANNEL_INJECTED, reviewVerdict: "approved" },
    unverifiable: false,
    clean: true,
  },
  {
    name: "wired channel, changes_requested",
    shape: {
      mcpChannel: MCP_CHANNEL_INJECTED,
      reviewVerdict: "changes_requested",
    },
    unverifiable: false,
    clean: false,
  },
  {
    name: "wired channel, nothing came through",
    shape: { mcpChannel: MCP_CHANNEL_INJECTED },
    unverifiable: true,
    clean: false,
  },
  {
    name: "wired channel, no verdict but findings rows of its own",
    shape: { mcpChannel: MCP_CHANNEL_INJECTED, filedRows: true },
    unverifiable: false,
    clean: true,
  },
  {
    // The gap this file exists for: findings.ts judged this by prose while
    // the merge gate called it not clean, and nothing charged the difference.
    name: "channel Arij could not wire",
    shape: { mcpChannel: MCP_CHANNEL_UNAVAILABLE },
    unverifiable: false,
    clean: true,
  },
  {
    // The mirror image, and the ticket's own bug shape: the row records a
    // wired channel, so the provider list must not overrule it.
    name: "wired channel recorded on a removed provider",
    shape: { provider: "gemini-cli", mcpChannel: MCP_CHANNEL_INJECTED },
    unverifiable: true,
    clean: false,
  },
  {
    name: "legacy row, MCP-capable provider, no verdict",
    shape: { mcpChannel: null },
    unverifiable: true,
    clean: false,
  },
  {
    name: "legacy row, removed provider, no verdict",
    shape: { provider: "gemini-cli", mcpChannel: null },
    unverifiable: false,
    clean: true,
  },
];

describe("findings.ts and the merge gate agree", () => {
  it.each(MATRIX)("$name", ({ shape, unverifiable, clean }) => {
    const sessionId = insertReview(shape);

    expect(readReviewChannelState(sessionId, db())?.unverifiable).toBe(
      unverifiable
    );
    expect(mergeGateSaysClean()).toBe(clean);

    // The invariant itself, so a future divergence fails here and not three
    // sweeps later on a board nobody is watching.
    const verdictIsNegative = shape.reviewVerdict === "changes_requested";
    expect(clean).toBe(!unverifiable && !verdictIsNegative);
  });

  it("keeps every row lenient while the channel is switched off globally", () => {
    db()
      .insert(settings)
      .values({ key: "mcp_tools_enabled", value: "false" })
      .run();
    insertReview({ mcpChannel: null });

    expect(isReviewSessionUnverifiable("session-review", db())).toBe(false);
    expect(mergeGateSaysClean()).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The second opinion is not an ordinary review                        */
/* ------------------------------------------------------------------ */

/**
 * `review_second_opinion` is a Full Auto merge gate with its own prose
 * fail-safe (`readSecondOpinionState` accepts an `Overall Verdict:` line), so
 * an APPROVED gate routinely carries no `review_verdict` and no findings rows.
 * Judging it by the structured channel would charge an approving gate as a
 * failure and park the epic it just cleared — the exclusion the board read
 * model already makes has to hold everywhere the rule is asked.
 */
describe("the second opinion is exempt from the rule", () => {
  it("is never unverifiable, whatever its channel says", () => {
    const sessionId = insertReview({
      agentType: "review_second_opinion",
      mcpChannel: MCP_CHANNEL_INJECTED,
    });
    expect(readReviewChannelState(sessionId, db())).toMatchObject({
      unverifiable: false,
    });
    expect(isReviewSessionUnverifiable(sessionId, db())).toBe(false);
  });

  it("does not make the workflow guard report an unverifiable review", () => {
    insertReview({
      agentType: "review_second_opinion",
      mcpChannel: MCP_CHANNEL_INJECTED,
    });
    const ctx = buildTransitionContext({
      epicId: EPIC_ID,
      fromStatus: "review",
      toStatus: "done",
      actor: "user",
    });
    expect(ctx.hasUnverifiableReview).toBe(false);
  });
});
