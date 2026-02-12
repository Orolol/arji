"use client";

import { useState, useEffect, useCallback } from "react";

interface EpicContext {
  id: string;
  title: string;
  description: string | null;
  status: string;
  branchName: string | null;
  projectId: string;
}

interface StoryDetail {
  id: string;
  epicId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: string;
  position: number;
  createdAt: string;
  epic: EpicContext | null;
}

export function useStoryDetail(projectId: string, storyId: string) {
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${storyId}`
      );
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setStory(data.data);
      }
    } catch {
      setError("Failed to load story");
    }
    setLoading(false);
  }, [projectId, storyId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const updateStory = useCallback(
    async (updates: Partial<StoryDetail>) => {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${storyId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        }
      );
      const data = await res.json();
      if (data.data) {
        setStory((prev) =>
          prev ? { ...prev, ...data.data } : null
        );
      }
    },
    [projectId, storyId]
  );

  return { story, loading, error, updateStory, refresh: loadData };
}
