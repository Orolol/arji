"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Check, CircleAlert, X } from "lucide-react";

import { BreathingDot, Mono, SurfaceCard } from "@/components/piscine";

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
 * Feedback panel for the "Régénérer par chat" run, shown inside frame 8b's
 * SUGGESTION D'AGENT band while the session lives: the streaming output while
 * it runs, then the confirmation with the agent's response, or the failure
 * reason (the saved spec is only replaced by a successful run — see
 * lib/workflow/spec-update.ts).
 *
 * STATE IS ICON + WORD + MOTION, NEVER A BACKGROUND TINT: running is a
 * BreathingDot, done a lucide check in the live deep, failed a lucide
 * circle-alert in the coral. The card itself is never recoloured.
 *
 * Every `data-testid`, every sentence, the link's accessible name and the
 * dismiss `aria-label` are pinned by `__tests__/spec-update-progress.test.tsx`
 * and `__tests__/spec-page-update-feedback.test.tsx`. Only the styling moved.
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
    <div data-testid="spec-update-progress" data-status={status}>
      <SurfaceCard
        radius={10}
        className="flex flex-col gap-[9px] px-[11px] py-[9px]"
      >
        <div className="flex items-center gap-[8px]">
          {status === "running" ? (
            <>
              <BreathingDot size={7} tone="live" />
              <span className="text-[12px] text-muted-foreground">
                Spec update running
              </span>
            </>
          ) : status === "done" ? (
            <>
              <Check
                size={13}
                aria-hidden="true"
                className="shrink-0 text-strata-live-deep"
              />
              <span className="text-[12px] text-foreground">
                Spec updated by agent.
              </span>
            </>
          ) : (
            <>
              <CircleAlert
                size={13}
                aria-hidden="true"
                className="shrink-0 text-destructive"
              />
              <span className="text-[12px] text-destructive">
                Spec update failed — the saved spec was left unchanged.
              </span>
            </>
          )}
          <Link
            href={`/projects/${projectId}/sessions/${sessionId}`}
            className="ml-auto text-[11.5px] font-normal text-strata-next-deep no-underline hover:brightness-[0.92]"
          >
            view session
          </Link>
          {status !== "running" && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss spec update result"
              className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>

        {status === "running" && (
          <pre
            ref={streamRef}
            className="max-h-[160px] overflow-y-auto rounded-[10px] bg-muted p-[10px] font-mono text-[11.5px] leading-[1.5] tabular-nums break-words whitespace-pre-wrap text-muted-foreground"
            data-testid="spec-update-stream"
          >
            {stream ? stream : "Waiting for agent output…"}
          </pre>
        )}

        {status === "done" && response && (
          <div className="flex flex-col gap-[5px]">
            <Mono size={9.5} tone="muted" uppercase tracking={0.08}>
              Agent response
            </Mono>
            <pre
              className="max-h-[160px] overflow-y-auto rounded-[10px] bg-muted p-[10px] font-mono text-[11.5px] leading-[1.5] tabular-nums break-words whitespace-pre-wrap text-muted-foreground"
              data-testid="spec-update-response"
            >
              {response}
            </pre>
          </div>
        )}

        {status === "failed" && error && (
          <pre
            className="max-h-[140px] overflow-y-auto rounded-[10px] bg-muted p-[10px] font-mono text-[11.5px] leading-[1.5] tabular-nums break-words whitespace-pre-wrap text-destructive"
            data-testid="spec-update-error"
          >
            {error}
          </pre>
        )}
      </SurfaceCard>
    </div>
  );
}
