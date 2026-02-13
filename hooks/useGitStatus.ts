"use client";

import { useState, useCallback, useEffect } from "react";

interface GitStatus {
  ahead: number;
  behind: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  push: () => Promise<void>;
  pushing: boolean;
}

/**
 * Fetches ahead/behind status for a branch relative to its remote tracking branch.
 * Only active when GitHub is configured and a branch name is provided.
 */
export function useGitStatus(
  projectId: string,
  branchName: string | null,
  githubConfigured: boolean
): GitStatus {
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!branchName || !githubConfigured) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${projectId}/git/status?branch=${encodeURIComponent(branchName)}`
      );

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Failed to fetch status");
        return;
      }

      setAhead(data.data?.ahead ?? 0);
      setBehind(data.data?.behind ?? 0);
    } catch {
      setError("Failed to fetch git status");
    } finally {
      setLoading(false);
    }
  }, [projectId, branchName, githubConfigured]);

  const push = useCallback(async () => {
    if (!branchName || !githubConfigured) return;

    setPushing(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/git/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: branchName }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Push failed");
        return;
      }

      // Refresh status after push
      await refresh();
    } catch {
      setError("Push failed");
    } finally {
      setPushing(false);
    }
  }, [projectId, branchName, githubConfigured, refresh]);

  // Auto-fetch on mount when conditions are met
  useEffect(() => {
    if (branchName && githubConfigured) {
      refresh();
    }
  }, [branchName, githubConfigured, refresh]);

  return { ahead, behind, loading, error, refresh, push, pushing };
}
