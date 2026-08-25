"use client";

import { useState } from "react";
import { CheckCircle2, FlaskConical, Loader2, Play, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils/format-date";
import {
  isVerificationReport,
  type VerificationReport,
} from "@/lib/verify/verify-constants";

interface VerificationReportSectionProps {
  projectId: string;
  epicId: string;
  report?: VerificationReport | null;
  onReportChange?: (report: VerificationReport) => void;
}

function durationLabel(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

/** Latest deterministic checks plus the human-triggered run action. */
export function VerificationReportSection({
  projectId,
  epicId,
  report = null,
  onReportChange,
}: VerificationReportSectionProps) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `/api/projects/${projectId}/epics/${epicId}/verify`;

  async function runManually() {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const json = await responseJson(response);
      if (!response.ok || !isVerificationReport(json.data)) {
        throw new Error(
          typeof json.error === "string"
            ? json.error
            : "Verification did not produce a report."
        );
      }
      onReportChange?.(json.data);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to run verification."
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <section
      className="flex flex-col gap-[10px] border-t border-border-soft pt-[16px]"
      data-testid="verification-section"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[12px] uppercase tracking-[.08em] text-meta">
          <FlaskConical className="h-3.5 w-3.5" />
          Verification
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          onClick={() => void runManually()}
          disabled={running}
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {running ? "Running verification…" : "Run verification"}
        </Button>
      </div>

      {error && (
        <p className="text-[12px] leading-[1.5] text-destructive" role="alert">
          {error}
        </p>
      )}

      {report ? (
        <div
          className="flex flex-col gap-2.5 rounded-[10px] border border-border-soft bg-band/40 p-3"
          data-testid="verification-report"
        >
          <div className="flex items-center gap-2">
            {report.status === "pass" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive" />
            )}
            <span className="text-[13px] font-medium">
              {report.status === "pass" ? "All checks passed" : "Checks failed"}
            </span>
            <span className="ml-auto font-mono text-[10.5px] text-meta">
              {formatDateTime(report.finishedAt)}
            </span>
          </div>

          <div className="flex flex-col gap-2">
            {report.commands.map((command, index) => {
              const passed = command.exitCode === 0;
              return (
                <div
                  key={`${command.name}-${index}`}
                  className="rounded-[8px] border border-border-soft bg-background/50 px-3 py-2.5"
                  data-testid={`verification-command-${command.name}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[12.5px] font-medium">
                      {command.name}
                    </span>
                    <Badge
                      variant="outline"
                      className={
                        passed
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "border-destructive/30 bg-destructive/10 text-destructive"
                      }
                    >
                      {passed ? "PASS" : "FAIL"}
                    </Badge>
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-meta">
                      {durationLabel(command.durationMs)}
                    </span>
                  </div>
                  <code className="mt-1.5 block truncate text-[10.5px] text-muted-foreground">
                    {command.command}
                  </code>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11.5px] text-muted-foreground">
                      Output: {command.name}
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[10.5px] leading-[1.5]">
                      {command.tail.trim() || "No output."}
                    </pre>
                  </details>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          No verification report yet.
        </p>
      )}
    </section>
  );
}
