"use client";

import { useState, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";

/** One kanban transition from the ticket activity log (newest first from the API). */
export interface EpicActivityEntry {
  id: string;
  projectId: string;
  epicId: string;
  fromStatus: string;
  toStatus: string;
  actor: "user" | "agent" | "system";
  reason: string | null;
  sessionId: string | null;
  createdAt: string | null;
}

const EMPTY_ENTRIES: EpicActivityEntry[] = [];

/**
 * Loads and polls (5s) the transition activity log of an epic.
 *
 * Mirrors `useTicketComments`' shape. `enabled` gates the polling so callers
 * only poll while the Activity tab is actually visible; a null epicId
 * resolves to an empty, non-polling feed.
 */
export function useEpicActivity(
  projectId: string,
  epicId: string | null,
  enabled: boolean = true
) {
  const activityUrl = epicId
    ? `/api/projects/${projectId}/epics/${epicId}/activity`
    : null;

  const [loadedEntries, setEntries] = useState<EpicActivityEntry[]>([]);
  const [isLoading, setLoading] = useState(true);

  // A null epicId has an empty, settled feed. Deriving that beats the reset
  // effect it replaces: correct on the first render rather than one commit
  // later, and re-opening an epic still shows its cached feed.
  const entries = activityUrl ? loadedEntries : EMPTY_ENTRIES;
  const loading = activityUrl ? isLoading : false;

  const loadActivity = useCallback(async () => {
    if (!activityUrl) return;
    try {
      const res = await fetch(activityUrl);
      const data = await res.json();
      if (data.data) {
        setEntries(data.data);
      }
    } catch {
      // silently fail on poll
    }
    setLoading(false);
  }, [activityUrl]);

  // Initial load + 5s polling while visible
  usePolling(loadActivity, 5000, !!activityUrl && enabled);

  return { entries, loading, refresh: loadActivity };
}
