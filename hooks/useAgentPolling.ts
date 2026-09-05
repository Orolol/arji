"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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

/** Stable empties, so a project with nothing polled yet renders identically. */
const NO_ACTIVITIES: UnifiedActivity[] = [];
const NO_FAILURES: Record<string, FailedSessionInfo> = {};

interface PolledBoard {
  /** Project the two lists below describe — never assumed to be the current one. */
  projectId: string;
  activities: UnifiedActivity[];
  failedSessions: Record<string, FailedSessionInfo>;
}

export function useAgentPolling(projectId: string, intervalMs = 3000, refreshTrigger?: number) {
  // One tagged snapshot rather than two loose lists: what the poll answered,
  // and which project it answered for.
  const [polled, setPolled] = useState<PolledBoard>({
    projectId,
    activities: NO_ACTIVITIES,
    failedSessions: NO_FAILURES,
  });

  /**
   * One abort controller per project, aborted when the project changes.
   *
   * `fetchUnifiedSessions` follows the route's cursor to the end, so a poll
   * can still be paging the project the user just left — measured on the
   * Sessions page as four wasted requests after a switch, and this hook reads
   * the same list. Cancelling it is the concrete win.
   *
   * The write guard below it is defensive in the same way it is on that page:
   * the desk remounts when `[projectId]` changes, so a stale write lands
   * nowhere today. Under a plain re-render it would land as failure badges
   * for epics that are not even on the board being shown, because "latest
   * session wins" is a per-epic verdict over the whole list.
   */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, [projectId]);

  const poll = useCallback(async () => {
    // Read once: a later poll installs its own controller, and this run must
    // keep testing the signal it actually started under.
    const signal = abortRef.current?.signal;
    try {
      // "Latest session wins" is a per-epic verdict, so the badge needs the
      // whole list, not its first page — fetchUnifiedSessions follows the
      // route's cursor to the end.
      const [activeRes, sessions] = await Promise.all([
        fetch(`/api/projects/${projectId}/sessions/active`, { signal }),
        fetchUnifiedSessions<FailureCandidateSession>(projectId, { signal }),
      ]);
      const activeData = await activeRes.json();
      // Aborting cannot unwind a request that already succeeded, so the write
      // is guarded too, not only the fetches. An abandoned poll must not
      // replace the current project's board with the one the user left.
      if (signal?.aborted) return;
      const activities = (activeData.data || []) as UnifiedActivity[];

      // Build a set of epicIds that currently have a running agent
      const runningEpicIds = new Set<string>(
        activities.filter((a) => a.epicId).map((a) => a.epicId as string)
      );

      // "Latest session wins": the badge reflects only the most recent
      // session per epic, so a retry clears the failure immediately.
      setPolled({
        projectId,
        activities,
        failedSessions: selectLatestFailures(sessions, runningEpicIds),
      });
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

  // Read through the tag. That is what makes switching projects free of a
  // reset: a project the poll has not answered for yet reads empty, instead
  // of showing the previous project's live agents and failure badges under
  // the new project's URL until the first poll lands.
  const current = polled.projectId === projectId;
  return {
    activities: current ? polled.activities : NO_ACTIVITIES,
    failedSessions: current ? polled.failedSessions : NO_FAILURES,
    refresh: poll,
  };
}
