"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Brain,
  ClipboardCheck,
  Hammer,
  Search,
  GitMerge,
  MessageSquare,
  Sparkles,
  FileText,
  StopCircle,
  ChevronUp,
  ChevronDown,
  Clock,
  Layers,
  ListOrdered,
  Loader2,
  Moon,
  Square,
  Workflow,
} from "lucide-react";
import {
  isChatProvider,
  PROVIDER_LABELS,
} from "@/lib/agent-config/constants";
import { isNightRunId } from "@/lib/night/constants";
import { stopNightRun } from "@/hooks/useNightRuns";
import { Button } from "@/components/ui/button";
import { formatElapsed } from "@/lib/utils/format-elapsed";
import { usePolling } from "@/hooks/usePolling";
import type { UnifiedActivity } from "@/hooks/useAgentPolling";
import { pipelineChipLabel, usePipelineRuns } from "@/hooks/usePipelineRuns";

/** Subset of DagBatchSnapshot the wave indicator renders. */
interface WaveBatchIndicator {
  batchId: string;
  currentWave: number;
  totalWaves: number;
}

interface AgentMonitorProps {
  projectId: string;
  activities: UnifiedActivity[];
  highlightedActivityId?: string | null;
}

/**
 * Compact provider chip. Claude Code keeps its abbreviation because it
 * dominates the monitor; everything else shows its real label. Sessions from
 * providers removed in the 2026-08 cleanup fall through to their raw stored
 * string.
 */
function providerLabel(provider: string): string {
  if (provider === "claude-code") return "CC";
  return isChatProvider(provider) ? PROVIDER_LABELS[provider] : provider;
}

/**
 * Whole minutes since the session last produced output. Rendered in the
 * stalled tooltip; recomputed on every elapsed tick, so it stays current.
 */
function minutesSince(lastActivityAt: string, now: Date): number {
  const last = Date.parse(lastActivityAt);
  if (Number.isNaN(last)) return 0;
  return Math.max(0, Math.floor((now.getTime() - last) / 60_000));
}

const typeIcons: Record<UnifiedActivity["type"], typeof Hammer> = {
  build: Hammer,
  review: Search,
  merge: GitMerge,
  chat: MessageSquare,
  spec_generation: Sparkles,
  release: FileText,
  memory: Brain,
  qa: ClipboardCheck,
  grading: ClipboardCheck,
  refinement: ListOrdered,
};

export function AgentMonitor({
  projectId,
  activities,
  highlightedActivityId = null,
}: AgentMonitorProps) {
  const [expanded, setExpanded] = useState(true);
  const [elapsed, setElapsed] = useState<Record<string, string>>({});
  const [waveBatches, setWaveBatches] = useState<WaveBatchIndicator[]>([]);
  /** Night run ids the user already asked to stop (local echo). */
  const [stoppedRuns, setStoppedRuns] = useState<string[]>([]);

  // Active DAG batch builds ("Build by waves") — the registry only lists
  // running batches, so an empty array simply hides the indicator.
  const pollWaves = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/build/waves`);
      const json = await res.json();
      setWaveBatches(Array.isArray(json.data) ? json.data : []);
    } catch {
      // ignore — indicator is best-effort
    }
  }, [projectId]);
  usePolling(pollWaves, 3000, activities.length > 0);

  // Sessions owned by an autonomous pipeline run get a "Pipeline · <stage>"
  // chip so a session nobody dispatched by hand is explicable at a glance.
  const { sessionIndex: pipelineSessions } = usePipelineRuns(
    projectId,
    activities.length > 0
  );

  useEffect(() => {
    if (activities.length === 0) return;

    function updateElapsed() {
      const now = new Date();
      const newElapsed: Record<string, string> = {};
      for (const a of activities) {
        if (a.startedAt) {
          newElapsed[a.id] = formatElapsed(a.startedAt, now);
        }
      }
      setElapsed(newElapsed);
    }

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [activities]);

  if (activities.length === 0) return null;

  async function handleCancel(activityId: string) {
    await fetch(`/api/projects/${projectId}/sessions/${activityId}`, {
      method: "DELETE",
    });
  }

  // At most one night run is active per project (route guard), so the header
  // gets a single stop control next to the moon chip.
  const nightBatch = waveBatches.find((batch) => isNightRunId(batch.batchId));

  async function handleStopNight(runId: string) {
    setStoppedRuns((prev) => (prev.includes(runId) ? prev : [...prev, runId]));
    await stopNightRun(projectId, runId);
    // No refetch needed: the wave poller keeps running and the chip vanishes
    // once the engine closes the run.
  }

  // Running agents first; queued ones wait below them, mirroring the
  // scheduler's actual order of execution.
  const runningActivities = activities.filter((a) => a.status !== "queued");
  const queuedActivities = activities.filter((a) => a.status === "queued");
  const orderedActivities = [...runningActivities, ...queuedActivities];

  return (
    <div className="border-t border-border bg-muted/30">
      {/*
        One header row, three interactive zones: the label toggles the list,
        the wave/night chips sit inline (plus the night run's stop control —
        a button, so it CANNOT be nested inside the toggle button), and the
        chevron toggles as well.
      */}
      <div className="w-full px-4 py-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 min-w-0 hover:text-foreground"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="font-medium">
            {runningActivities.length} active agent
            {runningActivities.length !== 1 ? "s" : ""}
            {queuedActivities.length > 0 &&
              ` · ${queuedActivities.length} queued`}
          </span>
        </button>
        {waveBatches.map((batch) => {
          // A night run registers under the same wave registry, so the chip
          // works unchanged — it only swaps its icon and wording to say the
          // waves are running unattended through the pipeline.
          const isNight = isNightRunId(batch.batchId);
          const WaveIcon = isNight ? Moon : Layers;
          return (
            <span
              key={batch.batchId}
              data-testid={`agent-monitor-wave-${batch.batchId}`}
              data-night={isNight ? "true" : undefined}
              className={`flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide shrink-0 ${
                isNight ? "text-indigo-400" : "text-sky-500"
              }`}
              title={
                isNight
                  ? "Night run: dependency waves, each epic chained through the autonomous pipeline"
                  : "DAG batch build: dependency waves run in order"
              }
            >
              <WaveIcon className="h-3 w-3" />
              {isNight ? "Night wave" : "Wave"}{" "}
              {Math.max(batch.currentWave, 1)}/{batch.totalWaves}
            </span>
          );
        })}
        {nightBatch && (
          <button
            type="button"
            data-testid="agent-monitor-night-stop"
            disabled={stoppedRuns.includes(nightBatch.batchId)}
            onClick={() => handleStopNight(nightBatch.batchId)}
            className="flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shrink-0 hover:text-foreground disabled:opacity-50"
            title="Stop the night run: no new epic is launched. Epics already running finish their pipeline."
          >
            <Square className="h-3 w-3" />
            {stoppedRuns.includes(nightBatch.batchId)
              ? "Stopping…"
              : "Stop night run"}
          </button>
        )}
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-auto hover:text-foreground"
          aria-label={expanded ? "Collapse agent list" : "Expand agent list"}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronUp className="h-3 w-3" />
          )}
        </button>
      </div>

      {expanded && (
        <div className="px-4 pb-2 space-y-1">
          {orderedActivities.map((activity) => {
            const isQueued = activity.status === "queued";
            const Icon = isQueued
              ? Clock
              : typeIcons[activity.type] || Loader2;
            const isHighlighted = activity.id === highlightedActivityId;
            const isStale = !isQueued && !!activity.stale;
            const staleTooltip = activity.lastActivityAt
              ? `No output for ${minutesSince(activity.lastActivityAt, new Date())}m`
              : "No output";
            const pipelineInfo = pipelineSessions[activity.id];
            return (
              <div
                key={activity.id}
                data-testid={`agent-monitor-activity-${activity.id}`}
                className={`flex items-center gap-2 text-xs py-1 px-1 rounded-sm transition-colors ${
                  isHighlighted ? "bg-primary/10 ring-1 ring-primary/40" : ""
                } ${isQueued ? "opacity-70" : ""}`}
              >
                <Icon
                  className={`h-3 w-3 shrink-0 ${
                    isQueued || isStale ? "text-amber-500" : "text-green-500"
                  }`}
                />
                <span className="truncate">{activity.label}</span>
                {pipelineInfo && (
                  <span
                    data-testid={`agent-monitor-pipeline-${activity.id}`}
                    className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-violet-400 shrink-0"
                    title="Dispatched by an autonomous pipeline run — stopping this session stops the pipeline"
                  >
                    <Workflow className="h-3 w-3" />
                    {pipelineChipLabel(pipelineInfo)}
                  </span>
                )}
                <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide shrink-0">
                  {activity.namedAgentName || providerLabel(activity.provider)}
                </span>
                {isQueued ? (
                  <span className="text-amber-500 text-[10px] font-medium uppercase tracking-wide shrink-0">
                    queued
                  </span>
                ) : (
                  <>
                    {isStale && (
                      <span
                        data-testid={`agent-monitor-stalled-${activity.id}`}
                        className="text-amber-500 text-[10px] font-medium uppercase tracking-wide shrink-0"
                        title={staleTooltip}
                      >
                        stalled
                      </span>
                    )}
                    <span className="text-muted-foreground font-mono shrink-0">
                      {elapsed[activity.id] || "0s"}
                    </span>
                  </>
                )}
                {activity.cancellable && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-5 w-5 ml-auto shrink-0 hover:text-destructive ${
                      isStale ? "text-amber-500" : "text-muted-foreground"
                    }`}
                    onClick={() => handleCancel(activity.id)}
                    title={isStale ? "Stop session" : "Cancel"}
                  >
                    <StopCircle className="h-3 w-3" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
