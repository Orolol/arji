"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, XCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SpecUpdateProgressProps {
  projectId: string;
  sessionId: string;
  status: "running" | "done" | "failed";
  /** Live agent output — the session's "output" chunk stream, polled. */
  stream: string | null;
  /** Final agent answer (session logs result / last non-empty text). */
  response: string | null;
  /** Error detail from the session, when the run failed. */
  error: string | null;
  onDismiss: () => void;
}

/**
 * Feedback panel for the "Mettre à jour la spec" run, shown on the Spec view
 * while the session lives: the streaming output while it runs, then the
 * confirmation with the agent's response, or the failure reason (the saved
 * spec is only replaced by a successful run — see lib/workflow/spec-update.ts).
 */
export function SpecUpdateProgress({
  projectId,
  sessionId,
  status,
  stream,
  response,
  error,
  onDismiss,
}: SpecUpdateProgressProps) {
  const streamRef = useRef<HTMLPreElement | null>(null);

  // Keep the live output pinned to the newest line while the agent works.
  useEffect(() => {
    if (status === "running" && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [stream, status]);

  return (
    <div
      className="flex-none px-[26px] pb-[18px]"
      data-testid="spec-update-progress"
      data-status={status}
    >
      <div className="flex flex-col gap-[10px] rounded-[12px] border border-border bg-card p-[16px]">
        <div className="flex items-center gap-[9px]">
          {status === "running" ? (
            <>
              <Loader2 className="h-[14px] w-[14px] animate-spin text-muted-foreground" />
              <span className="text-[13px] text-muted-foreground">
                Spec update running
              </span>
            </>
          ) : status === "done" ? (
            <>
              <CheckCircle2 className="h-[14px] w-[14px] text-agent" />
              <span className="text-[13px]">Spec updated by agent.</span>
            </>
          ) : (
            <>
              <XCircle className="h-[14px] w-[14px] text-destructive" />
              <span className="text-[13px] text-destructive">
                Spec update failed — the saved spec was left unchanged.
              </span>
            </>
          )}
          <Link
            href={`/projects/${projectId}/sessions/${sessionId}`}
            className="ml-auto text-[12.5px] text-muted-foreground underline underline-offset-2"
          >
            view session
          </Link>
          {status !== "running" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-[25px] w-[25px] rounded-[6px] p-0 text-muted-foreground"
              onClick={onDismiss}
              aria-label="Dismiss spec update result"
            >
              <X className="h-[13px] w-[13px]" />
            </Button>
          )}
        </div>

        {status === "running" && (
          <pre
            ref={streamRef}
            className="max-h-[200px] overflow-y-auto rounded-[8px] bg-band p-[12px] font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap break-words text-muted-foreground"
            data-testid="spec-update-stream"
          >
            {stream ? stream : "Waiting for agent output…"}
          </pre>
        )}

        {status === "done" && response && (
          <div className="flex flex-col gap-[6px]">
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Agent response
            </span>
            <pre
              className="max-h-[200px] overflow-y-auto rounded-[8px] bg-band p-[12px] font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap break-words text-muted-foreground"
              data-testid="spec-update-response"
            >
              {response}
            </pre>
          </div>
        )}

        {status === "failed" && error && (
          <pre
            className="max-h-[160px] overflow-y-auto rounded-[8px] bg-band p-[12px] font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap break-words text-destructive/80"
            data-testid="spec-update-error"
          >
            {error}
          </pre>
        )}
      </div>
    </div>
  );
}
