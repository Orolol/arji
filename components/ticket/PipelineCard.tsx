"use client";

/**
 * PIPELINE — the white card at the top of the right rail (frame 6a, 275-286).
 *
 * "Pipeline" is the one label in the overlay that is plain ink with no
 * underline: it sits on a white card, not a stratum ground, so it does not go
 * through `BandHeader`.
 *
 * The chain's 2px pending rings and connectors are the design's sanctioned
 * exception to the 1.5px border rule — at a 20px marker, 1.5px does not read.
 * `PipelineChain` owns that; nothing here restyles it.
 */

import { PipelineChain, SurfaceCard, type PipelineStep } from "@/components/piscine";
import { StatusControl } from "@/components/ticket/StatusControl";

export interface PipelineCardProps {
  steps: PipelineStep[];
  status: string;
  priority: number;
  hasRunningSession: boolean;
  statusError: string | null;
  onStatusChange: (next: string) => void;
  onPriorityChange: (next: number) => void;
}

export function PipelineCard({
  steps,
  status,
  priority,
  hasRunningSession,
  statusError,
  onStatusChange,
  onPriorityChange,
}: PipelineCardProps) {
  return (
    <SurfaceCard
      radius={12}
      className="flex shrink-0 flex-col gap-[9px] px-4 py-[13px]"
      data-testid="ticket-pipeline"
    >
      <div className="flex items-baseline gap-[10px]">
        <span className="font-display text-[12px] font-bold uppercase tracking-[.1em] text-foreground">
          Pipeline
        </span>
        <StatusControl
          status={status}
          priority={priority}
          hasRunningSession={hasRunningSession}
          onStatusChange={onStatusChange}
          onPriorityChange={onPriorityChange}
        />
      </div>

      <PipelineChain steps={steps} orientation="horizontal" markerSize={20} />

      {/* The workflow engine is the source of truth; its rejection lands
          here, next to the control that produced it. */}
      {statusError ? (
        <p
          data-testid="ticket-status-error"
          className="m-0 text-[12px] leading-[1.5] text-destructive"
        >
          {statusError}
        </p>
      ) : null}
    </SurfaceCard>
  );
}
