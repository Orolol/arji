/**
 * Was the channel WIRED, or is Arij just assuming it was?
 *
 * The unverifiable-review rule (lib/pipeline/findings.ts) turns on one
 * question: could this session have called `submit_findings`? Reconstructing
 * that from static provider config answers a different question — whether
 * this PROVIDER has the tool — and the two come apart whenever injection
 * silently degrades:
 *
 *   - lib/claude/process-manager.ts catches every injection error and spawns
 *     without tools;
 *   - lib/claude/spawn.ts drops the `--mcp-config` flag when the temp file
 *     cannot be written.
 *
 * In both cases the child never makes an HTTP call, so no 401 fires and the
 * 401 trace stays silent — yet the review used to be judged unverifiable and
 * both gates refused, with a message blaming the reviewer for not calling a
 * tool it was never given. `agent_sessions.mcp_channel` records what actually
 * happened, so the rule reads history instead of guessing.
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
import { agentSessions, epics, projects } from "@/lib/db/schema";
import {
  MCP_CHANNEL_INJECTED,
  MCP_CHANNEL_UNAVAILABLE,
} from "@/lib/claude/mcp-injection";
import {
  listUnverifiableReviewEpicIds,
  readReviewChannelState,
} from "@/lib/pipeline/findings";

const PROJECT_ID = "proj-wiring";
const EPIC_ID = "epic-wiring";

function db() {
  return testDb.instance!.db;
}

let counter = 0;

function insertReview(input: {
  provider?: string;
  mcpChannel?: string | null;
  agentType?: string;
  reviewVerdict?: string | null;
  endedAt?: string;
}): string {
  counter += 1;
  const id = `sess-${counter}`;
  db()
    .insert(agentSessions)
    .values({
      id,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: "completed",
      outcome: "answered",
      agentType: input.agentType ?? "review_code",
      provider: input.provider ?? "claude-code",
      mcpChannel: input.mcpChannel ?? null,
      reviewVerdict: input.reviewVerdict ?? null,
      startedAt: "2026-08-26T10:00:00.000Z",
      endedAt: input.endedAt ?? "2026-08-26T10:30:00.000Z",
      createdAt: "2026-08-26T10:00:00.000Z",
    })
    .run();
  return id;
}

beforeEach(() => {
  testDb.instance = createTestDb();
  counter = 0;
  db().insert(projects).values({ id: PROJECT_ID, name: "Wiring" }).run();
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
});

describe("readReviewChannelState — recorded wiring beats static config", () => {
  it("does not blame a reviewer whose channel was never wired", () => {
    const sessionId = insertReview({ mcpChannel: MCP_CHANNEL_UNAVAILABLE });
    expect(readReviewChannelState(sessionId, db())).toMatchObject({
      mcpCapable: false,
      unverifiable: false,
    });
  });

  it("still blames a reviewer whose channel was wired", () => {
    const sessionId = insertReview({ mcpChannel: MCP_CHANNEL_INJECTED });
    expect(readReviewChannelState(sessionId, db())).toMatchObject({
      mcpCapable: true,
      unverifiable: true,
    });
  });

  it("falls back to the provider for legacy rows that recorded nothing", () => {
    expect(
      readReviewChannelState(insertReview({ mcpChannel: null }), db())
    ).toMatchObject({ mcpCapable: true, unverifiable: true });
    expect(
      readReviewChannelState(
        insertReview({ mcpChannel: null, provider: "gemini-cli" }),
        db()
      )
    ).toMatchObject({ mcpCapable: false, unverifiable: false });
  });

  it("keeps a wired channel capable even on a row whose provider was removed", () => {
    // The recorded fact wins: Arij minted a token and handed over a config,
    // whatever the provider list says today.
    expect(
      readReviewChannelState(
        insertReview({ provider: "gemini-cli", mcpChannel: MCP_CHANNEL_INJECTED }),
        db()
      )
    ).toMatchObject({ mcpCapable: true, unverifiable: true });
  });
});

describe("listUnverifiableReviewEpicIds", () => {
  it("does not flag an epic whose reviewer never got the channel", () => {
    insertReview({ mcpChannel: MCP_CHANNEL_UNAVAILABLE });
    expect(listUnverifiableReviewEpicIds(PROJECT_ID, db()).size).toBe(0);
  });

  it("flags an epic whose reviewer got the channel and filed nothing", () => {
    insertReview({ mcpChannel: MCP_CHANNEL_INJECTED });
    expect([...listUnverifiableReviewEpicIds(PROJECT_ID, db())]).toEqual([
      EPIC_ID,
    ]);
  });

  /**
   * `review_second_opinion` is a Full Auto merge gate, not one of the four
   * ordinary review types the merge gate and the engine guard count. It is
   * also allowed to answer through the prose fail-safe, so judging it by the
   * structured channel would flag "cannot be merged" on an epic the merge
   * gate is perfectly happy to land.
   */
  it("ignores the second-opinion session", () => {
    insertReview({
      agentType: "review_second_opinion",
      mcpChannel: MCP_CHANNEL_INJECTED,
    });
    expect(listUnverifiableReviewEpicIds(PROJECT_ID, db()).size).toBe(0);
  });

  /**
   * Session timestamps mix ISO (`2026-08-26T…`, written by routes) and SQLite
   * CURRENT_TIMESTAMP (`2026-08-26 …`). ' ' sorts before 'T', so an unnormalised
   * comparison ranks every space-form row below every ISO row of the same day
   * and "the latest review" resolves to the wrong session.
   */
  it("ranks the latest review across both timestamp formats", () => {
    insertReview({
      mcpChannel: MCP_CHANNEL_INJECTED,
      endedAt: "2026-08-26T10:30:00.000Z",
    });
    // Newer in real time, but its timestamp is in SQLite's space form.
    insertReview({
      mcpChannel: MCP_CHANNEL_INJECTED,
      reviewVerdict: "approved",
      endedAt: "2026-08-26 23:00:00",
    });

    expect(listUnverifiableReviewEpicIds(PROJECT_ID, db()).size).toBe(0);
  });
});
