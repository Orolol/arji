"use client";

import { useState, useEffect, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";
import {
  selectLatestFailures,
  type FailedSessionInfo,
  type FailureCandidateSession,
} from "@/lib/agent-sessions/latest-failure";
import { fetchUnifiedSessions } from "@/lib/agent-sessions/session-list";

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
    | "qa"
    | "grading"
    | "refinement";
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
      // "Latest session wins" is a per-epic verdict, so the badge needs the
      // whole list, not its first page — fetchUnifiedSessions follows the
      // route's cursor to the end.
      const [activeRes, sessions] = await Promise.all([
        fetch(`/api/projects/${projectId}/sessions/active`),
        fetchUnifiedSessions<FailureCandidateSession>(projectId),
      ]);
      const activeData = await activeRes.json();
      setActivities(activeData.data || []);

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
