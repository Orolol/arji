"use client";

import { useTranslations } from "next-intl";

import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/hooks/usePolling";

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
  checkType: string;
  createdAt: string | null;
  completedAt: string | null;
}

export function useQaReports(projectId: string, intervalMs = 3000) {
  const tErrors = useTranslations("ClientErrors");
  const [reports, setReports] = useState<QaReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/reports`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || tErrors("failedToLoadQAReports"));
        return;
      }
      const next = (json.data || []) as QaReportListItem[];
      setReports((prev) => {
        if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
        return next;
      });
      setError(null);
    } catch {
      setError(tErrors("failedToLoadQAReports"));
    } finally {
      setLoading(false);
    }
  }, [projectId, tErrors]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Poll only while a report is running; the initial load above already
  // fetched, so skip the immediate call.
  const hasRunningReport = reports.some((report) => report.status === "running");
  usePolling(refresh, intervalMs, hasRunningReport, { immediate: false });

  return {
    reports,
    loading,
    error,
    refresh,
  };
}
