"use client";

import { useCallback, useEffect, useState } from "react";

export interface QaReportListItem {
  id: string;
  projectId: string;
  status: "running" | "completed" | "failed" | "cancelled" | string;
  agentSessionId: string | null;
  namedAgentId: string | null;
  promptUsed: string | null;
  customPromptId: string | null;
  reportContent: string | null;
  summary: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export function useQaReports(projectId: string, intervalMs = 3000) {
  const [reports, setReports] = useState<QaReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/reports`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed to load QA reports");
        return;
      }
      setReports((json.data || []) as QaReportListItem[]);
      setError(null);
    } catch {
      setError("Failed to load QA reports");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!reports.some((report) => report.status === "running")) {
      return;
    }

    const timer = setInterval(() => {
      void refresh();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [reports, refresh, intervalMs]);

  return {
    reports,
    loading,
    error,
    refresh,
  };
}
