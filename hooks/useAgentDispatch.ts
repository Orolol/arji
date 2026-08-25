"use client";

import { useState, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";
import { toAgentRequestError } from "@/lib/agents/client-error";
import type { AgentSession } from "@/lib/types/agent-session";

export type AgentDispatchTarget =
  | { kind: "epic"; epicId: string | null }
  | { kind: "story"; storyId: string; epicId?: string | null };

/**
 * Polls active agent sessions for an epic or story and exposes the
 * dispatch actions (build / review / approve, plus resolve-merge for
 * epic targets only).
 */
export function useAgentDispatch(projectId: string, target: AgentDispatchTarget) {
  const kind = target.kind;
  const epicId = target.epicId ?? null;
  const storyId = kind === "story" ? target.storyId : null;

  // Base API path for the target entity. Null when an epic target has no
  // epic selected yet — every action is a no-op in that case.
  const targetPath =
    kind === "epic"
      ? epicId
        ? `/api/projects/${projectId}/epics/${epicId}`
        : null
      : `/api/projects/${projectId}/stories/${storyId}`;

  const [activeSessions, setActiveSessions] = useState<AgentSession[]>([]);
  const [dispatching, setDispatching] = useState(false);

  const pollSessions = useCallback(async () => {
    if (kind === "epic" && !epicId) {
      setActiveSessions([]);
      return;
    }

    try {
      const res = await fetch(`/api/projects/${projectId}/sessions/active`);
      const data = await res.json();
      const sessions = ((data.data || []) as AgentSession[]).filter((session) => {
        if (session.status !== "running") return false;
        if (kind === "epic") return session.epicId === epicId;
        if (session.userStoryId === storyId) return true;
        if (epicId && session.epicId === epicId) return true;
        return false;
      });
      setActiveSessions(sessions);
    } catch {
      // ignore
    }
  }, [projectId, kind, epicId, storyId]);

  usePolling(pollSessions, 3000);

  const requestJson = useCallback(
    async (url: string, body: Record<string, unknown>) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw toAgentRequestError(data);
      }
      return data.data;
    },
    []
  );

  const sendToDev = useCallback(
    async (
      comment?: string,
      namedAgentId?: string | null,
      resumeSessionId?: string,
      pipeline?: boolean
    ) => {
      if (!targetPath) return;
      setDispatching(true);
      try {
        const body: Record<string, unknown> = { comment, namedAgentId };
        if (resumeSessionId) body.resumeSessionId = resumeSessionId;
        // Only sent when the caller made an explicit choice — omitting the
        // field lets the server fall back to the pipeline_enabled setting.
        if (typeof pipeline === "boolean") body.pipeline = pipeline;
        const data = await requestJson(`${targetPath}/build`, body);
        await pollSessions();
        return data;
      } finally {
        setDispatching(false);
      }
    },
    [targetPath, requestJson, pollSessions]
  );

  const sendToReview = useCallback(
    async (reviewTypes: string[], namedAgentId?: string | null, resumeSessionId?: string) => {
      if (!targetPath) return;
      setDispatching(true);
      try {
        const body: Record<string, unknown> = { reviewTypes, namedAgentId };
        if (resumeSessionId) body.resumeSessionId = resumeSessionId;
        const data = await requestJson(`${targetPath}/review`, body);
        await pollSessions();
        return data;
      } finally {
        setDispatching(false);
      }
    },
    [targetPath, requestJson, pollSessions]
  );

  /** Epic targets only: grading is observational and never changes status. */
  const sendToGrading = useCallback(
    async (namedAgentId?: string | null) => {
      if (kind !== "epic" || !targetPath) return;
      setDispatching(true);
      try {
        const data = await requestJson(`${targetPath}/grading`, {
          namedAgentId,
        });
        await pollSessions();
        return data;
      } finally {
        setDispatching(false);
      }
    },
    [kind, targetPath, requestJson, pollSessions],
  );

  /** Epic targets only — no-op for story targets. */
  const resolveMerge = useCallback(
    async (namedAgentId?: string | null, resumeSessionId?: string) => {
      if (kind !== "epic" || !targetPath) return;
      setDispatching(true);
      try {
        const body: Record<string, unknown> = {};
        if (namedAgentId) body.namedAgentId = namedAgentId;
        if (resumeSessionId) body.resumeSessionId = resumeSessionId;
        const data = await requestJson(`${targetPath}/resolve-merge`, body);
        await pollSessions();
        return data;
      } finally {
        setDispatching(false);
      }
    },
    [kind, targetPath, requestJson, pollSessions]
  );

  const approve = useCallback(async () => {
    if (!targetPath) return;
    const res = await fetch(`${targetPath}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw toAgentRequestError(data);
    }
    return data.data;
  }, [targetPath]);

  const isRunning = activeSessions.some((s) => s.status === "running");
  const activeSession = activeSessions[0] ?? null;

  return {
    activeSessions,
    activeSession,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    sendToGrading,
    resolveMerge,
    approve,
    refreshSessions: pollSessions,
  };
}
