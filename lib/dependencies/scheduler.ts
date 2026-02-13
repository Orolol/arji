import { topologicalSort, loadProjectGraph } from "@/lib/dependencies/validation";

export type TicketExecutionStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export interface BatchExecutionPlan {
  /** Topological layers — tickets in the same layer can run concurrently */
  layers: string[][];
  /** Per-ticket execution state */
  ticketStatus: Map<string, TicketExecutionStatus>;
}

export interface LayerResult {
  epicId: string;
  success: boolean;
  sessionId: string;
  error?: string;
}

/**
 * Build a DAG-aware execution plan for a set of ticket IDs.
 * Returns topological layers and an initial status map (all pending).
 */
export function buildExecutionPlan(
  projectId: string,
  ticketIds: string[]
): BatchExecutionPlan {
  const layers = topologicalSort(projectId, ticketIds);
  const ticketStatus = new Map<string, TicketExecutionStatus>();
  for (const id of ticketIds) {
    ticketStatus.set(id, "pending");
  }
  return { layers, ticketStatus };
}

/**
 * Execute a batch of tickets layer-by-layer respecting dependencies.
 *
 * - All tickets in a layer are launched concurrently via `launchFn`.
 * - The scheduler waits for the entire layer to finish before proceeding.
 * - If a ticket fails, its transitive dependents are marked `skipped`.
 * - Independent branches continue executing.
 *
 * @param projectId - The project to load dependency graph from.
 * @param plan - The execution plan from `buildExecutionPlan`.
 * @param launchFn - Launches one epic; returns a promise resolving to success/failure.
 * @param onStatusChange - Optional callback invoked whenever a ticket status changes.
 * @returns Map of ticketId → final execution status.
 */
export async function executeDagPlan(
  projectId: string,
  plan: BatchExecutionPlan,
  launchFn: (epicId: string) => Promise<LayerResult>,
  onStatusChange?: (
    epicId: string,
    status: TicketExecutionStatus,
    error?: string
  ) => void
): Promise<Map<string, TicketExecutionStatus>> {
  const { layers, ticketStatus } = plan;

  function setStatus(
    epicId: string,
    status: TicketExecutionStatus,
    error?: string
  ) {
    ticketStatus.set(epicId, status);
    onStatusChange?.(epicId, status, error);
  }

  // Load dependency graph to know prerequisites
  const graph = loadProjectGraph(projectId);

  // For each ticket, check if any prerequisite has failed/skipped
  function hasFailedPrerequisite(ticketId: string): boolean {
    const deps = graph.get(ticketId);
    if (!deps) return false;
    for (const dep of deps) {
      const status = ticketStatus.get(dep);
      if (status === "failed" || status === "skipped") {
        return true;
      }
    }
    return false;
  }

  for (const layer of layers) {
    const launchable: string[] = [];
    for (const epicId of layer) {
      if (hasFailedPrerequisite(epicId)) {
        setStatus(epicId, "skipped", "Prerequisite failed");
      } else {
        launchable.push(epicId);
      }
    }

    if (launchable.length === 0) continue;

    // Mark all launchable as running
    for (const epicId of launchable) {
      setStatus(epicId, "running");
    }

    // Launch concurrently and wait for all to settle
    const results = await Promise.allSettled(
      launchable.map((epicId) => launchFn(epicId))
    );

    for (let i = 0; i < launchable.length; i++) {
      const epicId = launchable[i];
      const result = results[i];

      if (result.status === "fulfilled") {
        if (result.value.success) {
          setStatus(epicId, "done");
        } else {
          setStatus(epicId, "failed", result.value.error);
        }
      } else {
        setStatus(
          epicId,
          "failed",
          result.reason instanceof Error
            ? result.reason.message
            : "Unknown error"
        );
      }
    }
  }

  return ticketStatus;
}
