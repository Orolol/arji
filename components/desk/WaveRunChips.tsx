"use client";

import { useCallback, useState } from "react";
import { Layers, Moon, Square } from "lucide-react";

import { Mono, PillButton } from "@/components/piscine";
import { usePolling } from "@/hooks/usePolling";
import { stopNightRun } from "@/hooks/useNightRuns";
import { isNightRunId } from "@/lib/night/constants";

/**
 * DAG-wave and night-run state, in WORKING's header.
 *
 * These three things — the wave counter, the night-run marker, and "Stop night
 * run" — used to live in `components/monitor/AgentMonitor`, the pre-redesign
 * bar at the bottom of the project board. Its session list duplicated WORKING,
 * but these did not exist anywhere else, so they move here rather than
 * disappear with it.
 *
 * WHY THE BAND'S DOC COMMENT SAID THIS WAS IMPOSSIBLE: it is, on "/" — night
 * runs are per-project and live in an in-process registry with no durable row
 * to aggregate across projects. On a PROJECT desk there is a project id, and
 * `/api/projects/:id/build/waves` is exactly the registry read AgentMonitor
 * used. So the chips render only when a `projectId` is given, and the global
 * desk keeps its documented omission.
 *
 * COLOUR IS NOT STATE. AgentMonitor painted the wave chip sky-blue and the
 * night chip indigo; here both are mono in the stratum's own tone and the ICON
 * plus the WORD carry the distinction, per the system's rule.
 *
 * POLLING IS NOT GATED ON LIVE WORK. It briefly was (`active` = "WORKING has a
 * running or queued session"), which matched AgentMonitor's own mount
 * condition — but it took "Stop night run" off screen exactly when a run had
 * no session in flight: between two epics, and in the seconds after a failure,
 * which is the moment a user most wants to stop it. The endpoint reads an
 * in-process Map and answers `[]` when idle, so polling on `projectId` alone
 * costs nothing and the chips already render nothing on an empty list.
 */

/** Subset of DagBatchSnapshot the indicator renders. */
interface WaveBatch {
  batchId: string;
  currentWave: number;
  totalWaves: number;
}

export interface WaveRunChipsProps {
  /** Omit on the cross-project desk: there is no single registry to read. */
  projectId?: string;
}

export function WaveRunChips({ projectId }: WaveRunChipsProps) {
  const [batches, setBatches] = useState<WaveBatch[]>([]);
  /** Night run ids the user already asked to stop (local echo). */
  const [stopped, setStopped] = useState<string[]>([]);

  const poll = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/build/waves`);
      const json = await res.json();
      setBatches(Array.isArray(json.data) ? json.data : []);
    } catch {
      // Best-effort: the registry is in-process and an empty list simply
      // hides the chips.
    }
  }, [projectId]);

  usePolling(poll, 3000, Boolean(projectId));

  if (!projectId || batches.length === 0) return null;

  // At most one night run is active per project (route guard), so a single
  // stop control is correct.
  const nightBatch = batches.find((batch) => isNightRunId(batch.batchId));

  const handleStop = async (runId: string) => {
    setStopped((prev) => (prev.includes(runId) ? prev : [...prev, runId]));
    await stopNightRun(projectId, runId);
    // No refetch: the poller keeps running and the chip vanishes once the
    // engine closes the run.
  };

  return (
    <div className="flex items-center gap-[10px]">
      {batches.map((batch) => {
        const isNight = isNightRunId(batch.batchId);
        const WaveIcon = isNight ? Moon : Layers;
        return (
          <span
            key={batch.batchId}
            data-testid={`desk-wave-${batch.batchId}`}
            data-night={isNight ? "true" : undefined}
            className="flex shrink-0 items-center gap-1"
            title={
              isNight
                ? "Night run: dependency waves, each epic chained through the autonomous pipeline"
                : "DAG batch build: dependency waves run in order"
            }
          >
            <WaveIcon size={11} aria-hidden="true" className="text-strata-live-deep" />
            <Mono size={10.5} tone="live-deep" uppercase tracking={0.06}>
              {`${isNight ? "Night wave" : "Wave"} ${Math.max(batch.currentWave, 1)}/${batch.totalWaves}`}
            </Mono>
          </span>
        );
      })}

      {nightBatch ? (
        <PillButton
          variant="outline"
          outlineTone="neutral"
          size="sm"
          icon={Square}
          data-testid="desk-night-stop"
          disabled={stopped.includes(nightBatch.batchId)}
          onClick={() => void handleStop(nightBatch.batchId)}
          title="Stop the night run: no new epic is launched. Epics already running finish their pipeline."
        >
          {stopped.includes(nightBatch.batchId) ? "Stopping…" : "Stop night run"}
        </PillButton>
      ) : null}
    </div>
  );
}
