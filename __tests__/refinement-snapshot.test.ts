/**
 * The board snapshot a refinement re-pass reads.
 *
 * `assembleRefinementSnapshot` is pure, so these run against it directly —
 * no database. The contracts that matter: only the two planning columns are
 * emitted, order comes from `position` and nothing else, dependency
 * endpoints are described even when they sit outside the planning columns,
 * and awaiting-reply state is carried through so the pass leaves those
 * tickets alone.
 */
import { describe, expect, it } from "vitest";
import {
  assembleRefinementSnapshot,
  snapshotSize,
  type RefinementSnapshotInput,
} from "@/lib/refinement/snapshot";

type EpicSeed = Partial<RefinementSnapshotInput["epics"][number]> & {
  id: string;
};

function epic(seed: EpicSeed): RefinementSnapshotInput["epics"][number] {
  return {
    readableId: seed.id.toUpperCase(),
    title: `Title ${seed.id}`,
    type: "feature",
    status: "backlog",
    priority: 0,
    position: 0,
    description: null,
    ...seed,
  };
}

function input(
  overrides: Partial<RefinementSnapshotInput> = {}
): RefinementSnapshotInput {
  return {
    epics: [],
    stories: [],
    dependencies: [],
    awaiting: new Map(),
    latestAgentComment: new Map(),
    ...overrides,
  };
}

describe("assembleRefinementSnapshot — column membership", () => {
  it("emits only backlog and todo tickets", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [
          epic({ id: "a", status: "backlog" }),
          epic({ id: "b", status: "todo" }),
          epic({ id: "c", status: "in_progress" }),
          epic({ id: "d", status: "review" }),
          epic({ id: "e", status: "done" }),
          epic({ id: "f", status: "released" }),
        ],
      })
    );

    expect(snapshot.backlog.map((t) => t.id)).toEqual(["a"]);
    expect(snapshot.todo.map((t) => t.id)).toEqual(["b"]);
    expect(snapshotSize(snapshot)).toBe(2);
  });

  it("returns empty columns for an empty board", () => {
    const snapshot = assembleRefinementSnapshot(input());
    expect(snapshot).toEqual({ backlog: [], todo: [] });
    expect(snapshotSize(snapshot)).toBe(0);
  });
});

describe("assembleRefinementSnapshot — ordering", () => {
  it("orders each column by board position, not by priority or insertion", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [
          epic({ id: "a", status: "todo", position: 2, priority: 3 }),
          epic({ id: "b", status: "todo", position: 0, priority: 0 }),
          epic({ id: "c", status: "todo", position: 1, priority: 3 }),
        ],
      })
    );

    expect(snapshot.todo.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties on position deterministically", () => {
    const first = assembleRefinementSnapshot(
      input({
        epics: [
          epic({ id: "zzz", status: "todo", position: 0 }),
          epic({ id: "aaa", status: "todo", position: 0 }),
        ],
      })
    );
    const second = assembleRefinementSnapshot(
      input({
        epics: [
          epic({ id: "aaa", status: "todo", position: 0 }),
          epic({ id: "zzz", status: "todo", position: 0 }),
        ],
      })
    );

    expect(first.todo.map((t) => t.id)).toEqual(["aaa", "zzz"]);
    expect(second.todo.map((t) => t.id)).toEqual(first.todo.map((t) => t.id));
  });

  it("treats a null position as 0 rather than dropping the ticket", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [
          epic({ id: "a", status: "todo", position: 1 }),
          epic({ id: "b", status: "todo", position: null }),
        ],
      })
    );
    expect(snapshot.todo.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("assembleRefinementSnapshot — dependencies", () => {
  it("describes both directions with the endpoint's column", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [
          epic({ id: "a", status: "todo" }),
          epic({ id: "b", status: "backlog" }),
        ],
        dependencies: [{ ticketId: "a", dependsOnTicketId: "b" }],
      })
    );

    expect(snapshot.todo[0].dependsOn).toEqual([
      { ticketId: "b", label: "B", status: "backlog", satisfied: false },
    ]);
    expect(snapshot.backlog[0].blocks).toEqual([
      { ticketId: "a", label: "A", status: "todo", satisfied: false },
    ]);
  });

  it("marks a done dependency as satisfied", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [
          epic({ id: "a", status: "todo" }),
          epic({ id: "b", status: "done" }),
        ],
        dependencies: [{ ticketId: "a", dependsOnTicketId: "b" }],
      })
    );
    expect(snapshot.todo[0].dependsOn[0]).toMatchObject({
      status: "done",
      satisfied: true,
    });
  });

  it("keeps a dependency on work already in flight visible", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [
          epic({ id: "a", status: "todo" }),
          epic({ id: "b", status: "in_progress" }),
        ],
        dependencies: [{ ticketId: "a", dependsOnTicketId: "b" }],
      })
    );
    expect(snapshot.todo[0].dependsOn[0]).toMatchObject({
      status: "in_progress",
      satisfied: false,
    });
  });

  it("does not list non-planning dependents under blocks", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [
          epic({ id: "a", status: "backlog" }),
          epic({ id: "b", status: "in_progress" }),
        ],
        dependencies: [{ ticketId: "b", dependsOnTicketId: "a" }],
      })
    );
    // b waits on a, but b is in flight — out of the re-pass's scope.
    expect(snapshot.backlog[0].blocks).toEqual([]);
  });
});

describe("assembleRefinementSnapshot — readiness signals", () => {
  it("flags a ticket whose last session asked an unanswered question", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [epic({ id: "a", status: "todo" })],
        awaiting: new Map([
          [
            "a",
            {
              latestSessionOutcome: "asked_question",
              latestSessionEndedAt: "2026-08-20T10:00:00.000Z",
              latestUserCommentCreatedAt: null,
            },
          ],
        ]),
        latestAgentComment: new Map([["a", "Which provider should we use?"]]),
      })
    );

    expect(snapshot.todo[0].awaitingReply).toBe(true);
    expect(snapshot.todo[0].openQuestion).toBe("Which provider should we use?");
  });

  it("clears the flag once the user has replied", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [epic({ id: "a", status: "todo" })],
        awaiting: new Map([
          [
            "a",
            {
              latestSessionOutcome: "asked_question",
              latestSessionEndedAt: "2026-08-20T10:00:00.000Z",
              latestUserCommentCreatedAt: "2026-08-20T11:00:00.000Z",
            },
          ],
        ]),
        latestAgentComment: new Map([["a", "Which provider?"]]),
      })
    );

    expect(snapshot.todo[0].awaitingReply).toBe(false);
    // The stale question must not be surfaced as open once answered.
    expect(snapshot.todo[0].openQuestion).toBeNull();
  });

  it("marks stories that have no acceptance criteria", () => {
    const snapshot = assembleRefinementSnapshot(
      input({
        epics: [epic({ id: "a", status: "backlog" })],
        stories: [
          {
            id: "s2",
            epicId: "a",
            title: "Second",
            acceptanceCriteria: "  ",
            position: 1,
          },
          {
            id: "s1",
            epicId: "a",
            title: "First",
            acceptanceCriteria: "Given X, then Y",
            position: 0,
          },
        ],
      })
    );

    expect(snapshot.backlog[0].stories.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(snapshot.backlog[0].stories[0].hasAcceptanceCriteria).toBe(true);
    expect(snapshot.backlog[0].stories[1].hasAcceptanceCriteria).toBe(false);
    expect(snapshot.backlog[0].stories[1].acceptanceCriteria).toBeNull();
  });

  it("falls back to the raw id when a ticket has no readable id", () => {
    const snapshot = assembleRefinementSnapshot(
      input({ epics: [epic({ id: "a", readableId: null })] })
    );
    expect(snapshot.backlog[0].label).toBe("a");
  });
});
