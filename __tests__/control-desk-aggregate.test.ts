/**
 * The pure derivation behind `GET /api/control-desk`.
 *
 * This file is the replacement safety net for the predicates the deleted board
 * tests used to pin from the UI side: merge affordances, queue ranks, blocked
 * labels, awaiting-reply and the unread-AI signal. They are all still exactly
 * one function call away from the shared `lib/kanban/*` helpers, and this file
 * is what proves the desk calls them instead of re-deciding.
 */

import { describe, expect, it } from "vitest";

import {
  deriveAwaitingReply,
  deriveConflicts,
  deriveFailures,
  deriveProjects,
  deriveQueued,
  deriveReadyToLand,
  deriveToday,
  deriveUpNext,
  deriveWorking,
  countUnreadAi,
  excerpt,
  inferTaskType,
  normalizeLogLine,
  shortProjectName,
  type EpicRow,
  type FailureSessionRow,
  type SessionRow,
} from "@/lib/control-desk/aggregate";
import { LOG_LINE_LIMIT } from "@/lib/control-desk/types";

function epic(overrides: Partial<EpicRow> & { id: string }): EpicRow {
  return {
    projectId: "p1",
    title: `Epic ${overrides.id}`,
    readableId: null,
    status: "todo",
    position: 0,
    priority: 0,
    type: "feature",
    branchName: null,
    prNumber: null,
    usCount: 1,
    usDone: 0,
    latestCommentId: null,
    latestCommentAuthor: null,
    latestCommentContent: null,
    latestCommentCreatedAt: null,
    latestSessionOutcome: null,
    latestSessionEndedAt: null,
    latestUserCommentCreatedAt: null,
    lastReadAt: null,
    openFindings: null,
    lastCleanReviewAt: null,
    lastTerminalCodeAt: null,
    lastNegativeVerdictReviewAt: null,
    supersessionAt: null,
    lastMergeConflictAt: null,
    lastConflictMarkersAt: null,
    ...overrides,
  };
}

function session(overrides: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    projectId: "p1",
    epicId: "e1",
    userStoryId: null,
    status: "running",
    mode: "code",
    agentType: "build",
    orchestrationMode: "solo",
    provider: "claude-code",
    namedAgentName: "Opus Builder",
    batchRunId: null,
    startedAt: "2026-08-28T09:00:00.000Z",
    createdAt: "2026-08-28T09:00:00.000Z",
    lastLogLine: null,
    epicTitle: "Streaming session logs over SSE",
    epicReadableId: "ARJ-122",
    storyTitle: null,
    ...overrides,
  };
}

function failureSession(
  overrides: Partial<FailureSessionRow> & { id: string },
): FailureSessionRow {
  return {
    kind: "agent_session",
    projectId: "p1",
    status: "failed",
    epicId: "e1",
    error: "exit 1 — worker pool did not drain in 120s",
    agentType: "build",
    provider: "claude-code",
    namedAgentId: "agent-1",
    namedAgentName: "Opus Builder",
    userStoryId: null,
    producedOutput: true,
    createdAt: "2026-08-28T09:00:00",
    endedAt: "2026-08-28T09:02:00",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */

describe("projects", () => {
  it("assigns colours from creation order, and wraps past four", () => {
    const projects = deriveProjects([
      { id: "b", name: "Ledger", createdAt: "2026-01-02" },
      { id: "a", name: "Arij", createdAt: "2026-01-01" },
      { id: "c", name: "Pixelbox", createdAt: "2026-01-03" },
      { id: "d", name: "Nimbus", createdAt: "2026-01-04" },
      { id: "e", name: "Fifth", createdAt: "2026-01-05" },
    ]);

    expect(projects.map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(projects.map((p) => p.colorIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("derives the mono rail label from the project name", () => {
    expect(shortProjectName("Arij")).toBe("ARIJ");
    expect(shortProjectName("Pixel box!")).toBe("PIXELBOX");
    // Too long to squash: head + one initial per remaining word, so two
    // projects sharing a first word stay distinguishable in the rail.
    expect(shortProjectName("Arij Front")).toBe("ARIJF");
    expect(shortProjectName("Arij")).not.toBe(shortProjectName("Arij Front"));
    // The rail label is a fixed 70px column, so 8 is the hard ceiling.
    expect(shortProjectName("Extraordinarily Long")).toHaveLength(8);
  });

  it("counts active agents and reads the per-project Full Auto flag", () => {
    const [project] = deriveProjects([
      { id: "a", name: "Arij", activeAgents: 3, autoModeEnabled: true },
    ]);
    expect(project.activeAgents).toBe(3);
    expect(project.autoModeEnabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("working / queued", () => {
  it("splits running from queued", () => {
    const rows = [
      session({ id: "s1", status: "running" }),
      session({ id: "s2", status: "queued", epicId: "e2", epicReadableId: "ARJ-131" }),
    ];
    expect(deriveWorking(rows).map((s) => s.sessionId)).toEqual(["s1"]);
    expect(deriveQueued(rows).map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("classifies the dispatch role from the agent type, the orchestration and the mode", () => {
    expect(
      inferTaskType({ agentType: "review_code", orchestrationMode: null, mode: "code" }),
    ).toBe("REVIEW");
    expect(
      inferTaskType({ agentType: "merge", orchestrationMode: null, mode: "code" }),
    ).toBe("MERGE");
    expect(
      inferTaskType({ agentType: "grading", orchestrationMode: null, mode: "plan" }),
    ).toBe("GRADING");
    // A team build runs in code mode and must not fall through to the mode
    // heuristic below it.
    expect(
      inferTaskType({ agentType: null, orchestrationMode: "team", mode: "plan" }),
    ).toBe("BUILD");
    expect(
      inferTaskType({ agentType: null, orchestrationMode: "solo", mode: "plan" }),
    ).toBe("REVIEW");
    expect(
      inferTaskType({ agentType: null, orchestrationMode: "solo", mode: "code" }),
    ).toBe("BUILD");
  });

  // The classification takes NO prompt: the sessions/active heuristic it used
  // to copy reads the whole 77 KB-average column on a 4 s poll, and reads it
  // wrong — every prompt carries the project spec, so a spec that says the
  // words "merge conflict" turned every build on that project into a MERGE
  // card. The merge agent is already identified by its agent type, which is
  // checked first, so the heuristic could only ever have produced that
  // mislabel. `control-desk-route.test.ts` pins the same case end to end.
  it("keeps an ordinary build a BUILD even when its spec talks about merge conflicts", () => {
    expect(
      inferTaskType({
        agentType: "ticket_build",
        orchestrationMode: "solo",
        mode: "code",
      }),
    ).toBe("BUILD");
  });

  it("flags a night-run session from its batch id", () => {
    const [live] = deriveWorking([session({ id: "s1", batchRunId: "night_abc" })]);
    expect(live.nightRun).toBe(true);
    expect(deriveWorking([session({ id: "s2" })])[0].nightRun).toBe(false);
  });

  it("clips the log line and refuses an empty one", () => {
    // The column is uncapped at the write side; the route substrings it and
    // this is the second belt.
    expect(normalizeLogLine("a".repeat(500))).toHaveLength(LOG_LINE_LIMIT);
    expect(normalizeLogLine("  \n ")).toBeNull();
    expect(normalizeLogLine("editing  lib/sse/stream.ts")).toBe("editing lib/sse/stream.ts");
  });

  it("prefers the story title, then the epic title, then a role label", () => {
    expect(
      deriveWorking([session({ id: "s1", storyTitle: "Parse the OFX header" })])[0].title,
    ).toBe("Parse the OFX header");
    expect(
      deriveWorking([session({ id: "s1", storyTitle: null, epicTitle: null, agentType: "release_notes" })])[0]
        .title,
    ).toBe("Generating release notes");
  });
});

/* ------------------------------------------------------------------ */

describe("today", () => {
  it("keeps a missing figure null so the tile can render an em-dash", () => {
    const today = deriveToday({
      ticketsShipped: 7,
      failedSessions: 1,
      costUsd: null,
      projects: 3,
      sessions: 14,
    });
    expect(today.ticketsShipped).toBe(7);
    // SUM() over sessions that reported no cost answers NULL, and NULL must
    // never become 0 on the way to the tile.
    expect(today.costUsd).toBeNull();
  });

  it("keeps a real zero", () => {
    expect(deriveToday({ ticketsShipped: 0 }).ticketsShipped).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe("your turn — awaiting reply", () => {
  const asked = epic({
    id: "e1",
    readableId: "PXB-24",
    latestSessionOutcome: "asked_question",
    latestSessionEndedAt: "2026-08-28T09:00:00",
    latestCommentId: "c1",
    latestCommentAuthor: "agent",
    latestCommentContent: "Je garde le renderer legacy derrière un flag, ou je le supprime ?",
    latestCommentCreatedAt: "2026-08-28T09:00:00",
  });

  it("uses isAwaitingReply — an unanswered question is a row", () => {
    const rows = deriveAwaitingReply([asked]);
    expect(rows).toHaveLength(1);
    expect(rows[0].readableId).toBe("PXB-24");
    expect(rows[0].question).toContain("renderer legacy");
  });

  it("drops the row once the user has replied", () => {
    const replied = { ...asked, latestUserCommentCreatedAt: "2026-08-28T09:05:00" };
    expect(deriveAwaitingReply([replied])).toHaveLength(0);
  });

  it("carries the unread-AI signal, cursor and all", () => {
    expect(deriveAwaitingReply([asked])[0].unreadAi).toBe(true);
    const read = { ...asked, lastReadAt: "2026-08-28T09:10:00" };
    expect(deriveAwaitingReply([read])[0].unreadAi).toBe(false);
  });

  it("counts unread AI comments across every epic, read or not", () => {
    const otherUnread = epic({
      id: "e2",
      latestCommentId: "c9",
      latestCommentAuthor: "agent",
      latestCommentCreatedAt: "2026-08-28T10:00:00",
    });
    expect(countUnreadAi([asked, otherUnread])).toBe(2);
  });

  it("clips a long question", () => {
    expect(excerpt("x".repeat(400))).toHaveLength(200);
    expect(excerpt(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("your turn — failures", () => {
  const epicsById = new Map([["e1", epic({ id: "e1", readableId: "NMB-09" })]]);

  it("badges the latest failed session", () => {
    const rows = deriveFailures(
      [failureSession({ id: "s1" })],
      epicsById,
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("s1");
    expect(rows[0].readableId).toBe("NMB-09");
    expect(rows[0].error).toContain("worker pool");
  });

  it("clears the badge when a retry shares the failure's second", () => {
    // created_at is a SQLite CURRENT_TIMESTAMP (second precision), so a retry
    // created in the same second as the failure it replaces ties. The tie must
    // break in favour of CLEARING, or the desk shows stale failures forever.
    const rows = deriveFailures(
      [
        failureSession({ id: "s1" }),
        failureSession({ id: "s2", status: "queued", error: "" }),
      ],
      epicsById,
      new Set(),
    );
    expect(rows).toHaveLength(0);
  });

  it("never badges an epic that has an agent running", () => {
    const rows = deriveFailures([failureSession({ id: "s1" })], epicsById, new Set(["e1"]));
    expect(rows).toHaveLength(0);
  });

  it("carries what the retry dispatcher needs to decide agent and resume", () => {
    const [row] = deriveFailures([failureSession({ id: "s1" })], epicsById, new Set());
    expect(row.provider).toBe("claude-code");
    expect(row.namedAgentId).toBe("agent-1");
    expect(row.userStoryId).toBeNull();
    expect(row.producedOutput).toBe(true);
    expect(row.agentName).toBe("Opus Builder");
  });
});

/* ------------------------------------------------------------------ */

describe("your turn — conflicts", () => {
  it("reports a current merge conflict on a to_merge ticket", () => {
    const rows = deriveConflicts([
      epic({
        id: "e1",
        readableId: "LDG-71",
        status: "to_merge",
        branchName: "epic/ldg-71",
        lastMergeConflictAt: "2026-08-28T09:00:00",
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocker).toBe("merge_conflict");
    expect(rows[0].branchName).toBe("epic/ldg-71");
  });

  it("clears once a code session has touched the branch since", () => {
    const rows = deriveConflicts([
      epic({
        id: "e1",
        status: "to_merge",
        branchName: "epic/ldg-71",
        lastMergeConflictAt: "2026-08-28T09:00:00",
        lastTerminalCodeAt: "2026-08-28T10:00:00",
      }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("tells conflict markers apart from a merge conflict", () => {
    const rows = deriveConflicts([
      epic({
        id: "e1",
        status: "to_merge",
        branchName: "b",
        lastMergeConflictAt: "2026-08-28T09:00:00",
        lastConflictMarkersAt: "2026-08-28T09:30:00",
      }),
    ]);
    expect(rows[0].blocker).toBe("conflict_markers");
  });

  it("ignores tickets outside to_merge", () => {
    expect(
      deriveConflicts([
        epic({ id: "e1", status: "review", lastMergeConflictAt: "2026-08-28T09:00:00" }),
      ]),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("ready to land", () => {
  const ready = epic({
    id: "e1",
    readableId: "ARJ-107",
    status: "to_merge",
    branchName: "epic/arj-107",
    prNumber: 218,
    usCount: 4,
    usDone: 4,
  });

  it("lists a ticket the merge route would accept", () => {
    const { rows, heldBackCount } = deriveReadyToLand([ready], new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].prNumber).toBe(218);
    expect(rows[0].usDone).toBe(4);
    expect(heldBackCount).toBe(0);
  });

  it("counts a blocked to_merge ticket as held back instead of listing it", () => {
    const blocked = {
      ...ready,
      lastNegativeVerdictReviewAt: "2026-08-28T09:00:00",
    };
    const { rows, heldBackCount } = deriveReadyToLand([blocked], new Set());
    expect(rows).toHaveLength(0);
    expect(heldBackCount).toBe(1);
  });

  it("holds back a ticket with no branch", () => {
    const { rows, heldBackCount } = deriveReadyToLand(
      [{ ...ready, branchName: null }],
      new Set(),
    );
    expect(rows).toHaveLength(0);
    expect(heldBackCount).toBe(1);
  });

  it("withholds the Land affordance while ANY session owns the ticket", () => {
    // Queued counts, not just running: merging removes the worktree a queued
    // build would land in.
    const { rows } = deriveReadyToLand([ready], new Set(["e1"]));
    expect(rows[0].agentBusy).toBe(true);
  });

  it("echoes the blocking finding count without gating on it", () => {
    const withFindings = { ...ready, openFindings: 2 };
    const { rows } = deriveReadyToLand([withFindings], new Set());
    // The merge IS the approval and resolves whatever is left, so findings are
    // information on the row, never a refusal.
    expect(rows).toHaveLength(1);
    expect(rows[0].openFindings).toBe(2);
  });
});

/* ------------------------------------------------------------------ */

describe("up next", () => {
  const projects = deriveProjects([{ id: "p1", name: "Arij", createdAt: "2026-01-01" }]);

  it("ranks In Progress before To Do, then by position — Full Auto's own order", () => {
    const rows = deriveUpNext(
      projects,
      [
        epic({ id: "a", status: "todo", position: 0, readableId: "ARJ-1" }),
        epic({ id: "b", status: "in_progress", position: 9, readableId: "ARJ-2" }),
        epic({ id: "c", status: "todo", position: 1, readableId: "ARJ-3" }),
      ],
      [],
      new Set(),
    );
    expect(rows[0].tickets.map((t) => t.epicId)).toEqual(["b", "a", "c"]);
    expect(rows[0].tickets.map((t) => t.rank)).toEqual([1, 2, 3]);
  });

  it("ignores tickets outside the two buildable columns", () => {
    const rows = deriveUpNext(
      projects,
      [
        epic({ id: "a", status: "backlog" }),
        epic({ id: "b", status: "review" }),
        epic({ id: "c", status: "done" }),
        epic({ id: "d", status: "todo" }),
      ],
      [],
      new Set(),
    );
    expect(rows[0].tickets.map((t) => t.epicId)).toEqual(["d"]);
  });

  it("gives a dependency-blocked ticket no rank and names what blocks it", () => {
    const rows = deriveUpNext(
      projects,
      [
        epic({ id: "a", status: "todo", position: 0, readableId: "ARJ-125" }),
        epic({ id: "b", status: "todo", position: 1, readableId: "ARJ-131" }),
      ],
      [{ ticketId: "a", dependsOnTicketId: "b" }],
      new Set(),
    );
    const [blocked, next] = rows[0].tickets;
    expect(blocked.rank).toBeNull();
    // Resolved server-side: the desk does not hold every project's full board.
    expect(blocked.blockedBy).toEqual(["ARJ-131"]);
    // A skipped ticket does not consume a number.
    expect(next.rank).toBe(1);
  });

  it("stops blocking once the prerequisite is delivered", () => {
    const rows = deriveUpNext(
      projects,
      [
        epic({ id: "a", status: "todo", position: 0 }),
        epic({ id: "b", status: "done", position: 1 }),
      ],
      [{ ticketId: "a", dependsOnTicketId: "b" }],
      new Set(),
    );
    expect(rows[0].tickets[0].rank).toBe(1);
    expect(rows[0].tickets[0].blockedBy).toEqual([]);
  });

  it("skips a ticket awaiting the user's reply, like the supervisor does", () => {
    const rows = deriveUpNext(
      projects,
      [
        epic({
          id: "a",
          status: "todo",
          position: 0,
          latestSessionOutcome: "asked_question",
          latestSessionEndedAt: "2026-08-28T09:00:00",
        }),
        epic({ id: "b", status: "todo", position: 1 }),
      ],
      [],
      new Set(),
    );
    expect(rows[0].tickets[0].rank).toBeNull();
    expect(rows[0].tickets[0].awaitingReply).toBe(true);
    expect(rows[0].tickets[1].rank).toBe(1);
  });

  it("skips a ticket an agent already owns", () => {
    const rows = deriveUpNext(
      projects,
      [
        epic({ id: "a", status: "todo", position: 0 }),
        epic({ id: "b", status: "todo", position: 1 }),
      ],
      [],
      new Set(["a"]),
    );
    expect(rows[0].tickets[0].rank).toBeNull();
    expect(rows[0].tickets[1].rank).toBe(1);
  });

  it("keeps each project's queue separate", () => {
    const two = deriveProjects([
      { id: "p1", name: "Arij", createdAt: "2026-01-01" },
      { id: "p2", name: "Ledger", createdAt: "2026-01-02" },
    ]);
    const rows = deriveUpNext(
      two,
      [
        epic({ id: "a", projectId: "p1", status: "todo", position: 0 }),
        epic({ id: "b", projectId: "p2", status: "todo", position: 0 }),
      ],
      [],
      new Set(),
    );
    expect(rows.map((r) => r.projectId)).toEqual(["p1", "p2"]);
    expect(rows[0].tickets.map((t) => t.epicId)).toEqual(["a"]);
    expect(rows[1].tickets.map((t) => t.epicId)).toEqual(["b"]);
  });

  it("marks a storyless feature as spec-only", () => {
    const rows = deriveUpNext(
      projects,
      [
        epic({ id: "a", status: "todo", usCount: 0, type: "feature" }),
        epic({ id: "b", status: "todo", usCount: 0, type: "bug" }),
      ],
      [],
      new Set(),
    );
    expect(rows[0].tickets[0].specOnly).toBe(true);
    // A bug's creation flow has no stories by design — it is not "missing" one.
    expect(rows[0].tickets[1].specOnly).toBe(false);
  });
});
