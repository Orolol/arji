import { describe, it, expect } from "vitest";
import {
  computeBlockedBy,
  computeQueueRanks,
  buildDependencyAdjacency,
  buildDependencyFocus,
  dependencyFocusRole,
  computeReadiness,
} from "@/lib/kanban/queue";
import type { KanbanEpic, TicketDependencyEdge } from "@/lib/types/kanban";

function makeEpic(overrides: Partial<KanbanEpic> & { id: string }): KanbanEpic {
  return {
    projectId: "proj-1",
    title: overrides.id,
    description: null,
    priority: 1,
    status: "todo",
    position: 0,
    branchName: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    confidence: null,
    evidence: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    type: "feature",
    linkedEpicId: null,
    images: null,
    readableId: null,
    releaseId: null,
    usCount: 1,
    usDone: 0,
    latestCommentId: null,
    latestCommentAuthor: null,
    latestCommentCreatedAt: null,
    ...overrides,
    // Unless a test says otherwise, every story carries a rubric — the
    // interesting cases override one or the other.
    usWithCriteriaCount:
      overrides.usWithCriteriaCount ?? overrides.usCount ?? 1,
  };
}

function edge(ticketId: string, dependsOnTicketId: string): TicketDependencyEdge {
  return { ticketId, dependsOnTicketId };
}

describe("computeBlockedBy", () => {
  it("lists only the undelivered targets of each epic", () => {
    const statusById = new Map([
      ["a", "in_progress"],
      ["b", "done"],
      ["c", "released"],
      ["d", "todo"],
    ]);
    const blocked = computeBlockedBy(
      [edge("x", "a"), edge("x", "b"), edge("x", "c"), edge("y", "d")],
      statusById
    );

    // b (done) and c (released) are satisfied targets and never block.
    expect(blocked.get("x")).toEqual(["a"]);
    expect(blocked.get("y")).toEqual(["d"]);
    expect(blocked.has("z")).toBe(false);
  });

  it("omits epics whose targets are all delivered", () => {
    const blocked = computeBlockedBy([edge("x", "b")], new Map([["b", "done"]]));
    expect(blocked.size).toBe(0);
  });

  it("treats unknown targets as not delivered", () => {
    const blocked = computeBlockedBy([edge("x", "ghost")], new Map());
    expect(blocked.get("x")).toEqual(["ghost"]);
  });

  it("returns an empty map for a dependency-free board", () => {
    const blocked = computeBlockedBy([], new Map([["a", "todo"]]));
    expect(blocked.size).toBe(0);
  });

  it("never blocks a dependent that is itself delivered", () => {
    // Full Auto ignores ticket_dependencies, so an epic can legitimately be
    // merged ahead of a prerequisite that is still open. Once delivered it
    // must stop advertising the block.
    const statusById = new Map([
      ["shipped", "done"],
      ["released", "released"],
      ["open", "todo"],
      ["late", "backlog"],
    ]);
    const blocked = computeBlockedBy(
      [edge("shipped", "late"), edge("released", "late"), edge("open", "late")],
      statusById
    );

    expect(blocked.has("shipped")).toBe(false);
    expect(blocked.has("released")).toBe(false);
    expect(blocked.get("open")).toEqual(["late"]);
  });
});

describe("computeQueueRanks", () => {
  it("numbers the surviving epics in list order, skipping excluded ones", () => {
    const a = makeEpic({ id: "a" });
    const b = makeEpic({ id: "b" });
    const c = makeEpic({ id: "c" });

    const ranks = computeQueueRanks([a, b, c], (epic) => epic.id === "b");

    expect(ranks.get("a")).toBe(1);
    expect(ranks.has("b")).toBe(false);
    // The skip leaves no gap: c is third in the column but second in the queue.
    expect(ranks.get("c")).toBe(2);
  });

  it("starts at 1 even when the head of the column is excluded", () => {
    const a = makeEpic({ id: "a" });
    const b = makeEpic({ id: "b" });

    const ranks = computeQueueRanks([a, b], (epic) => epic.id === "a");

    expect(ranks.get("b")).toBe(1);
    expect(ranks.has("a")).toBe(false);
  });

  it("returns an empty map for an empty column", () => {
    expect(computeQueueRanks([], () => false).size).toBe(0);
  });
});

describe("buildDependencyAdjacency", () => {
  it("builds predecessor and successor maps", () => {
    const adjacency = buildDependencyAdjacency([
      edge("x", "a"),
      edge("x", "b"),
      edge("y", "x"),
    ]);

    // x depends on a and b
    expect(adjacency.predecessors.get("x")).toEqual(["a", "b"]);
    // a is upstream of x; x is upstream of y
    expect(adjacency.successors.get("a")).toEqual(["x"]);
    expect(adjacency.successors.get("x")).toEqual(["y"]);
    // a never blocks anything it is not a target of
    expect(adjacency.predecessors.has("a")).toBe(false);
    expect(adjacency.successors.has("y")).toBe(false);
  });

  it("returns empty maps for no edges", () => {
    const adjacency = buildDependencyAdjacency([]);
    expect(adjacency.predecessors.size).toBe(0);
    expect(adjacency.successors.size).toBe(0);
  });
});

describe("buildDependencyFocus", () => {
  const adjacency = buildDependencyAdjacency([edge("x", "a"), edge("y", "x")]);
  const allRendered = new Set(["x", "a", "y", "lonely"]);

  it("returns the predecessor and successor sets of the hovered ticket", () => {
    const focus = buildDependencyFocus("x", adjacency, allRendered);

    expect(focus?.epicId).toBe("x");
    expect([...(focus?.predecessors ?? [])]).toEqual(["a"]);
    expect([...(focus?.successors ?? [])]).toEqual(["y"]);
  });

  it("returns null for a ticket with no edges at all", () => {
    // Otherwise hovering any card on a dependency-free board would dim every
    // other card while highlighting none.
    expect(buildDependencyFocus("lonely", adjacency, allRendered)).toBeNull();
    expect(
      buildDependencyFocus("x", buildDependencyAdjacency([]), allRendered)
    ).toBeNull();
  });

  it("keeps a focus that has only one of the two sets", () => {
    expect(buildDependencyFocus("a", adjacency, allRendered)).not.toBeNull();
    expect(buildDependencyFocus("y", adjacency, allRendered)).not.toBeNull();
  });

  it("ignores neighbours that are not rendered", () => {
    // x depends on a and is depended on by y. With neither on screen — a
    // Released prerequisite, a Done column collapsed by focus mode, a filtered
    // card — there is nothing to highlight, so there must be nothing to dim.
    expect(buildDependencyFocus("x", adjacency, new Set(["x"]))).toBeNull();

    // One visible neighbour is enough, and the invisible one is dropped.
    const focus = buildDependencyFocus("x", adjacency, new Set(["x", "y"]));
    expect([...(focus?.successors ?? [])]).toEqual(["y"]);
    expect([...(focus?.predecessors ?? [])]).toEqual([]);
  });

  it("returns null when the hovered ticket itself is not rendered", () => {
    // React synthesises no mouseleave on unmount, so a card filtered away or
    // moved by an SSE update would otherwise leave the dim latched.
    expect(
      buildDependencyFocus("x", adjacency, new Set(["a", "y"]))
    ).toBeNull();
  });
});

describe("dependencyFocusRole", () => {
  const focus = buildDependencyFocus(
    "x",
    buildDependencyAdjacency([edge("x", "a"), edge("y", "x")]),
    new Set(["x", "a", "y", "unrelated"])
  );

  it("classifies the hovered ticket, its neighbours and the rest", () => {
    expect(dependencyFocusRole("x", focus)).toBe("focused");
    expect(dependencyFocusRole("a", focus)).toBe("predecessor");
    expect(dependencyFocusRole("y", focus)).toBe("successor");
    expect(dependencyFocusRole("unrelated", focus)).toBe("dimmed");
  });

  it("assigns no role at all when no focus is active", () => {
    expect(dependencyFocusRole("x", null)).toBeUndefined();
  });
});

describe("computeReadiness", () => {
  it("scores all three criteria for a ready Backlog epic", () => {
    const ready = makeEpic({
      id: "a",
      status: "backlog",
      description: "A plan",
      usCount: 1,
    });
    expect(computeReadiness(ready)).toEqual({ met: 3, total: 3 });
  });

  it("counts a missing description against the score", () => {
    const noDescription = makeEpic({
      id: "b",
      status: "backlog",
      description: "   ",
      usCount: 1,
    });
    // No open question, no description, one story
    expect(computeReadiness(noDescription)).toEqual({ met: 2, total: 3 });
  });

  it("counts zero user stories against the score", () => {
    const noStories = makeEpic({
      id: "c",
      status: "backlog",
      description: "A plan",
      usCount: 0,
    });
    expect(computeReadiness(noStories)).toEqual({ met: 2, total: 3 });
  });

  it("counts stories with an empty rubric against the score", () => {
    // The criterion is "acceptance criteria present", not "stories present":
    // a story with an empty rubric is what makes grading a no-op.
    const noCriteria = makeEpic({
      id: "c2",
      status: "backlog",
      description: "A plan",
      usCount: 3,
      usWithCriteriaCount: 0,
    });
    expect(computeReadiness(noCriteria)).toEqual({ met: 2, total: 3 });
  });

  it("credits the criterion as soon as one story carries a rubric", () => {
    const someCriteria = makeEpic({
      id: "c3",
      status: "backlog",
      description: "A plan",
      usCount: 3,
      usWithCriteriaCount: 1,
    });
    expect(computeReadiness(someCriteria)).toEqual({ met: 3, total: 3 });
  });

  it("counts an open agent question against the score", () => {
    const asked = makeEpic({
      id: "d",
      status: "backlog",
      description: "A plan",
      usCount: 1,
      latestSessionOutcome: "asked_question",
      latestSessionEndedAt: "2026-08-01 00:00:00",
    });
    expect(computeReadiness(asked)).toEqual({ met: 2, total: 3 });
  });

  it("does not count a replied question as open", () => {
    const answered = makeEpic({
      id: "e",
      status: "backlog",
      description: "A plan",
      usCount: 1,
      latestSessionOutcome: "asked_question",
      latestSessionEndedAt: "2026-08-01 00:00:00",
      latestUserCommentCreatedAt: "2026-08-01 01:00:00",
    });
    expect(computeReadiness(answered)).toEqual({ met: 3, total: 3 });
  });

  it("scores a bare captured idea as 1 of 3", () => {
    const bare = makeEpic({
      id: "f",
      status: "backlog",
      usCount: 0,
    });
    // No open question counts; the missing description and stories do not.
    expect(computeReadiness(bare)).toEqual({ met: 1, total: 3 });
  });

  it("scores a bug out of 2 — it has no rubric to carry", () => {
    // A bug's creation flow is a direct form with no mandatory acceptance
    // criteria, so a third criterion would strand every bug card below its
    // total and advertise a requirement bugs do not have.
    const bug = makeEpic({
      id: "g",
      status: "backlog",
      type: "bug",
      description: "Steps to reproduce",
      usCount: 0,
    });
    expect(computeReadiness(bug)).toEqual({ met: 2, total: 2 });
  });

  it("still counts the two criteria a bug can miss", () => {
    const bareBug = makeEpic({ id: "h", status: "backlog", type: "bug" });
    expect(computeReadiness(bareBug)).toEqual({ met: 1, total: 2 });
  });
});
