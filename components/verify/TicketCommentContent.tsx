"use client";

import { CheckCircle2, FlaskConical, XCircle } from "lucide-react";
import type { RegressionFailureReason } from "@/lib/verify/regression-constants";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import {
  locateRegressionReport,
  regressionReasonLabel,
} from "@/lib/verify/regression-report";

/**
 * Renders one ticket comment. Ordinary comments are plain markdown; a
 * comment carrying the pipeline's red→green verify report renders that
 * report as a structured block — test files detected, green/red verdict,
 * failure reason — in place of its JSON payload.
 *
 * Only the report REGION is replaced. Report comments are ordinary ticket
 * comments and get injected verbatim into later prompts, so an agent
 * quoting one back inside its own comment is a reachable case: swallowing
 * the whole comment would drop everything that agent actually wrote.
 */
export function TicketCommentContent({ content }: { content: string }) {
  const located = locateRegressionReport(content);
  if (!located) {
    return <MarkdownContent content={content} />;
  }

  const { payload, before, after } = located;
  const { regression } = payload;
  const passed = regression.status === "passed";

  return (
    <div className="space-y-2">
      {before && <MarkdownContent content={before} />}
      <RegressionReportBlock
        passed={passed}
        reason={regression.reason}
        testFiles={regression.testFiles}
        detail={regression.detail ?? null}
      />
      {after && <MarkdownContent content={after} />}
    </div>
  );
}

/** The structured red/green verdict block itself. */
function RegressionReportBlock({
  passed,
  reason,
  testFiles,
  detail,
}: {
  passed: boolean;
  reason: RegressionFailureReason | null;
  testFiles: string[];
  detail: string | null;
}) {
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
          {regressionReasonLabel(reason ?? "command_error")}
        </p>
      )}

      <div className="text-xs">
        <span className="text-muted-foreground">Test files detected:</span>{" "}
        {testFiles.length > 0 ? (
          <span className="font-mono">{testFiles.join(", ")}</span>
        ) : (
          <span className="italic text-muted-foreground">none</span>
        )}
      </div>

      {detail && (
        <pre className="text-[11px] whitespace-pre-wrap break-all rounded bg-muted/60 p-2 max-h-40 overflow-y-auto">
          {detail.trim()}
        </pre>
      )}
    </div>
  );
}
