"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Plus, Sparkles, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { usePolling } from "@/hooks/usePolling";
import { formatDateTime } from "@/lib/utils/format-date";
import { cn } from "@/lib/utils";

interface QaReport {
  id: string;
  projectId: string;
  status: string;
  summary: string | null;
  reportContent: string | null;
  checkType?: string;
  createdAt: string | null;
  completedAt: string | null;
}

interface ReportDetailProps {
  projectId: string;
  reportId: string | null;
  onCreateEpics?: (epics: Array<{ id: string; title: string }>) => void;
  onReportUpdated?: () => void;
}

type Severity = "critical" | "major" | "minor";

interface ParsedFinding {
  key: string;
  severity: Severity;
  title: string;
  path: string | null;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "CRITICAL",
  major: "MAJOR",
  minor: "MINOR",
};

const SEVERITY_TONE: Record<Severity, string> = {
  critical: "text-destructive",
  major: "text-primary",
  minor: "text-meta",
};

/** QA prompts ask for Critical/High/Major/Medium/Minor/Low severities. */
const SEVERITY_WORDS: Record<string, Severity> = {
  critical: "critical",
  blocker: "critical",
  high: "major",
  major: "major",
  medium: "minor",
  minor: "minor",
  low: "minor",
  info: "minor",
  suggestion: "minor",
  nit: "minor",
};

const SEVERITY_ALTERNATION =
  "critical|blocker|high|major|medium|minor|low|info|suggestion|nit";
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const INLINE_RE = new RegExp(
  `^\\s{0,3}(?:[-*+]\\s+|\\d+\\.\\s+|#{1,6}\\s+)?[*_\`\\[]{0,2}(${SEVERITY_ALTERNATION})[*_\`\\]]{0,2}\\s*[:\\-–—|]\\s*(.+)$`,
  "i",
);
const SEVERITY_FIELD_RE = new RegExp(
  `^\\s{0,3}(?:[-*+]\\s+)?\\**severity\\**\\s*[:\\-]\\s*\\**\\s*(${SEVERITY_ALTERNATION})\\b`,
  "i",
);
const BACKTICK_PATH_RE = /`([^`\n]*[/.][^`\n]*)`/;
const BARE_PATH_RE =
  /(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,6}(?::\d+)?)/;

function stripMarkdown(value: string): string {
  return value
    .replace(/[*_`]+/g, "")
    .replace(/^\[|\]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPath(...candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const backticked = BACKTICK_PATH_RE.exec(candidate);
    if (backticked) return backticked[1].trim();
    const bare = BARE_PATH_RE.exec(candidate);
    if (bare) return bare[1].trim();
  }
  return null;
}

function cleanTitle(raw: string, path: string | null): string {
  let title = stripMarkdown(raw);
  if (path) {
    title = title.replace(path, "");
  }
  title = title.replace(/[\s(),—–-]+$/g, "").replace(/^[\s—–-]+/, "").trim();
  return title.length > 180 ? `${title.slice(0, 180)}…` : title;
}

/**
 * Best-effort structuring of the agent's markdown report. QA reports are free
 * prose — anything that does not clearly announce a severity is left alone and
 * the raw report stays available below the list.
 */
export function parseFindings(content: string | null): ParsedFinding[] {
  if (!content) return [];

  const lines = content.split("\n");
  const findings: ParsedFinding[] = [];
  const seen = new Set<string>();
  let lastHeading: string | null = null;

  const push = (severity: Severity, title: string, path: string | null) => {
    if (title.replace(/[^A-Za-z0-9]/g, "").length < 6) return;
    const dedupeKey = `${severity}|${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    findings.push({ key: `${findings.length}-${dedupeKey}`, severity, title, path });
  };

  for (let i = 0; i < lines.length && findings.length < 200; i += 1) {
    const line = lines[i];

    const inline = INLINE_RE.exec(line);
    if (inline) {
      const severity = SEVERITY_WORDS[inline[1].toLowerCase()];
      const path = extractPath(inline[2], lines[i + 1]);
      if (severity) push(severity, cleanTitle(inline[2], path), path);
      continue;
    }

    const field = SEVERITY_FIELD_RE.exec(line);
    if (field && lastHeading) {
      const severity = SEVERITY_WORDS[field[1].toLowerCase()];
      const path = extractPath(lines[i + 1], lines[i + 2], lastHeading);
      if (severity) push(severity, cleanTitle(lastHeading, path), path);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) lastHeading = stripMarkdown(heading[1]);
  }

  return findings;
}

function formatDuration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusTone(status: string): string {
  if (status === "completed") return "bg-agent-bg text-agent";
  if (status === "failed") return "bg-destructive/10 text-destructive";
  if (status === "running") return "bg-band text-primary";
  return "bg-band text-meta";
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
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());

  const onReportUpdatedRef = useRef(onReportUpdated);
  onReportUpdatedRef.current = onReportUpdated;

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
    } catch {
      setError("Failed to load report");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, reportId]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  useEffect(() => {
    setSelectedFindings(new Set());
  }, [reportId]);

  // Poll while the report is running; the effect above already did the
  // initial fetch, so skip the immediate call.
  usePolling(
    loadReport,
    3000,
    Boolean(reportId && report && report.status === "running"),
    { immediate: false },
  );

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
    const label =
      report.checkType === "e2e_test"
        ? "E2E Test"
        : report.checkType === "failure_digest"
          ? "Failure Digest"
          : "Tech Check";
    return `${label} #${report.id.slice(0, 8)}`;
  }, [report]);

  const findings = useMemo(
    () => parseFindings(report?.reportContent ?? null),
    [report?.reportContent],
  );

  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
    for (const finding of findings) counts[finding.severity] += 1;
    return counts;
  }, [findings]);

  function toggleFinding(key: string) {
    setSelectedFindings((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleExportMarkdown() {
    if (!report) return;
    const chosen = findings.filter((finding) => selectedFindings.has(finding.key));
    const source = chosen.length > 0 ? chosen : findings;
    const body =
      source.length > 0
        ? source
            .map(
              (finding) =>
                `- **${SEVERITY_LABEL[finding.severity]}** — ${finding.title}${
                  finding.path ? ` (\`${finding.path}\`)` : ""
                }`,
            )
            .join("\n")
        : report.reportContent || "";

    const markdown = `# ${heading}\n\n${body}\n`;

    if (typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `qa-${report.id.slice(0, 8)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!reportId) {
    return (
      <div className="flex h-full min-h-0 flex-col rounded-[12px] border border-border bg-card px-[24px] py-[22px]">
        <p className="text-[13px] text-muted-foreground">
          Select a report from history to view details.
        </p>
      </div>
    );
  }

  if (loading && !report) {
    return (
      <div className="flex h-full min-h-0 flex-col rounded-[12px] border border-border bg-card px-[24px] py-[22px]">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading report...
        </div>
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="flex h-full min-h-0 flex-col rounded-[12px] border border-destructive/50 bg-card px-[24px] py-[22px]">
        <div className="flex items-center gap-2 text-[13px] text-destructive">
          <XCircle className="h-4 w-4" />
          {error}
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="flex h-full min-h-0 flex-col rounded-[12px] border border-border bg-card px-[24px] py-[22px]">
        <p className="text-[13px] text-muted-foreground">Report not found.</p>
      </div>
    );
  }

  const duration = formatDuration(report.createdAt, report.completedAt);
  const canCreateEpics =
    report.status === "completed" && Boolean(report.reportContent);

  return (
    <div className="flex h-full min-h-0 flex-col gap-[16px] rounded-[12px] border border-border bg-card px-[24px] py-[22px]">
      <div className="flex flex-wrap items-center gap-[12px]">
        <h3 className="text-[17px] font-semibold">{heading}</h3>
        <span
          className={cn(
            "inline-flex items-center gap-[7px] rounded-full px-[10px] py-[4px] text-[12px]",
            statusTone(report.status),
          )}
        >
          {report.status === "completed" && (
            <CheckCircle2 className="h-[12px] w-[12px]" />
          )}
          {report.status === "running" && (
            <Loader2 className="h-[12px] w-[12px] animate-spin" />
          )}
          {report.status}
          {duration ? ` · ${duration}` : ""}
        </span>
        <span className="ml-auto font-mono text-[11px] text-meta">
          {formatDateTime(report.createdAt)}
        </span>
      </div>

      {report.summary && (
        <p className="line-clamp-3 text-[13px] leading-[1.55] text-muted-foreground">
          {report.summary}
        </p>
      )}

      {findings.length > 0 && (
        <div className="flex gap-[10px]">
          {(["critical", "major", "minor"] as Severity[]).map((severity) => (
            <div
              key={severity}
              className="flex flex-1 flex-col gap-[2px] rounded-[11px] bg-band p-[13px]"
            >
              <span
                className={cn(
                  "text-[20px] font-semibold leading-none",
                  SEVERITY_TONE[severity],
                )}
              >
                {severityCounts[severity]}
              </span>
              <span className="text-[12px] text-muted-foreground">
                {severity}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {report.status === "running" && (
          <div className="mb-3 inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {report.checkType === "e2e_test"
              ? "E2E test is still running..."
              : report.checkType === "failure_digest"
                ? "Failure digest is still running..."
                : "Tech check is still running..."}
          </div>
        )}

        {findings.length > 0 ? (
          <>
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Findings
            </span>
            {findings.map((finding) => (
              <label
                key={finding.key}
                className="flex cursor-pointer gap-[12px] border-t border-border-soft py-[13px]"
              >
                <span
                  className={cn(
                    "min-w-[64px] font-mono text-[11px]",
                    SEVERITY_TONE[finding.severity],
                  )}
                >
                  {SEVERITY_LABEL[finding.severity]}
                </span>
                <span className="flex flex-1 flex-col gap-[3px]">
                  <span className="text-[13.5px] leading-[1.45]">
                    {finding.title}
                  </span>
                  {finding.path && (
                    <span className="font-mono text-[11px] text-meta">
                      {finding.path}
                    </span>
                  )}
                </span>
                <input
                  type="checkbox"
                  aria-label={`Select finding: ${finding.title}`}
                  checked={selectedFindings.has(finding.key)}
                  onChange={() => toggleFinding(finding.key)}
                  className="mt-[2px] h-[16px] w-[16px] flex-none accent-primary"
                />
              </label>
            ))}
            <details className="mt-[16px]">
              <summary className="cursor-pointer text-[12.5px] text-muted-foreground">
                Full report
              </summary>
              <div className="mt-[10px] text-[13.5px] leading-[1.6]">
                <MarkdownContent content={report.reportContent || ""} />
              </div>
            </details>
          </>
        ) : report.reportContent?.trim() ? (
          <div className="text-[13.5px] leading-[1.6]">
            <MarkdownContent content={report.reportContent} />
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            {report.status === "running"
              ? "Waiting for report output..."
              : "No report content available."}
          </p>
        )}
      </div>

      {createdEpics.length > 0 && (
        <div className="inline-flex items-center gap-1 text-[12.5px] text-agent">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Created {createdEpics.length} epic{createdEpics.length > 1 ? "s" : ""}.
        </div>
      )}
      {error && <p className="text-[12.5px] text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-[10px]">
        <span className="text-[12.5px] text-muted-foreground">
          {selectedFindings.size} finding
          {selectedFindings.size === 1 ? "" : "s"} selected
        </span>
        <span className="ml-auto flex items-center gap-[10px]">
          <Button
            variant="outline"
            className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
            onClick={handleExportMarkdown}
            disabled={!report.reportContent}
          >
            Export markdown
          </Button>
          {canCreateEpics && (
            <Button
              className="h-[31px] rounded-[8px] px-[13px] text-[13px]"
              onClick={handleCreateEpics}
              disabled={creatingEpics}
            >
              {creatingEpics ? (
                <Loader2 className="h-[14px] w-[14px] animate-spin" />
              ) : findings.length > 0 ? (
                <Plus className="h-[14px] w-[14px]" />
              ) : (
                <Sparkles className="h-[14px] w-[14px]" />
              )}
              Create Epics From Report
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}
