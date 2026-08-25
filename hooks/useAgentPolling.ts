"use client";

import { useState, useEffect, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";
import {
  selectLatestFailures,
  type FailedSessionInfo,
} from "@/lib/agent-sessions/latest-failure";

export interface UnifiedActivity {
  id: string;
  epicId?: string | null;
  userStoryId?: string | null;
  type:
    | "build"
    | "review"
    | "merge"
    | "chat"
    | "spec_generation"
    | "release"
    | "memory"
    | "grading";
  label: string;
  status: string;
  mode: string;
  provider: string;
  namedAgentName?: string | null;
  startedAt: string;
  source: "db" | "registry";
  cancellable: boolean;
  /** Newest lifecycle/output timestamp for durable DB sessions. */
  lastActivityAt?: string | null;
  /** Watchdog verdict: no output past the staleness threshold. */
  stale?: boolean;
}

export function useAgentPolling(projectId: string, intervalMs = 3000, refreshTrigger?: number) {
  const [activities, setActivities] = useState<UnifiedActivity[]>([]);
  const [failedSessions, setFailedSessions] = useState<Record<string, FailedSessionInfo>>({});

  const poll = useCallback(async () => {
    try {
      const [activeRes, allRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/sessions/active`),
        fetch(`/api/projects/${projectId}/sessions`),
      ]);
      const activeData = await activeRes.json();
      setActivities(activeData.data || []);

      const allData = await allRes.json();
      const sessions = allData.data || [];

      // Build a set of epicIds that currently have a running agent
      const runningEpicIds = new Set<string>(
        ((activeData.data || []) as UnifiedActivity[])
          .filter((a) => a.epicId)
          .map((a) => a.epicId as string)
      );

      // "Latest session wins": the badge reflects only the most recent
      // session per epic, so a retry clears the failure immediately.
      const failed = selectLatestFailures(sessions, runningEpicIds);
      setFailedSessions(failed);
    } catch {
      // ignore
    }
  }, [projectId]);

  usePolling(poll, intervalMs);

  // Immediate re-poll when SSE triggers a refresh
  useEffect(() => {
    if (!refreshTrigger) return;
    const timeout = window.setTimeout(() => void poll(), 0);
    return () => window.clearTimeout(timeout);
  }, [refreshTrigger, poll]);

  return { activities, failedSessions, refresh: poll };
}
