"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Activity, Plus, RefreshCw } from "lucide-react";
import { ReportDetail } from "@/components/qa/ReportDetail";
import { StartQaCheckDialog } from "@/components/qa/StartQaCheckDialog";
import { Button } from "@/components/ui/button";
import { useQaReports } from "@/hooks/useQaReports";
import { consumeQueryParam } from "@/lib/navigation/deep-link";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/utils/format-date";

type FilterCheckType = "tech_check" | "e2e_test" | "failure_digest" | null;

const CHECK_TYPE_FILTERS: { value: FilterCheckType; label: string }[] = [
  { value: null, label: "All" },
  { value: "tech_check", label: "Tech Check" },
  { value: "e2e_test", label: "E2E Test" },
  { value: "failure_digest", label: "Failure Digest" },
];

function statusTone(status: string): string {
  if (status === "completed") return "text-agent";
  if (status === "failed") return "text-destructive";
  if (status === "running") return "text-primary";
  return "text-meta";
}

function checkTypeBadgeLabel(checkType: string): string {
  if (checkType === "e2e_test") return "E2E";
  if (checkType === "failure_digest") return "DIGEST";
  return "TECH";
}

export default function QAPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const { reports, loading, error, refresh } = useQaReports(projectId);
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [filterCheckType, setFilterCheckType] = useState<FilterCheckType>(null);

  // Source links from generated tickets select the referenced report once,
  // then remove the transient parameter so later navigation does not restore
  // a stale selection. Same two-part shape as the desk's ?ticket=/?nightRun=
  // links (app/projects/[projectId]/page.tsx).
  //
  // The selection is plain state of this component, so it is adjusted during
  // render rather than from an effect; only the URL rewrite is a side effect.
  //
  // That rewrite goes through `window.history.replaceState`, not
  // `router.replace`: a replace() is a navigation, and the App Router leaves
  // the spent parameter in the address bar until the destination's RSC payload
  // commits. Inside that window the user can pick another report and reload,
  // and the deep link replays. Nothing on the server reads ?reportId=, so the
  // synchronous query-only rewrite is the right tool — see
  // lib/navigation/deep-link.ts.
  const reportIdParam = searchParams.get("reportId");
  const [handledReportId, setHandledReportId] = useState<string | null>(null);

  if (reportIdParam !== handledReportId) {
    setHandledReportId(reportIdParam);
    if (reportIdParam) {
      setSelectedReportId(reportIdParam);
    }
  }

  useEffect(() => {
    if (!searchParams.get("reportId")) return;
    consumeQueryParam(searchParams, "reportId", `/projects/${projectId}/qa`);
  }, [projectId, searchParams]);

  const filteredReports = useMemo(() => {
    if (!filterCheckType) return reports;
    return reports.filter((report) => report.checkType === filterCheckType);
  }, [reports, filterCheckType]);

  const effectiveSelectedReportId =
    selectedReportId &&
    filteredReports.some((report) => report.id === selectedReportId)
      ? selectedReportId
      : (filteredReports[0]?.id ?? null);

  const handleStarted = useCallback((data: {
    reportId: string;
    sessionId: string | null;
    noOp?: boolean;
  }) => {
    setActionMessage(
      data.noOp
        ? "Failure digest recorded: no evidence in the selected window."
        : "QA check started.",
    );
    setSelectedReportId(data.reportId);
    void refresh();
  }, [refresh]);

  const handleCreateEpics = useCallback((epics: Array<{ id: string; title: string }>) => {
    setActionMessage(
      `Created ${epics.length} epic${epics.length === 1 ? "" : "s"} from QA report.`,
    );
  }, []);

  const stats = useMemo(() => {
    const running = reports.filter((report) => report.status === "running").length;
    const completed = reports.filter((report) => report.status === "completed").length;
    const failed = reports.filter((report) => report.status === "failed").length;
    return { running, completed, failed };
  }, [reports]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-start gap-[16px] px-[26px] pb-[18px] pt-[24px]">
        <div className="flex flex-col gap-[5px]">
          <h2 className="text-[19px] font-semibold">QA</h2>
          <p className="text-[13px] text-muted-foreground">
            Run tech checks, E2E tests, and recurring-failure digests; review
            report history and create epics from findings.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-[9px]">
          <Button
            variant="outline"
            className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-[14px] w-[14px]" />
            Refresh
          </Button>
          <Button
            className="h-[31px] rounded-[8px] px-[13px] text-[13px]"
            onClick={() => setStartDialogOpen(true)}
          >
            <Plus className="h-[14px] w-[14px]" />
            New Check
          </Button>
        </div>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-[8px] px-[26px] pb-[16px]">
        <span className="rounded-full border border-border px-[11px] py-[3px] text-[12.5px] text-agent">
          {stats.running} running
        </span>
        <span className="rounded-full border border-border px-[11px] py-[3px] text-[12.5px] text-muted-foreground">
          {stats.completed} completed
        </span>
        <span className="rounded-full border border-border px-[11px] py-[3px] text-[12.5px] text-destructive">
          {stats.failed} failed
        </span>
        <span className="mx-[6px] h-4 w-px bg-border" />
        {CHECK_TYPE_FILTERS.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => setFilterCheckType(option.value)}
            className={cn(
              "rounded-full px-[11px] py-[3px] text-[12.5px] transition-colors",
              filterCheckType === option.value
                ? "bg-foreground text-background"
                : "border border-border text-muted-foreground hover:bg-band"
            )}
          >
            {option.label}
          </button>
        ))}
        {actionMessage && (
          <span className="ml-auto text-[12.5px] text-agent">
            {actionMessage}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-[22px] px-[26px] pb-[26px]">
        <div className="flex w-[340px] flex-none flex-col gap-[10px] overflow-y-auto">
          <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
            History
          </span>

          {loading && (
            <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <Activity className="h-3.5 w-3.5 animate-pulse" />
              Loading reports...
            </div>
          )}
          {!loading && error && (
            <p className="text-[12.5px] text-destructive">{error}</p>
          )}
          {!loading && !error && filteredReports.length === 0 && (
            <p className="text-[12.5px] text-muted-foreground">
              No QA reports yet. Start a check or failure digest to generate a
              report.
            </p>
          )}

          {filteredReports.map((report) => (
            <button
              key={report.id}
              type="button"
              onClick={() => setSelectedReportId(report.id)}
              className={cn(
                "flex flex-col gap-[8px] rounded-[11px] border px-[16px] py-[14px] text-left transition-colors",
                effectiveSelectedReportId === report.id
                  ? "border-primary bg-card"
                  : "border-border hover:bg-band"
              )}
            >
              <div className="flex items-center gap-[8px]">
                <span className="rounded-full bg-band px-[8px] py-[2px] font-mono text-[11.5px] text-muted-foreground">
                  {checkTypeBadgeLabel(report.checkType)}
                </span>
                <span className={cn("text-[12.5px]", statusTone(report.status))}>
                  {report.status}
                </span>
                <span className="ml-auto font-mono text-[11px] text-meta">
                  {timeAgo(report.createdAt)}
                </span>
              </div>
              <span className="line-clamp-2 text-[13.5px] font-medium leading-[1.35]">
                {report.summary || `#${report.id.slice(0, 8)}`}
              </span>
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <ReportDetail
            projectId={projectId}
            reportId={effectiveSelectedReportId}
            onReportUpdated={refresh}
            onCreateEpics={handleCreateEpics}
          />
        </div>
      </div>

      <StartQaCheckDialog
        projectId={projectId}
        open={startDialogOpen}
        onOpenChange={setStartDialogOpen}
        onStarted={handleStarted}
      />
    </div>
  );
}
