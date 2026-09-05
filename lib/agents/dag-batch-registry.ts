import type { TicketExecutionStatus } from "@/lib/dependencies/scheduler";
import type { WaveFailurePolicy } from "@/lib/dependencies/wave-runner";

/**
 * In-process registry of active DAG (wave) batch builds.
 *
 * The wave engine runs in the background after the batch build route has
 * responded, so clients need somewhere to read "which wave are we on" from.
 * Like the agent scheduler and the process manager, the singleton lives in
 * module scope and dies with the server process — a batch orphaned by a
 * restart simply disappears from monitors (its already-queued sessions are
 * cancelled by boot cleanup like any other orphan).
 *
 * Exposed to clients via GET /api/projects/[projectId]/build/waves and
 * rendered by `components/desk/WaveRunChips` as a compact "Wave 2/4" indicator
 * in WORKING's header.
 */

export type DagBatchCounts = Record<TicketExecutionStatus, number>;

export interface DagBatchSnapshot {
  batchId: string;
  projectId: string;
  failurePolicy: WaveFailurePolicy;
  /** 1-based wave currently executing (0 until the first wave starts). */
  currentWave: number;
  totalWaves: number;
  totalEpics: number;
  counts: DagBatchCounts;
  startedAt: string;
}

function emptyCounts(): DagBatchCounts {
  return { pending: 0, running: 0, done: 0, asked: 0, failed: 0, skipped: 0 };
}

export class DagBatchRegistry {
  private readonly batches = new Map<string, DagBatchSnapshot>();

  start(input: {
    batchId: string;
    projectId: string;
    failurePolicy: WaveFailurePolicy;
    totalWaves: number;
    totalEpics: number;
  }): DagBatchSnapshot {
    const snapshot: DagBatchSnapshot = {
      ...input,
      currentWave: 0,
      counts: { ...emptyCounts(), pending: input.totalEpics },
      startedAt: new Date().toISOString(),
    };
    this.batches.set(input.batchId, snapshot);
    return snapshot;
  }

  setWave(batchId: string, currentWave: number): void {
    const batch = this.batches.get(batchId);
    if (batch) batch.currentWave = currentWave;
  }

  setCounts(batchId: string, counts: DagBatchCounts): void {
    const batch = this.batches.get(batchId);
    if (batch) batch.counts = { ...counts };
  }

  /** The run is over — remove it from monitors. */
  finish(batchId: string): void {
    this.batches.delete(batchId);
  }

  get(batchId: string): DagBatchSnapshot | null {
    return this.batches.get(batchId) ?? null;
  }

  listByProject(projectId: string): DagBatchSnapshot[] {
    return Array.from(this.batches.values()).filter(
      (batch) => batch.projectId === projectId
    );
  }
}

/**
 * Singleton instance (class exported for isolated unit tests).
 * globalThis-backed like the scheduler/watchdog/terminal-hook singletons: a
 * dev hot reload must not let the running wave engine write to a stale
 * instance while GET /build/waves reads a fresh empty one.
 */
const DAG_REGISTRY_GLOBAL_KEY = Symbol.for("arij.dag-batch-registry");

function getDagBatchRegistry(): DagBatchRegistry {
  const store = globalThis as { [DAG_REGISTRY_GLOBAL_KEY]?: DagBatchRegistry };
  if (!store[DAG_REGISTRY_GLOBAL_KEY]) {
    store[DAG_REGISTRY_GLOBAL_KEY] = new DagBatchRegistry();
  }
  return store[DAG_REGISTRY_GLOBAL_KEY];
}

export const dagBatchRegistry = getDagBatchRegistry();
