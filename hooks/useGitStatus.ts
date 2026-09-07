"use client";

import { useTranslations } from "next-intl";

import { useState, useCallback, useEffect } from "react";

interface GitStatus {
  ahead: number;
  behind: number;
  /** Epoch ms of the server's last successful `git fetch`, null if never. */
  lastFetchedAt: number | null;
  /** Why the server's implicit fetch failed on the last status read, if it did. */
  lastFetchError: string | null;
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
  const tErrors = useTranslations("ClientErrors");
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [lastFetchError, setLastFetchError] = useState<string | null>(null);
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
        setError(data.error || tErrors("failedToFetchStatus"));
        return;
      }

      setAhead(data.data?.ahead ?? 0);
      setBehind(data.data?.behind ?? 0);
      setLastFetchedAt(data.data?.lastFetchedAt ?? null);
      setLastFetchError(data.data?.lastFetchError ?? null);
    } catch {
      setError(tErrors("failedToFetchGitStatus"));
    } finally {
      setLoading(false);
    }
  }, [projectId, branchName, githubConfigured, tErrors]);

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
        setError(data.error || tErrors("pushFailed"));
        return;
      }

      // Refresh status after push
      await refresh();
    } catch {
      setError(tErrors("pushFailed"));
    } finally {
      setPushing(false);
    }
  }, [projectId, branchName, githubConfigured, refresh, tErrors]);

  // Auto-fetch on mount when conditions are met
  useEffect(() => {
    if (branchName && githubConfigured) {
      refresh();
    }
  }, [branchName, githubConfigured, refresh]);

  return {
    ahead,
    behind,
    lastFetchedAt,
    lastFetchError,
    loading,
    error,
    refresh,
    push,
    pushing,
  };
}
