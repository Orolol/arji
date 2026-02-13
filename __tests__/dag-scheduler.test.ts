import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database and validation module
const mockGraph = new Map<string, Set<string>>();

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    all: vi.fn(() => []),
    get: vi.fn(() => null),
  },
}));

vi.mock("@/lib/dependencies/validation", () => ({
  topologicalSort: vi.fn((_projectId: string, ticketIds: string[]) => {
    // Compute topological layers from mockGraph
    const ticketSet = new Set(ticketIds);
    const inDegree = new Map<string, number>();
    const successors = new Map<string, Set<string>>();

    for (const id of ticketSet) {
      inDegree.set(id, 0);
      successors.set(id, new Set());
    }

    for (const id of ticketSet) {
      const deps = mockGraph.get(id);
      if (!deps) continue;
      for (const dep of deps) {
        if (ticketSet.has(dep)) {
          inDegree.set(id, (inDegree.get(id) || 0) + 1);
          if (!successors.has(dep)) successors.set(dep, new Set());
          successors.get(dep)!.add(id);
        }
      }
    }

    const layers: string[][] = [];
    let queue = Array.from(ticketSet).filter(
      (id) => (inDegree.get(id) || 0) === 0
    );

    while (queue.length > 0) {
      layers.push([...queue]);
      const nextQueue: string[] = [];
      for (const node of queue) {
        const succs = successors.get(node);
        if (!succs) continue;
        for (const succ of succs) {
          const newDeg = (inDegree.get(succ) || 1) - 1;
          inDegree.set(succ, newDeg);
          if (newDeg === 0) nextQueue.push(succ);
        }
      }
      queue = nextQueue;
    }

    return layers;
  }),
  loadProjectGraph: vi.fn(() => mockGraph),
}));

import {
  buildExecutionPlan,
  executeDagPlan,
  type LayerResult,
} from "@/lib/dependencies/scheduler";

describe("DAG Scheduler", () => {
  beforeEach(() => {
    mockGraph.clear();
  });

  describe("buildExecutionPlan", () => {
    it("returns a single layer for independent tickets", () => {
      const plan = buildExecutionPlan("proj1", ["a", "b", "c"]);
      expect(plan.layers).toHaveLength(1);
      expect(plan.layers[0]).toHaveLength(3);
      expect(plan.ticketStatus.size).toBe(3);
      for (const status of plan.ticketStatus.values()) {
        expect(status).toBe("pending");
      }
    });

    it("returns multiple layers for dependent tickets", () => {
      // b depends on a; c depends on b → three layers
      mockGraph.set("b", new Set(["a"]));
      mockGraph.set("c", new Set(["b"]));

      const plan = buildExecutionPlan("proj1", ["a", "b", "c"]);
      expect(plan.layers).toHaveLength(3);
      expect(plan.layers[0]).toEqual(["a"]);
      expect(plan.layers[1]).toEqual(["b"]);
      expect(plan.layers[2]).toEqual(["c"]);
    });

    it("groups independent branches in the same layer", () => {
      // b depends on a, c is independent, d depends on a
      mockGraph.set("b", new Set(["a"]));
      mockGraph.set("d", new Set(["a"]));

      const plan = buildExecutionPlan("proj1", ["a", "b", "c", "d"]);
      expect(plan.layers).toHaveLength(2);
      // First layer: a and c (no predecessors)
      expect(plan.layers[0].sort()).toEqual(["a", "c"]);
      // Second layer: b and d (both depend on a)
      expect(plan.layers[1].sort()).toEqual(["b", "d"]);
    });
  });

  describe("executeDagPlan", () => {
    it("executes all tickets in single layer concurrently", async () => {
      const plan = buildExecutionPlan("proj1", ["a", "b"]);
      const launchOrder: string[] = [];

      const launchFn = async (epicId: string): Promise<LayerResult> => {
        launchOrder.push(epicId);
        return { epicId, sessionId: `s-${epicId}`, success: true };
      };

      const result = await executeDagPlan("proj1", plan, launchFn);

      expect(launchOrder.sort()).toEqual(["a", "b"]);
      expect(result.get("a")).toBe("done");
      expect(result.get("b")).toBe("done");
    });

    it("respects layer ordering for dependent tickets", async () => {
      mockGraph.set("b", new Set(["a"]));
      const plan = buildExecutionPlan("proj1", ["a", "b"]);
      const launchOrder: string[] = [];

      const launchFn = async (epicId: string): Promise<LayerResult> => {
        launchOrder.push(epicId);
        return { epicId, sessionId: `s-${epicId}`, success: true };
      };

      const result = await executeDagPlan("proj1", plan, launchFn);

      // a must be launched before b
      expect(launchOrder).toEqual(["a", "b"]);
      expect(result.get("a")).toBe("done");
      expect(result.get("b")).toBe("done");
    });

    it("skips dependents when prerequisite fails", async () => {
      // c depends on b, b depends on a
      mockGraph.set("b", new Set(["a"]));
      mockGraph.set("c", new Set(["b"]));
      const plan = buildExecutionPlan("proj1", ["a", "b", "c"]);

      const launchFn = async (epicId: string): Promise<LayerResult> => {
        if (epicId === "a") {
          return { epicId, sessionId: "s-a", success: false, error: "build failed" };
        }
        return { epicId, sessionId: `s-${epicId}`, success: true };
      };

      const result = await executeDagPlan("proj1", plan, launchFn);

      expect(result.get("a")).toBe("failed");
      expect(result.get("b")).toBe("skipped");
      expect(result.get("c")).toBe("skipped");
    });

    it("continues independent branches when one fails", async () => {
      // b depends on a, c is independent
      mockGraph.set("b", new Set(["a"]));
      const plan = buildExecutionPlan("proj1", ["a", "b", "c"]);

      const launchFn = async (epicId: string): Promise<LayerResult> => {
        if (epicId === "a") {
          return { epicId, sessionId: "s-a", success: false, error: "build failed" };
        }
        return { epicId, sessionId: `s-${epicId}`, success: true };
      };

      const result = await executeDagPlan("proj1", plan, launchFn);

      expect(result.get("a")).toBe("failed");
      expect(result.get("b")).toBe("skipped"); // depends on a
      expect(result.get("c")).toBe("done"); // independent
    });

    it("invokes onStatusChange callback for each transition", async () => {
      const plan = buildExecutionPlan("proj1", ["a"]);
      const transitions: Array<{ epicId: string; status: string }> = [];

      const launchFn = async (epicId: string): Promise<LayerResult> => {
        return { epicId, sessionId: "s-a", success: true };
      };

      await executeDagPlan("proj1", plan, launchFn, (epicId, status) => {
        transitions.push({ epicId, status });
      });

      expect(transitions).toEqual([
        { epicId: "a", status: "running" },
        { epicId: "a", status: "done" },
      ]);
    });

    it("handles launch function throwing as failure", async () => {
      const plan = buildExecutionPlan("proj1", ["a"]);

      const launchFn = async (_epicId: string): Promise<LayerResult> => {
        throw new Error("spawn failed");
      };

      const result = await executeDagPlan("proj1", plan, launchFn);
      expect(result.get("a")).toBe("failed");
    });

    it("handles diamond dependency correctly", async () => {
      // d depends on b and c; b depends on a; c depends on a
      mockGraph.set("b", new Set(["a"]));
      mockGraph.set("c", new Set(["a"]));
      mockGraph.set("d", new Set(["b", "c"]));

      const plan = buildExecutionPlan("proj1", ["a", "b", "c", "d"]);
      const launchOrder: string[] = [];

      const launchFn = async (epicId: string): Promise<LayerResult> => {
        launchOrder.push(epicId);
        return { epicId, sessionId: `s-${epicId}`, success: true };
      };

      const result = await executeDagPlan("proj1", plan, launchFn);

      // a must come first, then b and c (concurrent), then d
      expect(launchOrder[0]).toBe("a");
      expect(launchOrder.slice(1, 3).sort()).toEqual(["b", "c"]);
      expect(launchOrder[3]).toBe("d");
      expect(result.get("d")).toBe("done");
    });
  });
});
