import { db } from "@/lib/db";
import { ticketDependencies, epics } from "@/lib/db/schema";
import { eq, and, or } from "drizzle-orm";
import { isBuildableStatus, isDeliveredStatus } from "@/lib/types/kanban";

export class CycleError extends Error {
  public readonly cycle: string[];
  constructor(cycle: string[]) {
    const chain = cycle.join(" → ");
    super(`Dependency cycle detected: ${chain}`);
    this.name = "CycleError";
    this.cycle = cycle;
  }
}

export class CrossProjectError extends Error {
  constructor(ticketId: string, dependsOnId: string) {
    super(
      `Cross-project dependency not allowed: ticket "${ticketId}" and "${dependsOnId}" belong to different projects`
    );
    this.name = "CrossProjectError";
  }
}

export interface DependencyEdge {
  ticketId: string;
  dependsOnTicketId: string;
}

/**
 * Build an adjacency list from existing dependency rows for a project.
 * Returns a map: ticketId → Set of ticketIds it depends on (predecessors).
 */
export function loadProjectGraph(projectId: string): Map<string, Set<string>> {
  const rows = db
    .select({
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
    })
    .from(ticketDependencies)
    .where(eq(ticketDependencies.projectId, projectId))
    .all();

  const graph = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!graph.has(row.ticketId)) {
      graph.set(row.ticketId, new Set());
    }
    graph.get(row.ticketId)!.add(row.dependsOnTicketId);
  }
  return graph;
}

/**
 * Detect a cycle in a directed graph using DFS.
 * Returns the cycle path if found, or null if no cycle exists.
 */
export function detectCycle(
  graph: Map<string, Set<string>>
): string[] | null {
  const WHITE = 0; // not visited
  const GRAY = 1; // in current path
  const BLACK = 2; // fully explored

  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  // Collect all nodes (both sides of edges)
  const allNodes = new Set<string>();
  for (const [node, deps] of graph) {
    allNodes.add(node);
    for (const dep of deps) {
      allNodes.add(dep);
    }
  }

  for (const node of allNodes) {
    color.set(node, WHITE);
  }

  for (const startNode of allNodes) {
    if (color.get(startNode) !== WHITE) continue;

    const stack: string[] = [startNode];
    parent.set(startNode, null);

    while (stack.length > 0) {
      const node = stack[stack.length - 1];

      if (color.get(node) === WHITE) {
        color.set(node, GRAY);
        const deps = graph.get(node) || new Set();
        for (const dep of deps) {
          if (color.get(dep) === GRAY) {
            // Found a cycle — reconstruct path
            const cycle: string[] = [dep, node];
            let cur = node;
            while (cur !== dep) {
              cur = parent.get(cur)!;
              if (cur === null) break;
              cycle.push(cur);
            }
            cycle.reverse();
            return cycle;
          }
          if (color.get(dep) === undefined || color.get(dep) === WHITE) {
            parent.set(dep, node);
            stack.push(dep);
          }
        }
      } else {
        stack.pop();
        color.set(node, BLACK);
      }
    }
  }

  return null;
}

/**
 * Validate that adding new edges would not create a cycle.
 * Throws CycleError if a cycle is found.
 */
export function validateDagIntegrity(
  projectId: string,
  newEdges: DependencyEdge[]
): void {
  const graph = loadProjectGraph(projectId);

  // Add new edges to the graph
  for (const edge of newEdges) {
    if (!graph.has(edge.ticketId)) {
      graph.set(edge.ticketId, new Set());
    }
    graph.get(edge.ticketId)!.add(edge.dependsOnTicketId);
  }

  const cycle = detectCycle(graph);
  if (cycle) {
    throw new CycleError(cycle);
  }
}

/**
 * Validate that all tickets in a set of edges belong to the same project.
 * Throws CrossProjectError if any cross-project edges are found.
 */
export function validateSameProject(
  projectId: string,
  edges: DependencyEdge[]
): void {
  const allTicketIds = new Set<string>();
  for (const edge of edges) {
    allTicketIds.add(edge.ticketId);
    allTicketIds.add(edge.dependsOnTicketId);
  }

  if (allTicketIds.size === 0) return;

  const ticketIds = Array.from(allTicketIds);
  // Query in batches to avoid overly long IN clauses
  for (const id of ticketIds) {
    const epic = db
      .select({ id: epics.id, projectId: epics.projectId })
      .from(epics)
      .where(eq(epics.id, id))
      .get();

    if (!epic) {
      throw new Error(`Ticket "${id}" not found`);
    }

    if (epic.projectId !== projectId) {
      // Find which edge referenced this cross-project ticket
      const edge = edges.find(
        (e) => e.ticketId === id || e.dependsOnTicketId === id
      );
      throw new CrossProjectError(
        edge?.ticketId || id,
        edge?.dependsOnTicketId || id
      );
    }
  }
}

/**
 * Get all dependencies (predecessors) for a specific ticket.
 */
export function getTicketDependencies(ticketId: string) {
  return db
    .select({
      id: ticketDependencies.id,
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
      projectId: ticketDependencies.projectId,
      scopeType: ticketDependencies.scopeType,
      scopeId: ticketDependencies.scopeId,
      createdAt: ticketDependencies.createdAt,
    })
    .from(ticketDependencies)
    .where(eq(ticketDependencies.ticketId, ticketId))
    .all();
}

/**
 * Get all dependents (successors) for a specific ticket —
 * tickets that depend ON this ticket.
 */
export function getTicketDependents(ticketId: string) {
  return db
    .select({
      id: ticketDependencies.id,
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
      projectId: ticketDependencies.projectId,
    })
    .from(ticketDependencies)
    .where(eq(ticketDependencies.dependsOnTicketId, ticketId))
    .all();
}

/**
 * Status lookup (ticketId -> status) for every epic of a project.
 * One query, so callers can classify a whole closure without N round-trips.
 */
function loadEpicStatuses(projectId: string): Map<string, string | null> {
  const rows = db
    .select({ id: epics.id, status: epics.status })
    .from(epics)
    .where(eq(epics.projectId, projectId))
    .all();

  return new Map(rows.map((row) => [row.id, row.status ?? null]));
}

/**
 * Keeps only the tickets a build agent may still be dispatched for
 * (BUILDABLE_STATUSES). Done/released tickets — and ids with no epic row —
 * are dropped: they are satisfied prerequisites, not work to schedule.
 * Input order is preserved.
 */
export function filterBuildableTickets(
  projectId: string,
  ticketIds: string[]
): string[] {
  if (ticketIds.length === 0) return [];
  const statuses = loadEpicStatuses(projectId);
  return ticketIds.filter((id) => isBuildableStatus(statuses.get(id)));
}

/**
 * Compute all transitive predecessors for a set of ticket IDs.
 * Returns a set of all ticket IDs that must be included.
 *
 * Traversal stops at satisfied prerequisites: a done/released dependency is
 * neither included nor expanded through, so a selection whose prerequisites
 * are already delivered auto-includes nothing. The seeds themselves are
 * always kept (an explicit selection stays selected — the batch build route
 * is what refuses to dispatch a non-buildable ticket).
 */
export function getTransitiveDependencies(
  projectId: string,
  ticketIds: string[]
): Set<string> {
  const graph = loadProjectGraph(projectId);
  const statuses = loadEpicStatuses(projectId);
  const result = new Set<string>();
  const queue = [...ticketIds];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (result.has(current)) continue;
    result.add(current);

    const deps = graph.get(current);
    if (deps) {
      for (const dep of deps) {
        if (result.has(dep)) continue;
        // Satisfied prerequisite: nothing to build here, and nothing behind
        // it needs building either (its own deps are transitively done).
        if (!isBuildableStatus(statuses.get(dep))) continue;
        queue.push(dep);
      }
    }
  }

  return result;
}

/**
 * Which of `ticketIds` have at least one direct or transitive prerequisite
 * that is not delivered (done/released)?
 *
 * Pure, pre-loaded twin of the batch route's guard: the graph and the status
 * map are passed in once, so a whole sweep is classified without N+1
 * round-trips.
 *
 * Unlike `getTransitiveDependencies`, the walk deliberately expands *through*
 * a delivered prerequisite instead of stopping at it. That function is
 * assembling a work set, so pruning behind a delivered ticket costs nothing.
 * This one is a gate, and A → B(`done`) → C(`in_progress`) is a reachable
 * shape: a prerequisite reopened after B shipped, or an edge added between
 * two tickets that already existed. Nothing in the schema forbids it, so the
 * gate does not assume it away — A stays blocked. A prerequisite missing from
 * `statusOf` is likewise treated as undelivered (conservative block, like the
 * DB twin's `?? null`).
 */
export function findTicketsBlockedByDependencies(
  graph: Map<string, Set<string>>,
  statusOf: Map<string, string | null>,
  ticketIds: Iterable<string>
): Set<string> {
  const blocked = new Set<string>();

  for (const ticketId of ticketIds) {
    const queue: string[] = [...(graph.get(ticketId) ?? [])];
    const visited = new Set<string>();
    let isBlocked = false;

    while (queue.length > 0) {
      const dep = queue.pop()!;
      if (visited.has(dep)) continue;
      visited.add(dep);

      if (!isDeliveredStatus(statusOf.get(dep))) {
        isBlocked = true;
        break;
      }

      const deps = graph.get(dep);
      if (deps) queue.push(...deps);
    }

    if (isBlocked) blocked.add(ticketId);
  }

  return blocked;
}

/**
 * Compute a topological ordering for the given tickets based on their
 * dependency graph. Returns tickets in execution order (dependencies first).
 * Returns layers (tiers) for parallel execution: tickets in the same layer
 * have no inter-dependencies and can run concurrently.
 */
export function topologicalSort(
  projectId: string,
  ticketIds: string[]
): string[][] {
  const graph = loadProjectGraph(projectId);
  const ticketSet = new Set(ticketIds);

  // Build in-degree map for only the relevant tickets
  const inDegree = new Map<string, number>();
  const successors = new Map<string, Set<string>>();

  for (const id of ticketSet) {
    inDegree.set(id, 0);
    successors.set(id, new Set());
  }

  for (const id of ticketSet) {
    const deps = graph.get(id);
    if (!deps) continue;
    for (const dep of deps) {
      if (ticketSet.has(dep)) {
        inDegree.set(id, (inDegree.get(id) || 0) + 1);
        if (!successors.has(dep)) {
          successors.set(dep, new Set());
        }
        successors.get(dep)!.add(id);
      }
    }
  }

  // Kahn's algorithm producing layers
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
        const newDegree = (inDegree.get(succ) || 1) - 1;
        inDegree.set(succ, newDegree);
        if (newDegree === 0) {
          nextQueue.push(succ);
        }
      }
    }

    queue = nextQueue;
  }

  return layers;
}
