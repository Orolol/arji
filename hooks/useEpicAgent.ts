"use client";

import { useState, useCallback, useRef, useEffect } from "react";

interface AgentSession {
  id: string;
  status: string;
  mode: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export function useEpicAgent(projectId: string, epicId: string | null) {
  const [activeSessions, setActiveSessions] = useState<AgentSession[]>([]);
  const [dispatching, setDispatching] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdsRef = useRef<Set<string>>(new Set());

  const pollSessions = useCallback(async () => {
    if (sessionIdsRef.current.size === 0) return;

    const updated: AgentSession[] = [];
    for (const sid of sessionIdsRef.current) {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/sessions/${sid}`
        );
        const data = await res.json();
        if (data.data) {
          updated.push(data.data);
          if (["completed", "failed", "cancelled"].includes(data.data.status)) {
            sessionIdsRef.current.delete(sid);
          }
        }
      } catch {
        // ignore
      }
    }
    setActiveSessions(updated);
  }, [projectId]);

  useEffect(() => {
    pollRef.current = setInterval(pollSessions, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollSessions]);

  const sendToDev = useCallback(
    async (comment?: string) => {
      if (!epicId) return;
      setDispatching(true);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/epics/${epicId}/build`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ comment }),
          }
        );
        const data = await res.json();
        if (data.error) {
          throw new Error(data.error);
        }
        if (data.data?.sessionId) {
          sessionIdsRef.current.add(data.data.sessionId);
        }
        return data.data;
      } finally {
        setDispatching(false);
      }
    },
    [projectId, epicId]
  );

  const sendToReview = useCallback(
    async (reviewTypes: string[]) => {
      if (!epicId) return;
      setDispatching(true);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/epics/${epicId}/review`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reviewTypes }),
          }
        );
        const data = await res.json();
        if (data.error) {
          throw new Error(data.error);
        }
        if (data.data?.sessions) {
          for (const sid of data.data.sessions) {
            sessionIdsRef.current.add(sid);
          }
        }
        return data.data;
      } finally {
        setDispatching(false);
      }
    },
    [projectId, epicId]
  );

  const approve = useCallback(async () => {
    if (!epicId) return;
    const res = await fetch(
      `/api/projects/${projectId}/epics/${epicId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }
    );
    const data = await res.json();
    if (data.error) {
      throw new Error(data.error);
    }
    return data.data;
  }, [projectId, epicId]);

  const isRunning = activeSessions.some((s) => s.status === "running");

  return {
    activeSessions,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    approve,
  };
}
