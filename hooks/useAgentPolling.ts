"use client";

import { useState, useEffect, useCallback } from "react";

interface ActiveSession {
  id: string;
  epicId: string | null;
  status: string;
  mode: string;
  provider: string | null;
  startedAt: string | null;
  lastNonEmptyText?: string | null;
}

export function useAgentPolling(projectId: string, intervalMs = 3000) {
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/sessions/active`);
      const data = await res.json();
      setActiveSessions(data.data || []);
    } catch {
      // ignore
    }
  }, [projectId]);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, intervalMs);
    return () => clearInterval(interval);
  }, [poll, intervalMs]);

  return { activeSessions };
}
