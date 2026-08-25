import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics, type Routine } from "@/lib/db/schema";
import {
  isGitHubIssueSyncDue,
  syncProjectGitHubIssues,
} from "@/lib/github/issues";
import { runCiWatchRoutine } from "@/lib/routines/ci-watch";

/** Result persisted and surfaced by the routine scheduler. */
export interface RoutineActionResult {
  status: "completed" | "skipped";
  message: string;
  targetUrl: string;
  /**
   * Daily actions omit this and notify every trigger. High-frequency polling
   * actions may suppress a quiet result while retaining lastRunAt/lastStatus
   * and the scheduler log entry.
   */
  shouldNotify?: boolean;
}

interface NightRunRequest {
  epicIds: string[];
  mode: "dag";
  pipeline: true;
  failurePolicy: "halt" | "stop";
  namedAgentId: string | null;
  circuitBreaker?: number;
  costCapUsd?: number;
}

export interface RoutineActionDeps {
  listNightRunEpicIds(
    projectId: string,
    statuses: Array<"todo" | "backlog">,
  ): string[];
  launchNightRun(
    projectId: string,
    request: NightRunRequest,
  ): Promise<{
    batchId: string;
    totalEpics: number;
    waves: number;
  }>;
  isGitHubIssueSyncDue(projectId: string, intervalMinutes: number): boolean;
  syncProjectGitHubIssues(projectId: string): Promise<{ synced: number }>;
  runCiWatch(routine: Routine): Promise<RoutineActionResult>;
}

/**
 * Invoke the existing batch-build route in its canonical Night Run mode.
 * Keeping the hand-off here means scheduled runs receive the exact same
 * repository, workflow, concurrency, dependency and active-run guards as a
 * run started from the dialog.
 */
async function launchNightRunThroughBuildRoute(
  projectId: string,
  requestBody: NightRunRequest,
): Promise<{ batchId: string; totalEpics: number; waves: number }> {
  const [{ NextRequest }, { POST }] = await Promise.all([
    import("next/server"),
    import("@/app/api/projects/[projectId]/build/route"),
  ]);
  const request = new NextRequest(
    `http://localhost/api/projects/${encodeURIComponent(projectId)}/build`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
  );
  const response = await POST(request, {
    params: Promise.resolve({ projectId }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    data?: { batchId?: string; totalEpics?: number; waves?: number };
  };

  if (!response.ok || payload.error) {
    throw new Error(payload.error || "Failed to start the night run");
  }

  const batchId = payload.data?.batchId;
  if (!batchId) {
    throw new Error("Night run started without a batch id");
  }
  return {
    batchId,
    totalEpics: Number(payload.data?.totalEpics ?? requestBody.epicIds.length),
    waves: Number(payload.data?.waves ?? 0),
  };
}

export const defaultRoutineActionDeps: RoutineActionDeps = {
  listNightRunEpicIds: (projectId, statuses) =>
    db
      .select({ id: epics.id })
      .from(epics)
      .where(
        and(eq(epics.projectId, projectId), inArray(epics.status, statuses)),
      )
      .orderBy(epics.position)
      .all()
      .map((row) => row.id),
  launchNightRun: launchNightRunThroughBuildRoute,
  isGitHubIssueSyncDue,
  syncProjectGitHubIssues,
  runCiWatch: runCiWatchRoutine,
};

function parseConfig(
  routine: Pick<Routine, "id" | "config">,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(routine.config) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Routine ${routine.id} has invalid config: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }
}

function optionalBoolean(
  config: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`Routine config.${key} must be a boolean`);
  }
  return value;
}

function parseNightRunRequest(
  routine: Routine,
  deps: RoutineActionDeps,
): NightRunRequest | null {
  const config = parseConfig(routine);
  const includeBacklog = optionalBoolean(config, "includeBacklog", false);
  const statuses: Array<"todo" | "backlog"> = includeBacklog
    ? ["todo", "backlog"]
    : ["todo"];
  const epicIds = deps.listNightRunEpicIds(routine.projectId, statuses);
  if (epicIds.length === 0) return null;

  const failurePolicy = config.failurePolicy ?? "halt";
  if (failurePolicy !== "halt" && failurePolicy !== "stop") {
    throw new Error("Routine config.failurePolicy must be 'halt' or 'stop'");
  }

  const namedAgentId = config.namedAgentId ?? null;
  if (namedAgentId !== null && typeof namedAgentId !== "string") {
    throw new Error("Routine config.namedAgentId must be a string or null");
  }

  const request: NightRunRequest = {
    epicIds,
    mode: "dag",
    pipeline: true,
    failurePolicy,
    namedAgentId,
  };

  if (config.circuitBreaker !== undefined) {
    if (
      !Number.isInteger(config.circuitBreaker) ||
      (config.circuitBreaker as number) < 0 ||
      (config.circuitBreaker as number) > 10
    ) {
      throw new Error(
        "Routine config.circuitBreaker must be an integer between 0 and 10",
      );
    }
    request.circuitBreaker = config.circuitBreaker as number;
  }

  if (config.costCapUsd !== undefined) {
    if (
      typeof config.costCapUsd !== "number" ||
      !Number.isFinite(config.costCapUsd) ||
      config.costCapUsd <= 0
    ) {
      throw new Error("Routine config.costCapUsd must be a positive number");
    }
    request.costCapUsd = config.costCapUsd;
  }

  return request;
}

async function runNightRoutine(
  routine: Routine,
  deps: RoutineActionDeps,
): Promise<RoutineActionResult> {
  const request = parseNightRunRequest(routine, deps);
  if (!request) {
    return {
      status: "skipped",
      message: "No eligible To Do epics were available for the night run.",
      targetUrl: `/projects/${routine.projectId}`,
    };
  }

  const result = await deps.launchNightRun(routine.projectId, request);
  return {
    status: "completed",
    message: `Night run ${result.batchId} started for ${result.totalEpics} epic${
      result.totalEpics === 1 ? "" : "s"
    } across ${result.waves} wave${result.waves === 1 ? "" : "s"}.`,
    targetUrl: `/projects/${routine.projectId}?nightRun=${encodeURIComponent(
      result.batchId,
    )}`,
  };
}

async function runGitHubIssueSyncRoutine(
  routine: Routine,
  deps: RoutineActionDeps,
): Promise<RoutineActionResult> {
  const config = parseConfig(routine);
  const configuredInterval = config.intervalMinutes ?? 15;
  if (
    !Number.isInteger(configuredInterval) ||
    (configuredInterval as number) < 1
  ) {
    throw new Error(
      "Routine config.intervalMinutes must be a positive integer",
    );
  }
  const intervalMinutes = configuredInterval as number;

  if (!deps.isGitHubIssueSyncDue(routine.projectId, intervalMinutes)) {
    return {
      status: "skipped",
      message: `GitHub issue sync is still fresh (TTL ${intervalMinutes} minutes).`,
      targetUrl: `/projects/${routine.projectId}/github-issues`,
    };
  }

  const result = await deps.syncProjectGitHubIssues(routine.projectId);
  return {
    status: "completed",
    message: `Synchronized ${result.synced} open GitHub issue${
      result.synced === 1 ? "" : "s"
    }.`,
    targetUrl: `/projects/${routine.projectId}/github-issues`,
  };
}

/** Execute one currently supported routine kind through its canonical service. */
export async function executeRoutineAction(
  routine: Routine,
  deps: RoutineActionDeps = defaultRoutineActionDeps,
): Promise<RoutineActionResult> {
  switch (routine.kind) {
    case "night_run":
      return runNightRoutine(routine, deps);
    case "github_issue_sync":
      return runGitHubIssueSyncRoutine(routine, deps);
    case "ci_watch":
      return deps.runCiWatch(routine);
    case "dreaming":
      throw new Error(`Routine kind ${routine.kind} is not available yet`);
  }
}
