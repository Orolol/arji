"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MarkdownContent } from "@/components/chat/MarkdownContent";

interface QaReport {
  id: string;
  projectId: string;
  status: string;
  summary: string | null;
  reportContent: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

interface ReportDetailProps {
  projectId: string;
  reportId: string | null;
  onCreateEpics?: (epics: Array<{ id: string; title: string }>) => void;
  onReportUpdated?: () => void;
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "cancelled") return "outline";
  return "secondary";
}

export function ReportDetail({
  projectId,
  reportId,
  onCreateEpics,
  onReportUpdated,
}: ReportDetailProps) {
  const [report, setReport] = useState<QaReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingEpics, setCreatingEpics] = useState(false);
  const [createdEpics, setCreatedEpics] = useState<Array<{ id: string; title: string }>>([]);

  const loadReport = useCallback(async () => {
    if (!reportId) {
      setReport(null);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/reports/${reportId}`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(json.error || "Failed to load report");
        setReport(null);
        return;
      }

      setReport((json.data || null) as QaReport | null);
      setError(null);
      onReportUpdated?.();
    } catch {
      setError("Failed to load report");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, reportId, onReportUpdated]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  useEffect(() => {
    if (!reportId || !report || report.status !== "running") return;

    const timer = setInterval(() => {
      void loadReport();
    }, 3000);

    return () => clearInterval(timer);
  }, [reportId, report, loadReport]);

  async function handleCreateEpics() {
    if (!reportId) return;
    setCreatingEpics(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${projectId}/qa/reports/${reportId}/create-epics`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(json.error || "Failed to create epics from report");
        return;
      }

      const epics = (json.data?.epics || []) as Array<{ id: string; title: string }>;
      setCreatedEpics(epics);
      onCreateEpics?.(epics);
    } catch {
      setError("Failed to create epics from report");
    } finally {
      setCreatingEpics(false);
    }
  }

  const heading = useMemo(() => {
    if (!report) return "Report";
    return `Report #${report.id.slice(0, 8)}`;
  }, [report]);

  if (!reportId) {
    return (
      <Card className="p-6 h-full">
        <p className="text-sm text-muted-foreground">
          Select a report from history to view details.
        </p>
      </Card>
    );
  }

  if (loading && !report) {
    return (
      <Card className="p-6 h-full">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading report...
        </div>
      </Card>
    );
  }

  if (error && !report) {
    return (
      <Card className="p-6 h-full border-destructive/50">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <XCircle className="h-4 w-4" />
          {error}
        </div>
      </Card>
    );
  }

  if (!report) {
    return (
      <Card className="p-6 h-full">
        <p className="text-sm text-muted-foreground">Report not found.</p>
      </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col">
      <div className="border-b border-border p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">{heading}</h3>
          <Badge variant={statusVariant(report.status)}>{report.status}</Badge>
        </div>
        <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
          <p>Created: {formatDateTime(report.createdAt)}</p>
          <p>Completed: {formatDateTime(report.completedAt)}</p>
        </div>
        {report.summary && (
          <p className="mt-2 text-xs text-muted-foreground line-clamp-3">
            {report.summary}
          </p>
        )}
        {report.status === "completed" && report.reportContent && (
          <Button
            size="sm"
            className="mt-3 h-7 text-xs"
            onClick={handleCreateEpics}
            disabled={creatingEpics}
          >
            {creatingEpics ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-1" />
            )}
            Create Epics From Report
          </Button>
        )}
        {createdEpics.length > 0 && (
          <div className="mt-2 text-xs text-green-600 dark:text-green-400">
            <div className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Created {createdEpics.length} epic{createdEpics.length > 1 ? "s" : ""}.
            </div>
          </div>
        )}
        {error && (
          <p className="mt-2 text-xs text-destructive">{error}</p>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {report.status === "running" && (
          <div className="mb-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Tech check is still running...
          </div>
        )}

        {report.reportContent?.trim() ? (
          <div className="text-sm leading-6">
            <MarkdownContent content={report.reportContent} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {report.status === "running"
              ? "Waiting for report output..."
              : "No report content available."}
          </p>
        )}
      </div>
    </Card>
  );
}
