import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";

/**
 * Checks if there's an active (pending/running) session for the given entity.
 * Returns the conflicting session if found.
 */
export function checkSessionLock(params: {
  epicId?: string;
  userStoryId?: string;
}): { locked: boolean; sessionId?: string; label?: string } {
  const { epicId, userStoryId } = params;

  if (userStoryId) {
    const active = db
      .select({
        id: agentSessions.id,
        mode: agentSessions.mode,
        status: agentSessions.status,
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.userStoryId, userStoryId),
          inArray(agentSessions.status, ["pending", "running"])
        )
      )
      .all();

    if (active.length > 0) {
      return {
        locked: true,
        sessionId: active[0].id,
        label: `Active ${active[0].mode} session on this story`,
      };
    }
  }

  if (epicId) {
    const active = db
      .select({
        id: agentSessions.id,
        mode: agentSessions.mode,
        status: agentSessions.status,
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.epicId, epicId),
          inArray(agentSessions.status, ["pending", "running"])
        )
      )
      .all();

    if (active.length > 0) {
      return {
        locked: true,
        sessionId: active[0].id,
        label: `Active ${active[0].mode} session on this epic`,
      };
    }
  }

  return { locked: false };
}
