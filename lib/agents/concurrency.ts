import Database from "better-sqlite3";
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";

export {
  AGENT_ALREADY_RUNNING_CODE,
  isAgentAlreadyRunningPayload,
} from "@/lib/agents/concurrency-shared";
export type {
  ActiveAgentSessionSummary,
  AgentAlreadyRunningPayload,
} from "@/lib/agents/concurrency-shared";

import type { ActiveAgentSessionSummary, AgentAlreadyRunningPayload } from "@/lib/agents/concurrency-shared";
import { AGENT_ALREADY_RUNNING_CODE } from "@/lib/agents/concurrency-shared";

export type AgentTaskTarget =
  | {
      scope: "epic";
      projectId: string;
      epicId: string;
    }
  | {
      scope: "story";
      projectId: string;
      storyId: string;
      epicId?: string | null;
    };

function findRunningSessionForTarget(
  target: AgentTaskTarget
): ActiveAgentSessionSummary | null {
  const baseConditions = [
    eq(agentSessions.projectId, target.projectId),
    eq(agentSessions.status, "running"),
  ];

  if (target.scope === "epic") {
    const rows = db
      .select({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        epicId: agentSessions.epicId,
        userStoryId: agentSessions.userStoryId,
        mode: agentSessions.mode,
        provider: agentSessions.provider,
        startedAt: agentSessions.startedAt,
      })
      .from(agentSessions)
      .where(and(...baseConditions, eq(agentSessions.epicId, target.epicId)))
      .orderBy(desc(agentSessions.createdAt))
      .all();

    return rows[0] ?? null;
  }

  const storyCondition = target.epicId
    ? or(
        eq(agentSessions.userStoryId, target.storyId),
        eq(agentSessions.epicId, target.epicId)
      )
    : eq(agentSessions.userStoryId, target.storyId);

  const rows = db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      epicId: agentSessions.epicId,
      userStoryId: agentSessions.userStoryId,
      mode: agentSessions.mode,
      provider: agentSessions.provider,
      startedAt: agentSessions.startedAt,
    })
    .from(agentSessions)
    .where(and(...baseConditions, storyCondition))
    .orderBy(desc(agentSessions.createdAt))
    .all();

  return rows[0] ?? null;
}

export function getRunningSessionForTarget(
  target: AgentTaskTarget
): ActiveAgentSessionSummary | null {
  return findRunningSessionForTarget(target);
}

export function createAgentAlreadyRunningPayload(
  target: AgentTaskTarget,
  activeSession: ActiveAgentSessionSummary,
  errorMessage = "Another agent is already running for this task."
): AgentAlreadyRunningPayload {
  const targetData =
    target.scope === "epic"
      ? {
          scope: "epic" as const,
          projectId: target.projectId,
          epicId: target.epicId,
        }
      : {
          scope: "story" as const,
          projectId: target.projectId,
          storyId: target.storyId,
          ...(target.epicId ? { epicId: target.epicId } : {}),
        };

  return {
    error: errorMessage,
    code: AGENT_ALREADY_RUNNING_CODE,
    data: {
      activeSessionId: activeSession.id,
      activeSession,
      sessionUrl: `/projects/${target.projectId}/sessions/${activeSession.id}`,
      target: targetData,
    },
  };
}

export function insertRunningSessionWithGuard(
  target: AgentTaskTarget,
  session: typeof agentSessions.$inferInsert
):
  | { inserted: true }
  | {
      inserted: false;
      conflict: ActiveAgentSessionSummary;
    } {
  const sqlite = (db as unknown as { $client?: Database.Database }).$client;

  if (!sqlite) {
    const conflict = findRunningSessionForTarget(target);
    if (conflict) {
      return {
        inserted: false as const,
        conflict,
      };
    }
    db.insert(agentSessions).values(session).run();
    return {
      inserted: true as const,
    };
  }

  const transaction = sqlite.transaction(() => {
    const conflict = findRunningSessionForTarget(target);
    if (conflict) {
      return {
        inserted: false as const,
        conflict,
      };
    }

    db.insert(agentSessions).values(session).run();
    return {
      inserted: true as const,
    };
  });

  return transaction();
}
