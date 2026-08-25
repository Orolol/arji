import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Routine } from "@/lib/db/schema";

const buildRouteMocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/app/api/projects/[projectId]/build/route", () => ({
  POST: buildRouteMocks.post,
}));

import {
  defaultRoutineActionDeps,
  executeRoutineAction,
  type RoutineActionDeps,
} from "@/lib/routines/actions";

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    projectId: "project-1",
    kind: "night_run",
    enabled: true,
    timeOfDay: "02:00",
    config: "{}",
    lastRunAt: null,
    lastStatus: null,
    ...overrides,
  };
}

function deps(): RoutineActionDeps {
  return {
    listNightRunEpicIds: vi.fn(() => ["epic-1", "epic-2"]),
    launchNightRun: vi.fn(async () => ({
      batchId: "night-1",
      totalEpics: 2,
      waves: 2,
    })),
    isGitHubIssueSyncDue: vi.fn(() => true),
    syncProjectGitHubIssues: vi.fn(async () => ({ synced: 3 })),
  };
}

describe("executeRoutineAction", () => {
  let actionDeps: RoutineActionDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    actionDeps = deps();
  });

  it("starts Night Run through the canonical DAG pipeline request", async () => {
    const row = routine({
      config: JSON.stringify({
        includeBacklog: true,
        failurePolicy: "stop",
        namedAgentId: "agent-1",
        circuitBreaker: 4,
        costCapUsd: 12.5,
      }),
    });

    const result = await executeRoutineAction(row, actionDeps);

    expect(actionDeps.listNightRunEpicIds).toHaveBeenCalledWith("project-1", [
      "todo",
      "backlog",
    ]);
    expect(actionDeps.launchNightRun).toHaveBeenCalledWith("project-1", {
      epicIds: ["epic-1", "epic-2"],
      mode: "dag",
      pipeline: true,
      failurePolicy: "stop",
      namedAgentId: "agent-1",
      circuitBreaker: 4,
      costCapUsd: 12.5,
    });
    expect(result).toEqual({
      status: "completed",
      message: "Night run night-1 started for 2 epics across 2 waves.",
      targetUrl: "/projects/project-1?nightRun=night-1",
    });
  });

  it("skips Night Run cleanly when no eligible ticket exists", async () => {
    vi.mocked(actionDeps.listNightRunEpicIds).mockReturnValue([]);

    const result = await executeRoutineAction(routine(), actionDeps);

    expect(result.status).toBe("skipped");
    expect(actionDeps.launchNightRun).not.toHaveBeenCalled();
  });

  it("hands the default Night Run action to the existing build route", async () => {
    buildRouteMocks.post.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { batchId: "night-canonical", totalEpics: 1, waves: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const realHandoffDeps: RoutineActionDeps = {
      ...defaultRoutineActionDeps,
      listNightRunEpicIds: vi.fn(() => ["epic-1"]),
    };

    const result = await executeRoutineAction(routine(), realHandoffDeps);

    expect(buildRouteMocks.post).toHaveBeenCalledTimes(1);
    const [request, context] = buildRouteMocks.post.mock.calls[0] as [
      Request,
      { params: Promise<{ projectId: string }> },
    ];
    expect(await request.json()).toEqual({
      epicIds: ["epic-1"],
      mode: "dag",
      pipeline: true,
      failurePolicy: "halt",
      namedAgentId: null,
    });
    await expect(context.params).resolves.toEqual({ projectId: "project-1" });
    expect(result.targetUrl).toContain("night-canonical");
  });

  it("uses the existing GitHub issue-sync TTL before forcing a sync", async () => {
    const row = routine({
      kind: "github_issue_sync",
      config: JSON.stringify({ intervalMinutes: 30 }),
    });

    const result = await executeRoutineAction(row, actionDeps);

    expect(actionDeps.isGitHubIssueSyncDue).toHaveBeenCalledWith(
      "project-1",
      30
    );
    expect(actionDeps.syncProjectGitHubIssues).toHaveBeenCalledWith("project-1");
    expect(result.status).toBe("completed");
    expect(result.message).toContain("3 open GitHub issues");
  });

  it("does not duplicate a GitHub issue sync while its TTL is fresh", async () => {
    vi.mocked(actionDeps.isGitHubIssueSyncDue).mockReturnValue(false);
    const row = routine({ kind: "github_issue_sync" });

    const result = await executeRoutineAction(row, actionDeps);

    expect(result.status).toBe("skipped");
    expect(actionDeps.syncProjectGitHubIssues).not.toHaveBeenCalled();
  });
});
