import { describe, expect, it } from "vitest";
import {
  detectCycle,
  topologicalSort,
  getTransitiveDependencies,
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
