import { db } from "@/lib/db";
import { ticketDependencies } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import {
  validateSameProject,
  validateDagIntegrity,
  type DependencyEdge,
} from "@/lib/dependencies/validation";

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

  const now = new Date().toISOString();
  const created = [];

  for (const edge of validEdges) {
    // Skip if this edge already exists
    const existing = db
      .select({ id: ticketDependencies.id })
      .from(ticketDependencies)
      .where(
        and(
          eq(ticketDependencies.ticketId, edge.ticketId),
          eq(ticketDependencies.dependsOnTicketId, edge.dependsOnTicketId)
        )
      )
      .get();

    if (existing) continue;

    const id = createId();
    db.insert(ticketDependencies)
      .values({
        id,
        ticketId: edge.ticketId,
        dependsOnTicketId: edge.dependsOnTicketId,
        projectId,
        scopeType: "project",
        scopeId: projectId,
        createdAt: now,
      })
      .run();

    created.push({
      id,
      ticketId: edge.ticketId,
      dependsOnTicketId: edge.dependsOnTicketId,
      projectId,
      scopeType: "project",
      scopeId: projectId,
      createdAt: now,
    });
  }

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
