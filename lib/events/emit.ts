/**
 * Convenience helpers for emitting events from API routes.
 */

import { eventBus, type TicketEventType } from "./bus";
import { createNotificationFromSession } from "@/lib/notifications/create";

function emit(
  type: TicketEventType,
  projectId: string,
  epicId: string | undefined,
  data: Record<string, unknown>
) {
  eventBus.emit({
    type,
    projectId,
    epicId,
    data,
    timestamp: new Date().toISOString(),
  });
}

export function emitTicketMoved(
  projectId: string,
  epicId: string,
  fromStatus: string,
  toStatus: string
) {
  emit("ticket:moved", projectId, epicId, { fromStatus, toStatus });
}

export function emitTicketCreated(
  projectId: string,
  epicId: string,
  title: string
) {
  emit("ticket:created", projectId, epicId, { title });
}

export function emitTicketUpdated(
  projectId: string,
  epicId: string,
  fields: Record<string, unknown>
) {
  emit("ticket:updated", projectId, epicId, { fields });
}

export function emitTicketDeleted(projectId: string, epicId: string) {
  emit("ticket:deleted", projectId, epicId, {});
}

/**
 * A dependency edge was added or removed. Emitted for BOTH endpoints of every
 * affected edge: the board derives blocked state, queue ranking and hover
 * adjacency from the edge list, so a change is visible on the dependent and on
 * its prerequisite alike. Without this the board's dependency data has no
 * invalidation path at all — it is only refetched by the whole-board reload
 * that ticket/session events drive.
 */
export function emitTicketDependenciesChanged(
  projectId: string,
  ticketIds: Iterable<string>
) {
  for (const ticketId of new Set(ticketIds)) {
    emit("ticket:updated", projectId, ticketId, { fields: ["dependencies"] });
  }
}

export function emitSessionStarted(
  projectId: string,
  epicId: string,
  sessionId: string,
  agentType: string
) {
  emit("session:started", projectId, epicId, { sessionId, agentType });
}

export function emitSessionCompleted(
  projectId: string,
  epicId: string,
  sessionId: string
) {
  emit("session:completed", projectId, epicId, { sessionId });
  try {
    createNotificationFromSession(sessionId);
  } catch {
    // Non-critical — don't break session flow if notification fails
  }
}

export function emitSessionFailed(
  projectId: string,
  epicId: string,
  sessionId: string,
  error: string
) {
  emit("session:failed", projectId, epicId, { sessionId, error });
  try {
    createNotificationFromSession(sessionId);
  } catch {
    // Non-critical — don't break session flow if notification fails
  }
}

export function emitSessionArtifactCreated(
  projectId: string,
  epicId: string,
  sessionId: string,
  artifactId: string
) {
  emit("artifact:created", projectId, epicId, { sessionId, artifactId });
}

export function emitReleaseCreated(
  projectId: string,
  releaseId: string,
  version: string,
  epicIds: string[]
) {
  emit("release:created", projectId, undefined, { releaseId, version, epicIds });
}
