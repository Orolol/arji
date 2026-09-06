/**
 * The registry's pure derivation, from plain objects.
 *
 * This is where the packet's whole promise is checked: the registry must never
 * disagree with the desk about what state a ticket is in, because every group
 * predicate is a call into a helper the desk already calls.
 */
import { describe, it, expect } from "vitest";

import { formatRelative } from "@/lib/i18n/format";
import { deriveProjects, type FailureSessionRow } from "@/lib/control-desk/aggregate";
import {
  GROUP_PREVIEW,
  TASK_LABEL,
  composeActivity,
  deriveRegistryRows,
  type RegistrySessionRow,
  deriveRegistryTotals,
  type RegistryEpicRow,
} from "@/lib/tickets-registry/aggregate";
import type { TicketDependencyEdge } from "@/lib/types/kanban";

const NOW = new Date("2026-08-30T12:00:00.000Z");

const projects = deriveProjects([
  { id: "p1", name: "Arij", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "p2", name: "Ledger", createdAt: "2026-01-02T00:00:00.000Z" },
]);

function epic(overrides: Partial<RegistryEpicRow> & { id: string }): RegistryEpicRow {
  return {
    projectId: "p1",
    title: "Streaming session logs over SSE",
    readableId: `ARJ-${overrides.id}`,
    status: "todo",
    position: 0,
    priority: 2,
    type: "feature",
    branchName: "epic/arj",
    prNumber: null,
    usCount: 4,
    usDone: 2,
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
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
    releaseId: null,
    ...overrides,
  };
}

function session(overrides: Partial<RegistrySessionRow> & { id: string }): RegistrySessionRow {
  return {
    activityAt: null,
    projectId: "p1",
    epicId: null,
    userStoryId: null,
    status: "running",
    mode: null,
    agentType: null,
    orchestrationMode: null,
    provider: null,
    namedAgentName: null,
    batchRunId: null,
    startedAt: "2026-08-30T11:55:00.000Z",
    createdAt: "2026-08-30T11:55:00.000Z",
    lastLogLine: "editing lib/sse/stream.ts",
    epicTitle: null,
    epicReadableId: null,
    storyTitle: null,
    ...overrides,
  };
}

function failure(
  overrides: Partial<FailureSessionRow> & { id: string },
): FailureSessionRow {
  return {
    kind: "agent_session",
    projectId: "p1",
    status: "failed",
    epicId: null,
    error: "exit 1",
    agentType: "build",
    provider: null,
    namedAgentId: null,
    namedAgentName: null,
    userStoryId: null,
    producedOutput: false,
    createdAt: "2026-08-30T11:39:00.000Z",
    endedAt: "2026-08-30T11:39:00.000Z",
    ...overrides,
  };
}

function derive(input: {
  epics: RegistryEpicRow[];
  sessions?: RegistrySessionRow[];
  failures?: FailureSessionRow[];
  edges?: TicketDependencyEdge[];
  releases?: Map<string, string>;
  costs?: Map<string, number | null>;
}) {
  return deriveRegistryRows({
    projects,
    epics: input.epics,
    sessions: input.sessions ?? [],
    failureSessions: input.failures ?? [],
    edges: input.edges ?? [],
    releaseVersionById: input.releases ?? new Map(),
    costByEpicId: input.costs ?? new Map(),
    locale: "en",
    now: NOW,
  });
}

describe("group precedence", () => {
  it("a running session on a to_merge epic lands in ACTIVE, not DONE", () => {
    const [row] = derive({
      epics: [epic({ id: "1", status: "to_merge" })],
      sessions: [session({ id: "s1", epicId: "1", agentType: "review_code" })],
    });
    expect(row.group).toBe("active");
    expect(row.taskType).toBe("REVIEW");
    expect(TASK_LABEL[row.taskType!]).toBe("Review");
  });

  it("a to_merge epic with a live merge conflict lands in YOUR TURN, not DONE", () => {
    const [row] = derive({
      epics: [
        epic({
          id: "1",
          status: "to_merge",
          lastMergeConflictAt: "2026-08-30T10:00:00.000Z",
        }),
      ],
    });
    expect(row.group).toBe("your_turn");
    expect(row.yourTurnKind).toBe("conflict");
  });

  it("a to_merge epic that is ready lands in DONE as ready", () => {
    const [row] = derive({ epics: [epic({ id: "1", status: "to_merge" })] });
    expect(row.group).toBe("done");
    expect(row.mergeReady).toBe(true);
    expect(row.mergeBlockerLine).toBeNull();
  });

  it("a to_merge epic held back by a standing rejection stays in DONE with its blocker line", () => {
    const [row] = derive({
      epics: [
        epic({
          id: "1",
          status: "to_merge",
          lastNegativeVerdictReviewAt: "2026-08-28T00:00:00.000Z",
        }),
      ],
    });
    expect(row.group).toBe("done");
    expect(row.mergeReady).toBe(false);
    expect(row.mergeBlockerLine).toBe("Changes requested — awaiting a fix");
  });

  it("isAwaitingReply beats a stale failure", () => {
    const rows = derive({
      epics: [
        epic({
          id: "1",
          latestSessionOutcome: "asked_question",
          latestSessionEndedAt: "2026-08-30T11:54:00.000Z",
        }),
      ],
      failures: [failure({ id: "s1", epicId: "1" })],
    });
    expect(rows[0].group).toBe("your_turn");
    expect(rows[0].yourTurnKind).toBe("asks");
  });

  it("a retry created in the SAME SECOND as the failure clears FAILED", () => {
    const at = "2026-08-30T11:39:00.000Z";
    const withRetry = derive({
      epics: [epic({ id: "1" })],
      failures: [
        failure({ id: "s1", epicId: "1", createdAt: at, endedAt: at }),
        failure({
          id: "s2",
          epicId: "1",
          status: "running",
          error: null,
          createdAt: at,
          endedAt: null,
        }),
      ],
    });
    expect(withRetry[0].group).toBe("waiting");

    const withoutRetry = derive({
      epics: [epic({ id: "1" })],
      failures: [failure({ id: "s1", epicId: "1", createdAt: at, endedAt: at })],
    });
    expect(withoutRetry[0].group).toBe("your_turn");
    expect(withoutRetry[0].yourTurnKind).toBe("failed");
  });

  it("released and done statuses land in their own groups", () => {
    const rows = derive({
      epics: [
        epic({ id: "1", status: "released", releaseId: "r1" }),
        epic({ id: "2", status: "done" }),
        epic({ id: "3", status: "review" }),
      ],
      releases: new Map([["r1", "v0.4.2"]]),
    });
    expect(rows.map((r) => r.group)).toEqual(["released", "done", "waiting"]);
    expect(rows[0].releaseVersion).toBe("v0.4.2");
  });

  it("a released epic whose release_id is null carries no version", () => {
    const [row] = derive({ epics: [epic({ id: "1", status: "released" })] });
    expect(row.releaseVersion).toBeNull();
  });
});

describe("the waiting group", () => {
  it("takes its rank from deriveUpNext and resolves blocked-by to labels", () => {
    const rows = derive({
      epics: [
        epic({ id: "1", status: "todo", position: 0, readableId: "ARJ-131" }),
        epic({ id: "2", status: "todo", position: 1, readableId: "ARJ-128" }),
        epic({ id: "3", status: "todo", position: 2, readableId: "ARJ-125" }),
      ],
      edges: [{ ticketId: "3", dependsOnTicketId: "2" }],
    });
    const byId = new Map(rows.map((row) => [row.epicId, row]));
    expect(byId.get("1")!.queueLabel).toBe("To Do");
    expect(byId.get("1")!.queueRank).toBe(1);
    expect(byId.get("2")!.queueRank).toBe(2);
    // Blocked tickets consume no rank — the desk's own exclusion.
    expect(byId.get("3")!.queueRank).toBeNull();
    expect(byId.get("3")!.blockedBy).toEqual(["ARJ-128"]);
    expect(byId.get("3")!.activity).toBe("blocked · 1d ago");
  });

  // 10.5 days before NOW reads "10d ago": the shared `formatRelative` floors
  // whole units the way `timeAgo` and the French formatters always did; the
  // registry's retired copy was the one variant that rounded half-days up.
  it("marks a backlog epic as a draft and dates it from creation", () => {
    const [row] = derive({ epics: [epic({ id: "1", status: "backlog" })] });
    expect(row.isDraft).toBe(true);
    expect(row.queueLabel).toBe("Backlog");
    expect(row.activity).toBe("created · 10d ago");
  });

  it("marks a ticket a queued session already owns", () => {
    const [row] = derive({
      epics: [epic({ id: "1", status: "todo" })],
      sessions: [session({ id: "s1", epicId: "1", status: "queued" })],
    });
    expect(row.group).toBe("waiting");
    expect(row.isQueued).toBe(true);
    // A busy ticket consumes no execution rank either.
    expect(row.queueRank).toBeNull();
  });
});

describe("composeActivity", () => {
  const base = {
    yourTurnKind: null,
    status: "todo",
    blocked: false,
    mergeReady: false,
    lastLogLine: null,
    askedAt: null,
    failedAt: null,
    failureError: null,
    conflictAt: null,
    branchName: null,
    prNumber: null,
    openFindings: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
    locale: "en",
    now: NOW,
  } as const;

  it("active quotes the streamed line, or an ellipsis when there is none", () => {
    expect(
      composeActivity({ ...base, group: "active", lastLogLine: "running vitest" })
        .activity,
    ).toBe("› running vitest");
    expect(composeActivity({ ...base, group: "active" }).activity).toBe("› …");
  });

  it("asks / failed / conflict", () => {
    expect(
      composeActivity({
        ...base,
        group: "your_turn",
        yourTurnKind: "asks",
        askedAt: "2026-08-30T11:54:00.000Z",
      }).activity,
    ).toBe("question · 6m ago");

    const failed = composeActivity({
      ...base,
      group: "your_turn",
      yourTurnKind: "failed",
      failureError: "exit 1",
      failedAt: "2026-08-30T11:39:00.000Z",
    });
    expect(failed.activity).toBe("exit 1 · 21m ago");
    expect(failed.tone).toBe("you-deep");

    expect(
      composeActivity({
        ...base,
        group: "your_turn",
        yourTurnKind: "conflict",
        branchName: "epic/tax-export",
        conflictAt: "2026-08-30T11:00:00.000Z",
      }).activity,
    ).toBe("epic/tax-export · 1h ago");

    // No branch recorded: the word, never an invented file list.
    expect(
      composeActivity({ ...base, group: "your_turn", yourTurnKind: "conflict" })
        .activity,
    ).toBe("branche · —");
  });

  it("waiting: blocked, backlog and everything else", () => {
    expect(composeActivity({ ...base, group: "waiting", blocked: true }).activity).toBe(
      "blocked · 1d ago",
    );
    expect(
      composeActivity({ ...base, group: "waiting", status: "backlog" }).activity,
    ).toBe("created · 10d ago");
    expect(composeActivity({ ...base, group: "waiting" }).activity).toBe(
      "updated · 1d ago",
    );
  });

  it("done: ready with a PR, ready without findings, merged, and held back", () => {
    expect(
      composeActivity({
        ...base,
        group: "done",
        status: "to_merge",
        mergeReady: true,
        prNumber: 218,
        openFindings: 0,
      }).activity,
    ).toBe("#218 · review clean");
    expect(
      composeActivity({
        ...base,
        group: "done",
        status: "to_merge",
        mergeReady: true,
        openFindings: 2,
      }).activity,
    ).toBe("2 findings");
    expect(composeActivity({ ...base, group: "done", status: "done" }).activity).toBe(
      "merged · 1d ago",
    );
    expect(
      composeActivity({ ...base, group: "done", status: "to_merge" }).activity,
    ).toBe("updated · 1d ago");
  });

  it("released", () => {
    expect(
      composeActivity({ ...base, group: "released", status: "released" }).activity,
    ).toBe("released · 1d ago");
  });
});

describe("data gaps", () => {
  it("a ticket with no stories reports no fraction and a null cost stays null", () => {
    const [row] = derive({ epics: [epic({ id: "1", usCount: 0, usDone: 0 })] });
    expect(row.usCount).toBe(0);
    expect(row.costUsd).toBeNull();
  });

  it("a cost of exactly zero is kept — only an absent SUM is null", () => {
    const [row] = derive({
      epics: [epic({ id: "1" })],
      costs: new Map([["1", 0]]),
    });
    expect(row.costUsd).toBe(0);
  });
});

describe("activity ages", () => {
  /**
   * The registry used to keep a byte-identical copy of the desk's
   * `relativeAge` and pin the two together here. Both are the shared
   * `formatRelative` now, so what this pins is that the column really goes
   * through it — seconds while fresh, SQLite stamps read as UTC, an em dash
   * for an unreadable one.
   */
  it("are the shared formatRelative, seconds precision", () => {
    const stamp = (at: string | null) =>
      formatRelative(at, { locale: "en", now: NOW, precision: "second" }) || "—";
    const composed = (updatedAt: string | null) =>
      composeActivity({
        group: "released",
        yourTurnKind: null,
        status: "released",
        blocked: false,
        mergeReady: false,
        lastLogLine: null,
        askedAt: null,
        failedAt: null,
        failureError: null,
        conflictAt: null,
        branchName: null,
        prNumber: null,
        openFindings: null,
        createdAt: null,
        updatedAt,
        locale: "en",
        now: NOW,
      }).activity;
    for (const sample of [
      "2026-08-30T11:59:30.000Z",
      "2026-08-30T11:39:00.000Z",
      "2026-08-30 11:00:00",
      "2026-08-20T00:00:00.000Z",
      "not a date",
    ]) {
      expect(composed(sample)).toBe(`released · ${stamp(sample)}`);
    }
    expect(stamp("2026-08-30T11:59:30.000Z")).toBe("30s ago");
    expect(stamp("2026-08-30 11:00:00")).toBe("1h ago");
    expect(stamp("not a date")).toBe("—");
  });
});

describe("deriveRegistryTotals", () => {
  it("adds the unloaded window remainder to the terminal groups only", () => {
    const rows = derive({
      epics: [
        epic({ id: "a", status: "todo" }),
        epic({ id: "b", status: "done" }),
        epic({ id: "c", status: "released" }),
      ],
    });
    const totals = deriveRegistryTotals({
      rows,
      statusCounts: new Map([
        ["todo", 1],
        ["done", 9],
        ["released", 20],
      ]),
    });
    expect(totals.groupLoaded).toEqual({
      active: 0,
      your_turn: 0,
      waiting: 1,
      done: 1,
      released: 1,
    });
    expect(totals.groupTotals.done).toBe(9);
    expect(totals.groupTotals.released).toBe(20);
    expect(totals.counts.open).toBe(1);
    expect(totals.counts.all).toBe(30);
  });

  it("counts a to_merge ticket in DONE rather than in OPEN", () => {
    const rows = derive({ epics: [epic({ id: "a", status: "to_merge" })] });
    const totals = deriveRegistryTotals({
      rows,
      statusCounts: new Map([["to_merge", 1]]),
    });
    expect(totals.counts.done).toBe(1);
    expect(totals.counts.open).toBe(0);
    expect(totals.counts.all).toBe(1);
  });
});

describe("GROUP_PREVIEW", () => {
  it("keeps the frame's caps", () => {
    expect(GROUP_PREVIEW).toEqual({
      active: 4,
      your_turn: 4,
      waiting: 4,
      done: 3,
      released: 2,
    });
  });
});

 it("exposes the live session's latest output date for activity sorting", () => {
  const [row] = derive({
    epics: [epic({ id: "live" })],
    sessions: [{ ...session({ id: "s", epicId: "live" }), activityAt: "2026-08-30T11:59:00Z" }],
  });
  expect(row.activityAt).toBe("2026-08-30T11:59:00Z");
});
