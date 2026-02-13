"use client";

import { useState, useEffect, useCallback } from "react";

interface PrData {
  id: string;
  projectId: string;
  epicId: string | null;
  number: number;
  url: string;
  title: string;
  status: "draft" | "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export function useEpicPr(projectId: string, epicId: string | null) {
  const [pr, setPr] = useState<PrData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPr = useCallback(async () => {
    if (!epicId) return;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/epics/${epicId}/pr`
      );
      const data = await res.json();
      setPr(data.data ?? null);
    } catch {
      // Silently fail on fetch
    }
  }, [projectId, epicId]);

  useEffect(() => {
    fetchPr();
  }, [fetchPr]);

  const createPr = useCallback(
    async (opts?: { baseBranch?: string; draft?: boolean }) => {
      if (!epicId) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/epics/${epicId}/pr`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              baseBranch: opts?.baseBranch ?? "main",
              draft: opts?.draft ?? false,
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) {
          setError(data.message || data.error || "Failed to create PR");
        } else {
          setPr(data.data?.pr ?? null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create PR");
      } finally {
        setLoading(false);
      }
    },
    [projectId, epicId]
  );

  const syncPr = useCallback(async () => {
    if (!epicId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/epics/${epicId}/pr/sync`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Failed to sync PR");
      } else {
        setPr(data.data ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sync PR");
    } finally {
      setLoading(false);
    }
  }, [projectId, epicId]);

  const refresh = useCallback(async () => {
    await fetchPr();
  }, [fetchPr]);

  return { pr, loading, error, createPr, syncPr, refresh };
}
