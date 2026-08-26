import { db } from "@/lib/db";
import { ticketDependencies } from "@/lib/db/schema";
import { eq, and, or } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import {
  validateSameProject,
  validateDagIntegrity,
  type DependencyEdge,
} from "@/lib/dependencies/validation";
import { emitTicketDependenciesChanged } from "@/lib/events/emit";

function edgeKey(edge: { ticketId: string; dependsOnTicketId: string }) {
  return `${edge.ticketId}::${edge.dependsOnTicketId}`;
}

/**
 * Insert without emitting. Both public entry points below wrap this so a
 * `setTicketDependencies` call — which deletes and re-inserts — announces the
 * removed and the added endpoints together, in one pass, rather than emitting
 * twice for the added ones.
 */
function insertDependencies(
  projectId: string,
  edges: DependencyEdge[]
) {
  if (edges.length === 0) return [];

  // Filter out self-dependencies
  const validEdges = edges.filter(
    (e) => e.ticketId !== e.dependsOnTicketId
  );
  if (validEdges.length === 0) return [];

  // Validate all tickets belong to the same project
  validateSameProject(projectId, validEdges);

  // Validate DAG integrity (no cycles)
  validateDagIntegrity(projectId, validEdges);

  const dedupedEdges: DependencyEdge[] = [];
  const seenEdgeKeys = new Set<string>();
  for (const edge of validEdges) {
    const key = edgeKey(edge);
    if (seenEdgeKeys.has(key)) continue;
    seenEdgeKeys.add(key);
    dedupedEdges.push(edge);
  }
  if (dedupedEdges.length === 0) return [];

  const edgeFilters = dedupedEdges.map((edge) =>
    and(
      eq(ticketDependencies.ticketId, edge.ticketId),
      eq(ticketDependencies.dependsOnTicketId, edge.dependsOnTicketId)
    )
  );
  const existingEdges = db
    .select({
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
    })
    .from(ticketDependencies)
    .where(edgeFilters.length === 1 ? edgeFilters[0] : or(...edgeFilters))
    .all();
  const existingEdgeKeys = new Set(existingEdges.map((edge) => edgeKey(edge)));

  const edgesToInsert = dedupedEdges.filter(
    (edge) => !existingEdgeKeys.has(edgeKey(edge))
  );
  if (edgesToInsert.length === 0) return [];

  const now = new Date().toISOString();
  const created = edgesToInsert.map((edge) => ({
    id: createId(),
    ticketId: edge.ticketId,
    dependsOnTicketId: edge.dependsOnTicketId,
    projectId,
    scopeType: "project" as const,
    scopeId: projectId,
    createdAt: now,
  }));

  db.insert(ticketDependencies).values(created).run();

  return created;
}

/** Both endpoints of every edge — everyone whose board state just changed. */
function affectedTicketIds(
  edges: readonly { ticketId: string; dependsOnTicketId: string }[]
): string[] {
  return edges.flatMap((edge) => [edge.ticketId, edge.dependsOnTicketId]);
}

/** One announcement per ticket, however many edges named it. */
function announceDependencyChange(projectId: string, ticketIds: string[]) {
  emitTicketDependenciesChanged(projectId, new Set(ticketIds));
}

/**
 * Insert one or more dependency edges with validation.
 * Validates: same-project constraint, no self-dependencies, DAG integrity.
 * Returns the created dependency records.
 */
export function createDependencies(
  projectId: string,
  edges: DependencyEdge[]
) {
  const created = insertDependencies(projectId, edges);
  if (created.length > 0) {
    announceDependencyChange(projectId, affectedTicketIds(created));
  }
  return created;
}

/**
 * Replace all dependencies for a ticket with a new set.
 * Validates DAG integrity for the new set.
 */
export function setTicketDependencies(
  projectId: string,
  ticketId: string,
  dependsOnIds: string[]
) {
  // Read the outgoing edges before dropping them: removing a dependency
  // changes the board for the ex-prerequisite too, and after the delete there
  // is nothing left to name it with.
  const previous = db
    .select({
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
    })
    .from(ticketDependencies)
    .where(eq(ticketDependencies.ticketId, ticketId))
    .all();

  // Remove all existing dependencies for this ticket
  db.delete(ticketDependencies)
    .where(eq(ticketDependencies.ticketId, ticketId))
    .run();

  const edges: DependencyEdge[] = dependsOnIds.map((depId) => ({
    ticketId,
    dependsOnTicketId: depId,
  }));
  const created = edges.length > 0 ? insertDependencies(projectId, edges) : [];

  const affected = [
    ticketId,
    ...affectedTicketIds(previous),
    ...affectedTicketIds(created),
  ];
  if (previous.length > 0 || created.length > 0) {
    announceDependencyChange(projectId, affected);
  }

  return created;
}

/**
 * Get all dependencies for a project, optionally filtered by ticket IDs.
 */
export function getProjectDependencies(projectId: string) {
  return db
    .select()
    .from(ticketDependencies)
    .where(eq(ticketDependencies.projectId, projectId))
    .all();
}
