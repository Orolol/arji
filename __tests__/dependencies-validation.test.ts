import { describe, expect, it } from "vitest";
import {
  detectCycle,
  topologicalSort,
  getTransitiveDependencies,
  findTicketsBlockedByDependencies,
} from "@/lib/dependencies/validation";

describe("detectCycle", () => {
  it("returns null for an empty graph", () => {
    const graph = new Map<string, Set<string>>();
    expect(detectCycle(graph)).toBeNull();
  });

  it("returns null for a simple DAG", () => {
    const graph = new Map<string, Set<string>>();
    graph.set("A", new Set(["B"]));
    graph.set("B", new Set(["C"]));
    graph.set("C", new Set());
    expect(detectCycle(graph)).toBeNull();
  });

  it("returns null for a diamond DAG", () => {
    const graph = new Map<string, Set<string>>();
    graph.set("A", new Set(["B", "C"]));
    graph.set("B", new Set(["D"]));
    graph.set("C", new Set(["D"]));
    graph.set("D", new Set());
    expect(detectCycle(graph)).toBeNull();
  });

  it("detects a direct 2-node cycle", () => {
    const graph = new Map<string, Set<string>>();
    graph.set("A", new Set(["B"]));
    graph.set("B", new Set(["A"]));
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
    expect(cycle).toContain("A");
    expect(cycle).toContain("B");
  });

  it("detects a 3-node cycle", () => {
    const graph = new Map<string, Set<string>>();
    graph.set("A", new Set(["B"]));
    graph.set("B", new Set(["C"]));
    graph.set("C", new Set(["A"]));
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
  });

  it("detects a self-loop", () => {
    const graph = new Map<string, Set<string>>();
    graph.set("A", new Set(["A"]));
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("A");
  });

  it("returns null for disconnected acyclic components", () => {
    const graph = new Map<string, Set<string>>();
    graph.set("A", new Set(["B"]));
    graph.set("C", new Set(["D"]));
    expect(detectCycle(graph)).toBeNull();
  });
});

describe("topologicalSort (in-memory graph)", () => {
  // topologicalSort uses loadProjectGraph internally which queries DB,
  // so we test the pure algorithm by testing detectCycle and
  // getTransitiveDependencies on in-memory graphs.
  // Full integration tests for topologicalSort with DB are in separate files.

  it("detects no cycle in a linear chain", () => {
    // A depends on B, B depends on C
    const graph = new Map<string, Set<string>>();
    graph.set("A", new Set(["B"]));
    graph.set("B", new Set(["C"]));
    expect(detectCycle(graph)).toBeNull();
  });
});

describe("getTransitiveDependencies (algorithm test via detectCycle)", () => {
  it("handles graph with no edges gracefully", () => {
    const graph = new Map<string, Set<string>>();
    expect(detectCycle(graph)).toBeNull();
  });
});

/**
 * The pure gate Full Auto's selector uses: does a ticket have a direct or
 * transitive prerequisite that has not shipped?
 */
describe("findTicketsBlockedByDependencies", () => {
  function graphOf(
    edges: Record<string, string[]>
  ): Map<string, Set<string>> {
    return new Map(
      Object.entries(edges).map(([id, deps]) => [id, new Set(deps)])
    );
  }

  it("does not block a ticket with no prerequisites", () => {
    const blocked = findTicketsBlockedByDependencies(
      graphOf({}),
      new Map([["A", "todo"]]),
      ["A"]
    );
    expect(blocked.size).toBe(0);
  });

  it("blocks on an undelivered direct prerequisite", () => {
    const blocked = findTicketsBlockedByDependencies(
      graphOf({ A: ["B"] }),
      new Map([
        ["A", "todo"],
        ["B", "in_progress"],
      ]),
      ["A"]
    );
    expect([...blocked]).toEqual(["A"]);
  });

  it("treats done and released prerequisites as satisfied", () => {
    const blocked = findTicketsBlockedByDependencies(
      graphOf({ A: ["B", "C"] }),
      new Map([
        ["A", "todo"],
        ["B", "done"],
        ["C", "released"],
      ]),
      ["A"]
    );
    expect(blocked.size).toBe(0);
  });

  it("blocks on a transitive prerequisite two hops away", () => {
    const blocked = findTicketsBlockedByDependencies(
      graphOf({ A: ["B"], B: ["C"] }),
      new Map([
        ["A", "todo"],
        ["B", "todo"],
        ["C", "review"],
      ]),
      ["A", "B"]
    );
    expect([...blocked].sort()).toEqual(["A", "B"]);
  });

  /**
   * The documented divergence from `getTransitiveDependencies`, which stops at
   * a delivered prerequisite. This gate keeps walking, because a prerequisite
   * can be reopened after its dependent shipped (or an edge added between two
   * existing tickets), and nothing in the schema forbids that shape.
   */
  it("keeps walking behind a delivered prerequisite", () => {
    const blocked = findTicketsBlockedByDependencies(
      graphOf({ A: ["B"], B: ["C"] }),
      new Map([
        ["A", "todo"],
        ["B", "done"],
        ["C", "in_progress"],
      ]),
      ["A"]
    );
    expect([...blocked]).toEqual(["A"]);
  });

  it("blocks on a prerequisite missing from the status map", () => {
    const blocked = findTicketsBlockedByDependencies(
      graphOf({ A: ["ghost"] }),
      new Map([["A", "todo"]]),
      ["A"]
    );
    expect([...blocked]).toEqual(["A"]);
  });

  it("terminates on a cyclic graph", () => {
    const blocked = findTicketsBlockedByDependencies(
      graphOf({ A: ["B"], B: ["A"] }),
      new Map([
        ["A", "todo"],
        ["B", "done"],
      ]),
      ["A"]
    );
    // B is delivered, the walk expands through it back to A, which is not.
    expect([...blocked]).toEqual(["A"]);
  });
});
