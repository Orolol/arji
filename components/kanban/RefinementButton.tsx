"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ListOrdered, Loader2 } from "lucide-react";
import { RefinementDialog } from "./RefinementDialog";
import type { RefinementOptions } from "@/lib/refinement/options";
import { cn } from "@/lib/utils";
import type { RefinementStatus } from "@/app/api/projects/[projectId]/refinement/route";

interface RefinementButtonProps {
  projectId: string;
  /** Bumped by the page whenever the board changes, to re-read the status. */
  refreshTrigger?: number;
  /** Surfaced through the page's toast rail as a failure. */
  onError: (message: string) => void;
  /**
   * Surfaced as an informational message. "Nothing to refine" arrives on a
   * 200 and is a real answer, not a failure — routing it to onError would
   * show a red toast for a successful request.
   */
  onNotice?: (message: string) => void;
  onStarted?: (sessionId: string) => void;
  /** Called when the pass finishes, so the board can reload. */
  onFinished?: () => void;
  /**
   * Poll cadence while a pass is in flight; 0 disables polling entirely
   * (tests drive refreshTrigger instead).
   */
  pollIntervalMs?: number;
  /**
   * Poll cadence while idle. Much slower on purpose: an idle board only needs
   * to notice a pass someone else started, and this endpoint is hit once per
   * open tab for as long as the board is open.
   */
  idlePollIntervalMs?: number;
}

/**
 * Narrows a status response body to a {@link RefinementStatus}.
 *
 * `{ data }` alone is not enough to go on. This component POSTs to the same
 * URL it polls, and the POST answers `{ data: { started, sessionId } }` — no
 * `running` field. Cast blindly, that reads as `running: undefined`, which is
 * indistinguishable from "the pass ended": the button goes back to idle
 * mid-pass and `onFinished` reloads the board for nothing. A body that does
 * not carry a boolean `running` is not evidence about the pass either way, so
 * it is ignored rather than believed.
 */
function asRefinementStatus(payload: unknown): RefinementStatus | null {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== "object") return null;
  return typeof (data as RefinementStatus).running === "boolean"
    ? (data as RefinementStatus)
    : null;
}

/**
 * Board-toolbar entry point for the Agent Refinement re-pass.
 *
 * The in-flight state is read from the server rather than kept locally: a
 * pass survives this component unmounting (switching tabs, reloading), and a
 * button that forgot about it would happily dispatch a second one. The
 * server refuses that with 409, but the honest UI is a disabled button that
 * knows a pass is running.
 */
export function RefinementButton({
  projectId,
  refreshTrigger = 0,
  onError,
  onNotice,
  onStarted,
  onFinished,
  pollIntervalMs = 5000,
  idlePollIntervalMs = 30000,
}: RefinementButtonProps) {
  const [status, setStatus] = useState<RefinementStatus | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [starting, setStarting] = useState(false);
  const isRunning = status?.running === true;
  /**
   * Previous running flag, kept in a ref rather than read inside a state
   * updater. Updaters must be pure — React double-invokes them under
   * StrictMode (on by default in the App Router), so firing `onFinished`
   * from inside one gives the user two toasts and two board reloads per pass.
   */
  const wasRunning = useRef(false);

  // One effect owns both the initial read and the poll. `onFinished` fires on
  // the running → idle edge so the board reloads once the pass has actually
  // reshaped it.
  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      fetch(`/api/projects/${projectId}/refinement`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          const next = asRefinementStatus(d);
          if (!next) return;
          const finished = wasRunning.current && !next.running;
          wasRunning.current = next.running;
          setStatus(next);
          if (finished) onFinished?.();
        })
        .catch(() => {
          // A failed status read must never break the board toolbar.
        });
    };

    load();
    if (!pollIntervalMs) {
      return () => {
        cancelled = true;
      };
    }

    // Fast only while something is actually happening; an idle board falls
    // back to the slow cadence.
    const timer = setInterval(
      load,
      isRunning ? pollIntervalMs : idlePollIntervalMs
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    projectId,
    refreshTrigger,
    pollIntervalMs,
    idlePollIntervalMs,
    isRunning,
    onFinished,
  ]);

  const start = useCallback(async (options: RefinementOptions) => {
    if (starting || isRunning) return;
    setStarting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/refinement`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        onError(payload?.error ?? "Failed to start board refinement");
        return;
      }
      if (payload?.data?.started === false) {
        // Nothing to refine — a real answer on a 200, not a failure.
        const reason = payload.data.reason ?? "Nothing to refine right now";
        (onNotice ?? onError)(reason);
        setConfiguring(false);
        return;
      }

      setConfiguring(false);
      wasRunning.current = true;
      setStatus({
        running: true,
        sessionId: payload?.data?.sessionId ?? null,
        ticketCount: payload?.data?.ticketCount ?? 0,
      });
      if (payload?.data?.sessionId) onStarted?.(payload.data.sessionId);
    } catch {
      onError("Failed to start board refinement");
    } finally {
      setStarting(false);
    }
  }, [projectId, onError, onNotice, onStarted, starting, isRunning]);

  const running = status?.running === true;
  const busy = running || starting;

  return (
    <>
      <button
        type="button"
        onClick={() => setConfiguring(true)}
        disabled={busy}
        data-testid="refinement-button"
        aria-busy={busy}
        title={
          running
            ? "A board refinement pass is running"
            : "Agent Refinement — re-pass Backlog and To do: questions, priorities, order, dependencies, promotion, merges, discards and missing tickets"
        }
        className={cn(
          "flex shrink-0 items-center gap-[6px] rounded-[7px] border px-[10px] py-[4px] text-[12px] font-medium transition-colors",
          busy
            ? "cursor-not-allowed border-agent-border bg-agent-bg text-agent"
            : "border-border bg-background text-foreground shadow-sm hover:border-agent-border hover:bg-agent-bg/40 hover:text-agent"
        )}
      >
        {busy ? (
          <Loader2
            className="h-[13px] w-[13px] animate-spin"
            data-testid="refinement-button-spinner"
            aria-hidden
          />
        ) : (
          <ListOrdered className="h-[13px] w-[13px]" aria-hidden />
        )}
        Agent Refinement
        {running && (
          <span
            data-testid="refinement-button-badge"
            className="rounded-full bg-agent/10 px-[6px] py-[1px] text-[11px]"
          >
            running
          </span>
        )}
      </button>
      {configuring && (
        <RefinementDialog
          key={projectId}
          open={configuring}
          onOpenChange={setConfiguring}
          running={running}
          starting={starting}
          onStart={start}
        />
      )}
    </>
  );
}
