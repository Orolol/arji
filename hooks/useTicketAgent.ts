"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { toAgentRequestError } from "@/lib/agents/client-error";

interface AgentSession {
  id: string;
  epicId: string | null;
  userStoryId: string | null;
  status: string;
  mode: string;
  provider: string | null;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export function useTicketAgent(
  projectId: string,
  storyId: string,
  epicId?: string | null
) {
  const [activeSessions, setActiveSessions] = useState<AgentSession[]>([]);
  const [dispatching, setDispatching] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/sessions/active`);
      const data = await res.json();
      const sessions = ((data.data || []) as AgentSession[]).filter((session) => {
        if (session.status !== "running") return false;
        if (session.userStoryId === storyId) return true;
        if (epicId && session.epicId === epicId) return true;
        return false;
      });
      setActiveSessions(sessions);
    } catch {
      // ignore
    }
  }, [projectId, storyId, epicId]);

  useEffect(() => {
    void pollSessions();
    pollRef.current = setInterval(pollSessions, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollSessions]);

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
    async (comment?: string, namedAgentId?: string | null, resumeSessionId?: string) => {
      setDispatching(true);
      try {
        const body: Record<string, unknown> = { comment, namedAgentId };
        if (resumeSessionId) body.resumeSessionId = resumeSessionId;
        const data = await requestJson(
          `/api/projects/${projectId}/stories/${storyId}/build`,
          body
        );
        await pollSessions();
        return data;
      } finally {
        setDispatching(false);
      }
    },
    [projectId, storyId, requestJson, pollSessions]
  );

  const sendToReview = useCallback(
    async (reviewTypes: string[], namedAgentId?: string | null, resumeSessionId?: string) => {
      setDispatching(true);
      try {
        const body: Record<string, unknown> = { reviewTypes, namedAgentId };
        if (resumeSessionId) body.resumeSessionId = resumeSessionId;
        const data = await requestJson(
          `/api/projects/${projectId}/stories/${storyId}/review`,
          body
        );
        await pollSessions();
        return data;
      } finally {
        setDispatching(false);
      }
    },
    [projectId, storyId, requestJson, pollSessions]
  );

  const approve = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/stories/${storyId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw toAgentRequestError(data);
    }
    return data.data;
  }, [projectId, storyId]);

  const isRunning = activeSessions.some((s) => s.status === "running");
  const activeSession = activeSessions[0] ?? null;

  return {
    activeSessions,
    activeSession,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    approve,
    refreshSessions: pollSessions,
  };
}
