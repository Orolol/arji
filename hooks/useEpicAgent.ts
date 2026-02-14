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

export function useEpicAgent(projectId: string, epicId: string | null) {
  const [activeSessions, setActiveSessions] = useState<AgentSession[]>([]);
  const [dispatching, setDispatching] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollSessions = useCallback(async () => {
    if (!epicId) {
      setActiveSessions([]);
      return;
    }

    try {
      const res = await fetch(`/api/projects/${projectId}/sessions/active`);
      const data = await res.json();
      const sessions = ((data.data || []) as AgentSession[]).filter(
        (session) => session.status === "running" && session.epicId === epicId
      );
      setActiveSessions(sessions);
    } catch {
      // ignore
    }
  }, [projectId, epicId]);

  useEffect(() => {
    void pollSessions();
    pollRef.current = setInterval(pollSessions, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollSessions]);

  const requestJson = useCallback(
    async (url: string, body?: Record<string, unknown>) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
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
      if (!epicId) return;
      setDispatching(true);
      try {
        const body: Record<string, unknown> = { comment, namedAgentId };
        if (resumeSessionId) body.resumeSessionId = resumeSessionId;
        const data = await requestJson(
          `/api/projects/${projectId}/epics/${epicId}/build`,
          body
        );
        await pollSessions();
        return data;
      } finally {
        setDispatching(false);
      }
    },
    [projectId, epicId, requestJson, pollSessions]
  );

  const sendToReview = useCallback(
    async (reviewTypes: string[], namedAgentId?: string | null, resumeSessionId?: string) => {
      if (!epicId) return;
      setDispatching(true);
      try {
        const body: Record<string, unknown> = { reviewTypes, namedAgentId };
        if (resumeSessionId) body.resumeSessionId = resumeSessionId;
        const data = await requestJson(
          `/api/projects/${projectId}/epics/${epicId}/review`,
          body
        );
        await pollSessions();
        return data;
      } finally {
        setDispatching(false);
      }
    },
    [projectId, epicId, requestJson, pollSessions]
  );

  const resolveMerge = useCallback(async (namedAgentId?: string | null, resumeSessionId?: string) => {
    if (!epicId) return;
    setDispatching(true);
    try {
      const body: Record<string, unknown> = {};
      if (namedAgentId) body.namedAgentId = namedAgentId;
      if (resumeSessionId) body.resumeSessionId = resumeSessionId;
      const data = await requestJson(
        `/api/projects/${projectId}/epics/${epicId}/resolve-merge`,
        body
      );
      await pollSessions();
      return data;
    } finally {
      setDispatching(false);
    }
  }, [projectId, epicId, requestJson, pollSessions]);

  const approve = useCallback(async () => {
    if (!epicId) return;
    const res = await fetch(`/api/projects/${projectId}/epics/${epicId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw toAgentRequestError(data);
    }
    return data.data;
  }, [projectId, epicId]);

  const isRunning = activeSessions.some((s) => s.status === "running");
  const activeSession = activeSessions[0] ?? null;

  return {
    activeSessions,
    activeSession,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    resolveMerge,
    approve,
    refreshSessions: pollSessions,
  };
}
