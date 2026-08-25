"use client";

import { CheckCircle2, FlaskConical, XCircle } from "lucide-react";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import {
  parseRegressionReportComment,
  regressionReasonLabel,
} from "@/lib/verify/regression-report";

/**
 * The ticket's verify section for the mandatory bug-regression gate: when
 * a ticket comment carries a red→green verify report (posted by the
 * pipeline's mechanical check), it renders as a structured block — test
 * files detected, green/red verdict, failure reason — instead of the raw
 * markdown. Any other content renders as ordinary markdown.
 */
export function RegressionReportBlock({ content }: { content: string }) {
  const payload = parseRegressionReportComment(content);
  if (!payload) {
    return <MarkdownContent content={content} />;
  }

  const { regression } = payload;
  const passed = regression.status === "passed";

  return (
    <div
      data-testid="regression-report-block"
      className={`rounded-md border p-3 space-y-2 ${
        passed
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-red-500/30 bg-red-500/5"
      }`}
    >
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Verify — regression test (red → green)
        </span>
        {passed ? (
          <span className="ml-auto flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            PASSED
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
            <XCircle className="h-3.5 w-3.5" />
            FAILED
          </span>
        )}
      </div>

      {!passed && (
        <p className="text-xs">
          <span className="text-muted-foreground">Reason: </span>
          {regressionReasonLabel(regression.reason ?? "command_error")}
        </p>
      )}

      <div className="text-xs">
        <span className="text-muted-foreground">Test files detected:</span>{" "}
        {regression.testFiles.length > 0 ? (
          <span className="font-mono">
            {regression.testFiles.join(", ")}
          </span>
        ) : (
          <span className="italic text-muted-foreground">none</span>
        )}
      </div>

      {regression.detail && (
        <pre className="text-[11px] whitespace-pre-wrap break-all rounded bg-muted/60 p-2 max-h-40 overflow-y-auto">
          {regression.detail.trim()}
        </pre>
      )}
    </div>
  );
}
