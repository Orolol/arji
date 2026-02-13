"use client";

import { useState, useEffect, useCallback, useRef } from "react";

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
}

export function useEpicDetail(projectId: string, epicId: string | null) {
  const [epic, setEpic] = useState<EpicDetail | null>(null);
  const [userStories, setUserStories] = useState<UserStory[]>([]);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    if (!epicId) return;
    try {
      const [epicRes, usRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/epics`),
        fetch(`/api/projects/${projectId}/user-stories?epicId=${epicId}`),
      ]);

      const epicData = await epicRes.json();
      const usData = await usRes.json();

      const foundEpic = (epicData.data || []).find(
        (e: EpicDetail) => e.id === epicId
      );
      if (foundEpic) setEpic(foundEpic);
      setUserStories(usData.data || []);
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

  // Silent background poll — only when polling is enabled
  useEffect(() => {
    if (!polling || !epicId) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(fetchData, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [polling, epicId, fetchData]);

  // refresh: silent one-shot fetch (no loading state)
  const refresh = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  const updateEpic = useCallback(
    async (updates: Partial<EpicDetail>) => {
      if (!epicId) return;
      await fetch(`/api/projects/${projectId}/epics/${epicId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      setEpic((prev) => (prev ? { ...prev, ...updates } : null));
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
      await fetch(`/api/projects/${projectId}/user-stories?id=${usId}`, {
        method: "DELETE",
      });
      setUserStories((prev) => prev.filter((us) => us.id !== usId));
    },
    [projectId]
  );

  return {
    epic,
    userStories,
    loading,
    updateEpic,
    addUserStory,
    updateUserStory,
    deleteUserStory,
    refresh,
    setPolling,
  };
}
