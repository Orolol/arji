"use client";

import { useState, useEffect, useCallback } from "react";

export interface DependencyRecord {
  id: string;
  ticketId: string;
  dependsOnTicketId: string;
  projectId: string;
  scopeType: string;
  scopeId: string;
  createdAt: string;
}

export interface EpicDependencyData {
  predecessors: DependencyRecord[];
  successors: DependencyRecord[];
}

export function useEpicDependencies(projectId: string, epicId: string | null) {
  const [data, setData] = useState<EpicDependencyData>({
    predecessors: [],
    successors: [],
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDeps = useCallback(async () => {
    if (!epicId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/epics/${epicId}/dependencies`
      );
      const json = await res.json();
      if (res.ok && json.data) {
        setData(json.data);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [projectId, epicId]);

  useEffect(() => {
    fetchDeps();
  }, [fetchDeps]);

  const saveDependencies = useCallback(
    async (dependsOnIds: string[]) => {
      if (!epicId) return;
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/epics/${epicId}/dependencies`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dependsOnIds }),
          }
        );
        const json = await res.json();
        if (!res.ok) {
          setError(json.error || "Failed to update dependencies");
          return false;
        }
        await fetchDeps();
        return true;
      } catch {
        setError("Failed to update dependencies");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [projectId, epicId, fetchDeps]
  );

  return {
    predecessors: data.predecessors,
    successors: data.successors,
    loading,
    saving,
    error,
    saveDependencies,
    refresh: fetchDeps,
    clearError: () => setError(null),
  };
}
