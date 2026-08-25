"use client";

import { useState, useEffect, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";
import type { GradingReportData } from "@/lib/grading/report";
import type { SessionArtifactSummary } from "@/lib/agent-sessions/artifact-view";

interface UserStory {
  id: string;
  epicId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: string;
  position: number;
  createdAt: string;
}

interface EpicDetail {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  status: string;
  branchName: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prStatus: string | null;
  type: string;
  linkedEpicId: string | null;
  images: string | null;
  readableId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Sum of this epic's sessions' reported cost; null when never reported. */
  sessionsCostUsd?: number | null;
}

export function useEpicDetail(projectId: string, epicId: string | null) {
  const [epic, setEpic] = useState<EpicDetail | null>(null);
  const [userStories, setUserStories] = useState<UserStory[]>([]);
  const [gradingReport, setGradingReport] =
    useState<GradingReportData | null>(null);
  const [artifacts, setArtifacts] = useState<SessionArtifactSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);

  const fetchData = useCallback(async () => {
    if (!epicId) return;
    try {
      const [epicRes, usRes, gradingRes, artifactsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/epics`),
        fetch(`/api/projects/${projectId}/user-stories?epicId=${epicId}`),
        fetch(`/api/projects/${projectId}/epics/${epicId}/grading`),
        fetch(`/api/projects/${projectId}/epics/${epicId}/artifacts`),
      ]);

      const epicData = await epicRes.json();
      const usData = await usRes.json();
      const gradingData = await gradingRes.json();
      const artifactsData = await artifactsRes.json();

      const foundEpic = (epicData.data || []).find(
        (e: EpicDetail) => e.id === epicId
      );
      if (foundEpic) setEpic(foundEpic);
      setUserStories(usData.data || []);
      setGradingReport(gradingRes.ok ? gradingData.data ?? null : null);
      setArtifacts(
        artifactsRes.ok && Array.isArray(artifactsData.data)
          ? artifactsData.data
          : []
      );
    } catch {
      // silently fail on poll
    }
  }, [projectId, epicId]);

  // Initial load — shows loading spinner
  const loadData = useCallback(async () => {
    if (!epicId) return;
    setLoading(true);
    await fetchData();
    setLoading(false);
  }, [epicId, fetchData]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Silent background poll — only when polling is enabled. The initial load
  // above already fetched, so skip the immediate call.
  usePolling(fetchData, 5000, polling && !!epicId, { immediate: false });

  // refresh: silent one-shot fetch (no loading state)
  const refresh = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  const updateEpic = useCallback(
    async (updates: Partial<EpicDetail>): Promise<{ ok: boolean; error?: string }> => {
      if (!epicId) return { ok: false, error: "No ticket selected" };
      try {
        const res = await fetch(`/api/projects/${projectId}/epics/${epicId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          // The workflow engine rejects invalid transitions server-side;
          // surface its message instead of applying an optimistic state.
          return {
            ok: false,
            error: data.error || "The update was rejected",
          };
        }
        setEpic((prev) => (prev ? { ...prev, ...updates } : null));
        return { ok: true };
      } catch {
        return { ok: false, error: "Network error — the update was not applied" };
      }
    },
    [projectId, epicId]
  );

  const addUserStory = useCallback(
    async (title: string) => {
      if (!epicId) return;
      const res = await fetch(`/api/projects/${projectId}/user-stories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epicId, title }),
      });
      const data = await res.json();
      if (data.data) {
        setUserStories((prev) => [...prev, data.data]);
      }
    },
    [projectId, epicId]
  );

  const updateUserStory = useCallback(
    async (usId: string, updates: Partial<UserStory>) => {
      await fetch(`/api/projects/${projectId}/user-stories`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: usId, ...updates }),
      });
      setUserStories((prev) =>
        prev.map((us) => (us.id === usId ? { ...us, ...updates } : us))
      );
    },
    [projectId]
  );

  const deleteUserStory = useCallback(
    async (usId: string) => {
      const res = await fetch(`/api/projects/${projectId}/stories/${usId}`, {
        method: "DELETE",
      });
      if (!res.ok) return;
      setUserStories((prev) => prev.filter((us) => us.id !== usId));
    },
    [projectId]
  );

  return {
    epic,
    userStories,
    gradingReport,
    artifacts,
    loading,
    updateEpic,
    addUserStory,
    updateUserStory,
    deleteUserStory,
    refresh,
    setPolling,
  };
}
