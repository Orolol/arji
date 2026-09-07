"use client";

import { useTranslations } from "next-intl";

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
  const tErrors = useTranslations("ClientErrors");
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const storyUrl = `/api/projects/${projectId}/stories/${storyId}`;

  // Shared by the mount fetch and by `loadData`, so the effect only ever
  // updates state from a promise callback instead of synchronously.
  const applyStory = useCallback((data: { error?: string; data?: StoryDetail }) => {
    if (data.error) {
      setError(data.error);
    } else {
      setError(null);
      setStory(data.data ?? null);
    }
    setLoading(false);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(storyUrl);
      applyStory(await res.json());
    } catch {
      setError(tErrors("failedToLoadStory"));
      setLoading(false);
    }
  }, [storyUrl, applyStory, tErrors]);

  useEffect(() => {
    let cancelled = false;
    fetch(storyUrl)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) applyStory(data);
      })
      .catch(() => {
        if (cancelled) return;
        setError(tErrors("failedToLoadStory"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [storyUrl, applyStory, tErrors]);

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
