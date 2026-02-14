"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Activity, Plus, RefreshCw } from "lucide-react";
import { ReportDetail } from "@/components/qa/ReportDetail";
import { StartTechCheckDialog } from "@/components/qa/StartTechCheckDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useQaReports } from "@/hooks/useQaReports";

function formatDate(value: string | null): string {
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

export default function QAPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { reports, loading, error, refresh } = useQaReports(projectId);
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    if (reports.length === 0) {
      setSelectedReportId(null);
      return;
    }

    if (!selectedReportId || !reports.some((report) => report.id === selectedReportId)) {
      setSelectedReportId(reports[0].id);
    }
  }, [reports, selectedReportId]);

  const stats = useMemo(() => {
    const running = reports.filter((report) => report.status === "running").length;
    const completed = reports.filter((report) => report.status === "completed").length;
    const failed = reports.filter((report) => report.status === "failed").length;
    return { running, completed, failed };
  }, [reports]);

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4 gap-3">
        <div>
          <h2 className="text-xl font-bold">QA</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Run comprehensive tech checks, review report history, and create epics from findings.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Refresh
          </Button>
          <Button size="sm" className="h-8" onClick={() => setStartDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Start Tech Check
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 text-xs text-muted-foreground">
        <Badge variant="secondary">{stats.running} running</Badge>
        <Badge variant="outline">{stats.completed} completed</Badge>
        <Badge variant="outline">{stats.failed} failed</Badge>
      </div>

      {actionMessage && (
        <Card className="mb-4 p-3 text-xs text-green-600 dark:text-green-400">
          {actionMessage}
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4 flex-1 min-h-0">
        <Card className="h-full flex flex-col">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Tech Check History</h3>
          </div>
          <div className="flex-1 overflow-auto p-3 space-y-2">
            {loading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Activity className="h-3.5 w-3.5 animate-pulse" />
                Loading reports...
              </div>
            )}
            {!loading && error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            {!loading && !error && reports.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No tech checks yet. Start one to generate a project QA report.
              </p>
            )}

            {reports.map((report) => (
              <button
                key={report.id}
                type="button"
                onClick={() => setSelectedReportId(report.id)}
                className={`w-full rounded-md border p-3 text-left transition-colors ${
                  selectedReportId === report.id
                    ? "border-primary bg-accent"
                    : "border-border hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-medium">#{report.id.slice(0, 8)}</span>
                  <Badge variant={statusVariant(report.status)} className="text-[10px]">
                    {report.status}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {formatDate(report.createdAt)}
                </p>
                {report.summary && (
                  <p className="mt-1 text-xs line-clamp-3 text-muted-foreground">
                    {report.summary}
                  </p>
                )}
              </button>
            ))}
          </div>
        </Card>

        <ReportDetail
          projectId={projectId}
          reportId={selectedReportId}
          onReportUpdated={() => void refresh()}
          onCreateEpics={(epics) => {
            setActionMessage(
              `Created ${epics.length} epic${epics.length === 1 ? "" : "s"} from QA report.`,
            );
          }}
        />
      </div>

      <StartTechCheckDialog
        projectId={projectId}
        open={startDialogOpen}
        onOpenChange={setStartDialogOpen}
        onStarted={(data) => {
          setActionMessage("Tech check started.");
          setSelectedReportId(data.reportId);
          void refresh();
        }}
      />
    </div>
  );
}
