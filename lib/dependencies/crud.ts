import { db } from "@/lib/db";
import { ticketDependencies } from "@/lib/db/schema";
import { eq, and, or } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import {
  validateSameProject,
  validateDagIntegrity,
  type DependencyEdge,
} from "@/lib/dependencies/validation";

function edgeKey(edge: { ticketId: string; dependsOnTicketId: string }) {
  return `${edge.ticketId}::${edge.dependsOnTicketId}`;
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

/**
 * Remove a specific dependency edge.
 */
export function removeDependency(dependencyId: string) {
  db.delete(ticketDependencies)
    .where(eq(ticketDependencies.id, dependencyId))
    .run();
}

/**
 * Remove a dependency by the edge pair (ticketId, dependsOnTicketId).
 */
export function removeDependencyEdge(
  ticketId: string,
  dependsOnTicketId: string
) {
  db.delete(ticketDependencies)
    .where(
      and(
        eq(ticketDependencies.ticketId, ticketId),
        eq(ticketDependencies.dependsOnTicketId, dependsOnTicketId)
      )
    )
    .run();
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
  // Remove all existing dependencies for this ticket
  db.delete(ticketDependencies)
    .where(eq(ticketDependencies.ticketId, ticketId))
    .run();

  if (dependsOnIds.length === 0) return [];

  const edges: DependencyEdge[] = dependsOnIds.map((depId) => ({
    ticketId,
    dependsOnTicketId: depId,
  }));

  return createDependencies(projectId, edges);
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
