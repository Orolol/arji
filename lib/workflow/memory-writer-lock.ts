/**
 * Mutual exclusion between the two agents that rewrite the project memory.
 *
 * `memory_distill` (one session's learnings) and `dreaming` (a cross-session
 * pass) both replace the memory document WHOLE. They are dispatched by
 * unrelated triggers — a completed build auto-distills while a finished night
 * run dreams — and the per-project scheduler runs sessions concurrently, so
 * without a shared guard the two can overlap and the slower one silently
 * overwrites the faster one's work.
 *
 * One predicate, used by every dispatch path of BOTH writers, is the whole
 * fix: whoever gets there first holds the document until its session reaches a
 * terminal state. Kept in its own module so neither workflow has to import the
 * other (they would form a cycle).
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { MEMORY_WRITER_AGENT_TYPES } from "./dreaming-constants";

/**
 * The memory writer currently holding the document for the project, or null
 * when neither writer is in progress.
 *
 * Unlike `hasPendingMemoryWriter`, returns the session itself so callers can
 * LINK to the busy writer — the Spec & Memory panel's "view session"
 * affordance and the 409 body of the memory routes both point at the
 * queued/running rewrite's session page so the user can follow it.
 */
export interface PendingMemoryWriter {
  sessionId: string;
  agentType: string;
}

export function getPendingMemoryWriter(
  projectId: string
): PendingMemoryWriter | null {
  const row = db
    .select({ id: agentSessions.id, agentType: agentSessions.agentType })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        inArray(agentSessions.agentType, [...MEMORY_WRITER_AGENT_TYPES]),
        inArray(agentSessions.status, ["queued", "running"])
      )
    )
    .get();
  if (!row || !row.agentType) return null;
  return { sessionId: row.id, agentType: row.agentType };
}

/**
 * True when ANY memory writer ('memory_distill' or 'dreaming') is queued or
 * running for the project.
 *
 * Callers must re-check this synchronously immediately before inserting their
 * session row: an `await` between the check and the insert reopens the window
 * this guard exists to close.
 */
export function hasPendingMemoryWriter(projectId: string): boolean {
  return getPendingMemoryWriter(projectId) !== null;
}

/**
 * Message of the error a dispatch throws when it loses the race for the
 * document (the synchronous re-check found another writer already queued).
 * Exported so the manual route can answer 409 instead of 500 for what is a
 * conflict, not a fault.
 */
export const MEMORY_WRITER_BUSY_MESSAGE =
  "A memory rewrite is already in progress for this project.";

export function isMemoryWriterBusyError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === MEMORY_WRITER_BUSY_MESSAGE
  );
}
