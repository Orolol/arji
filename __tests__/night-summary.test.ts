/**
 * Tests for the night-run summary layer:
 *
 *   - migration 0026: agent_sessions.batch_run_id exists on the migrated
 *     test schema and round-trips through drizzle,
 *   - cost queries: SUM by batch_run_id, NULL costs → costIsPartial,
 *   - computeNightRunDetail: registry-sourced detail vs DB-derived
 *     (interrupted) detail with the per-epic last-session status mapping,
 *   - listNightRuns: registry + DB-derived merge, LIKE-underscore false
 *     positives excluded,
 *   - buildNightRunSummaryTitle formatting matrix,
 *   - webhook payload extension (night_run.completed + summary field),
 *   - the two GET night-runs routes ({ data } envelope, 404s).
 */
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db, sqlite } = await import("@/lib/db");
const { projects, epics, agentSessions } = await import("@/lib/db/schema");
const {
  computeNightRunDetail,
  listNightRuns,
  sumNightRunCost,
  isNightRunCostPartial,
} = await import("@/lib/night/summary");
const { nightRunRegistry } = await import("@/lib/night/registry");
const { buildNightRunSummaryTitle } = await import("@/lib/notifications/create");
const { buildWebhookPayload } = await import("@/lib/webhooks/send");
const { GET: listRoute } = await import(
  "@/app/api/projects/[projectId]/build/night-runs/route"
);
const { GET: detailRoute } = await import(
  "@/app/api/projects/[projectId]/build/night-runs/[runId]/route"
);
const { mockNextRequest, mockRouteContext } = await import(
  "@/__tests__/helpers/db-mock"
);
import type { TicketExecutionStatus } from "@/lib/dependencies/scheduler";

let counter = 0;

function seedProject(): string {
  counter += 1;
  const projectId = `proj-summary-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: `Summary ${counter}`, gitRepoPath: "/r" })
    .run();
  return projectId;
}

function seedEpic(projectId: string, epicId: string, readableId: string) {
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: `Title ${epicId}`,
      status: "todo",
      position: 0,
      readableId,
    })
    .run();
}

function insertSession(input: {
  id: string;
  projectId: string;
  epicId?: string | null;
  status?: string;
  outcome?: string | null;
  batchRunId?: string | null;
  totalCostUsd?: number | null;
  createdAt?: string;
  completedAt?: string | null;
  agentType?: string;
}) {
  db.insert(agentSessions)
    .values({
      id: input.id,
      projectId: input.projectId,
      epicId: input.epicId ?? null,
      status: input.status ?? "completed",
      outcome: input.outcome ?? null,
      batchRunId: input.batchRunId ?? null,
      totalCostUsd: input.totalCostUsd ?? null,
      createdAt: input.createdAt ?? "2026-08-17T02:00:00.000Z",
      completedAt: input.completedAt ?? null,
      agentType: input.agentType ?? "build",
      mode: "code",
    })
    .run();
}

function fullCounts(
  partial: Partial<Record<TicketExecutionStatus, number>>
): Record<TicketExecutionStatus, number> {
  return {
    pending: 0,
    running: 0,
    done: 0,
    asked: 0,
    failed: 0,
    skipped: 0,
    ...partial,
  };
}

describe("migration 0026", () => {
  it("agent_sessions.batch_run_id exists and round-trips", () => {
    const projectId = seedProject();
    const columns = sqlite
      .prepare("SELECT name FROM pragma_table_info('agent_sessions')")
      .all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("batch_run_id");

    insertSession({
      id: `mig-${counter}`,
      projectId,
      batchRunId: "night_mig",
    });
    // Round-trip through drizzle (schema column) and raw SQL (real column).
    const row = db
      .select({ batchRunId: agentSessions.batchRunId })
      .from(agentSessions)
      .where(eq(agentSessions.id, `mig-${counter}`))
      .get();
    expect(row?.batchRunId).toBe("night_mig");
    const raw = sqlite
      .prepare("SELECT batch_run_id FROM agent_sessions WHERE id = ?")
      .get(`mig-${counter}`) as { batch_run_id: string };
    expect(raw.batch_run_id).toBe("night_mig");
  });
});

describe("cost queries", () => {
  it("sums costs by batch_run_id and flags NULL costs as partial", () => {
    const projectId = seedProject();
    const runId = `night_cost_${counter}`;
    insertSession({ id: `c1-${counter}`, projectId, batchRunId: runId, totalCostUsd: 1.5 });
    insertSession({ id: `c2-${counter}`, projectId, batchRunId: runId, totalCostUsd: 2.25 });
    insertSession({ id: `c3-${counter}`, projectId, batchRunId: null, totalCostUsd: 99 });

    expect(sumNightRunCost(runId)).toBeCloseTo(3.75);
    expect(isNightRunCostPartial(runId)).toBe(false);

    insertSession({ id: `c4-${counter}`, projectId, batchRunId: runId, totalCostUsd: null });
    expect(sumNightRunCost(runId)).toBeCloseTo(3.75);
    expect(isNightRunCostPartial(runId)).toBe(true);

    expect(sumNightRunCost("night_unknown")).toBe(0);
  });
});

describe("computeNightRunDetail", () => {
  it("serves registry snapshots enriched with labels, sessions, and cost", () => {
    const projectId = seedProject();
    const runId = `night_reg_${counter}`;
    seedEpic(projectId, `ra-${counter}`, "E-r-1");
    insertSession({
      id: `reg-s1-${counter}`,
      projectId,
      epicId: `ra-${counter}`,
      batchRunId: runId,
      totalCostUsd: 2,
    });

    nightRunRegistry.register({
      runId,
      projectId,
      failurePolicy: "halt",
      breakerThreshold: 3,
      costCapUsd: 10,
      state: "running",
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: null,
      currentWave: 1,
      totalWaves: 2,
      totalEpics: 1,
      counts: fullCounts({ running: 1 }),
      epics: [
        {
          epicId: `ra-${counter}`,
          pipelineRunId: "plr-1",
          status: "running",
          reason: null,
        },
      ],
      stopRequested: false,
      abortReason: null,
      abortedAtWave: null,
    });

    const detail = computeNightRunDetail(runId)!;
    expect(detail).toMatchObject({
      runId,
      projectId,
      source: "registry",
      interrupted: false,
      state: "running",
      failurePolicy: "halt",
      totalWaves: 2,
      currentWave: 1,
      breakerThreshold: 3,
      costCapUsd: 10,
      totalCostUsd: 2,
      costIsPartial: false,
    });
    expect(detail.epics).toHaveLength(1);
    expect(detail.epics[0]).toEqual({
      epicId: `ra-${counter}`,
      readableId: "E-r-1",
      title: `Title ra-${counter}`,
      status: "running",
      reason: null,
      pipelineRunId: "plr-1",
      sessionIds: [`reg-s1-${counter}`],
      costUsd: 2,
    });

    nightRunRegistry.finish(runId);
  });

  it("derives interrupted runs from tagged sessions when the registry forgot them", () => {
    const projectId = seedProject();
    const runId = `night_db_${counter}`;
    const [ea, eb, ec] = [`da-${counter}`, `db-${counter}`, `dc-${counter}`];
    seedEpic(projectId, ea, "E-d-1");
    seedEpic(projectId, eb, "E-d-2");
    seedEpic(projectId, ec, "E-d-3");

    // ea: build + review, last completed+answered → done.
    insertSession({
      id: `d1-${counter}`,
      projectId,
      epicId: ea,
      batchRunId: runId,
      status: "completed",
      outcome: "answered",
      createdAt: "2026-08-17T01:00:00.000Z",
      completedAt: "2026-08-17T01:30:00.000Z",
      totalCostUsd: 1,
    });
    insertSession({
      id: `d2-${counter}`,
      projectId,
      epicId: ea,
      batchRunId: runId,
      status: "completed",
      outcome: "answered",
      createdAt: "2026-08-17T01:31:00.000Z",
      completedAt: "2026-08-17T02:00:00.000Z",
      totalCostUsd: 0.5,
      agentType: "review_code",
    });
    // eb: asked a question.
    insertSession({
      id: `d3-${counter}`,
      projectId,
      epicId: eb,
      batchRunId: runId,
      status: "completed",
      outcome: "asked_question",
      createdAt: "2026-08-17T01:05:00.000Z",
      completedAt: "2026-08-17T01:45:00.000Z",
    });
    // ec: failed by the boot sweep ("orphaned by restart").
    insertSession({
      id: `d4-${counter}`,
      projectId,
      epicId: ec,
      batchRunId: runId,
      status: "failed",
      outcome: "error",
      createdAt: "2026-08-17T01:06:00.000Z",
      completedAt: "2026-08-17T03:00:00.000Z",
    });
    // Forensic: tagged, no epicId — counted in cost, absent from epics.
    insertSession({
      id: `d5-${counter}`,
      projectId,
      epicId: null,
      batchRunId: runId,
      status: "completed",
      outcome: "answered",
      createdAt: "2026-08-17T02:30:00.000Z",
      completedAt: "2026-08-17T02:45:00.000Z",
      totalCostUsd: 0.25,
      agentType: "forensic",
    });

    const detail = computeNightRunDetail(runId)!;
    expect(detail).toMatchObject({
      runId,
      projectId,
      source: "db",
      interrupted: true,
      state: "finished",
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: "2026-08-17T03:00:00.000Z",
      failurePolicy: null,
      totalWaves: null,
      currentWave: null,
      breakerThreshold: null,
      costCapUsd: null,
      abortReason: null,
      counts: fullCounts({ done: 1, asked: 1, failed: 1 }),
      totalCostUsd: 1.75,
      costIsPartial: true,
    });
    expect(detail.epics).toHaveLength(3);
    const byId = new Map(detail.epics.map((e) => [e.epicId, e]));
    expect(byId.get(ea)).toMatchObject({
      status: "done",
      readableId: "E-d-1",
      sessionIds: [`d1-${counter}`, `d2-${counter}`],
      costUsd: 1.5,
      pipelineRunId: null,
    });
    expect(byId.get(eb)).toMatchObject({ status: "asked" });
    expect(byId.get(ec)).toMatchObject({ status: "failed", costUsd: null });
  });

  it("returns null for unknown runs", () => {
    expect(computeNightRunDetail("night_never_happened")).toBeNull();
  });
});

describe("listNightRuns", () => {
  it("merges registry entries with DB-derived interrupted ones, excluding LIKE false positives", () => {
    const projectId = seedProject();

    // Registry-known run.
    const liveId = `night_live_${counter}`;
    nightRunRegistry.register({
      runId: liveId,
      projectId,
      failurePolicy: "halt",
      breakerThreshold: 3,
      costCapUsd: null,
      state: "running",
      startedAt: "2026-08-17T01:00:00.000Z",
      endedAt: null,
      currentWave: 1,
      totalWaves: 1,
      totalEpics: 1,
      counts: fullCounts({ running: 1 }),
      epics: [],
      stopRequested: false,
      abortReason: null,
      abortedAtWave: null,
    });

    // DB-only run (restart-interrupted).
    const deadId = `night_dead_${counter}`;
    insertSession({
      id: `l1-${counter}`,
      projectId,
      batchRunId: deadId,
      status: "failed",
      outcome: "error",
      epicId: null,
    });
    // LIKE '_' wildcard false positive: "nightmare..." matches the SQL
    // pre-filter but is NOT a night run.
    insertSession({
      id: `l2-${counter}`,
      projectId,
      batchRunId: `nightmare_${counter}`,
      status: "completed",
    });

    const entries = listNightRuns(projectId);
    const ids = entries.map((e) => e.runId);
    expect(ids).toContain(liveId);
    expect(ids).toContain(deadId);
    expect(ids).not.toContain(`nightmare_${counter}`);

    const live = entries.find((e) => e.runId === liveId)!;
    expect(live).toMatchObject({
      source: "registry",
      interrupted: false,
      state: "running",
    });
    const dead = entries.find((e) => e.runId === deadId)!;
    expect(dead).toMatchObject({
      source: "db",
      interrupted: true,
      state: "finished",
    });

    nightRunRegistry.finish(liveId);
  });
});

describe("buildNightRunSummaryTitle", () => {
  it("formats the full bucket line with the cost suffix", () => {
    expect(
      buildNightRunSummaryTitle(
        fullCounts({ done: 5, asked: 1, failed: 2, skipped: 1 }),
        4.2,
        false,
        null
      )
    ).toBe("Night run finished: 5 to merge, 1 paused, 2 failed, 1 skipped — $4.20");
  });

  it("omits zero buckets and the cost suffix when nothing was spent", () => {
    expect(buildNightRunSummaryTitle(fullCounts({ done: 3 }), 0, false, null)).toBe(
      "Night run finished: 3 to merge"
    );
  });

  it("marks partial costs with ≥", () => {
    expect(buildNightRunSummaryTitle(fullCounts({ done: 3 }), 1.1, true, null)).toBe(
      "Night run finished: 3 to merge — ≥$1.10"
    );
  });

  it("appends the breaker/cost-cap markers from the abort reason", () => {
    expect(
      buildNightRunSummaryTitle(
        fullCounts({ failed: 3, skipped: 2 }),
        2,
        false,
        "circuit breaker: 3 consecutive pipeline failures"
      )
    ).toBe("Night run finished: 3 failed, 2 skipped — $2.00 — circuit breaker tripped");
    expect(
      buildNightRunSummaryTitle(
        fullCounts({ done: 1, skipped: 1 }),
        9,
        false,
        "cost cap reached: $9.00 of $5.00"
      )
    ).toBe("Night run finished: 1 to merge, 1 skipped — $9.00 — cost cap reached");
    // Other abort reasons add no marker.
    expect(
      buildNightRunSummaryTitle(fullCounts({ failed: 1 }), 0, false, "night engine error")
    ).toBe("Night run finished: 1 failed");
  });
});

describe("webhook payload extension", () => {
  it("carries night_run.completed and copies the summary when non-empty", () => {
    const payload = buildWebhookPayload("p1", "Proj", {
      event: "night_run.completed",
      summary: "Night run finished: 2 to merge — $1.00",
      durationMs: 1234,
      error: null,
      path: "/projects/p1?nightRun=night_x",
    });
    expect(payload).toMatchObject({
      event: "night_run.completed",
      projectId: "p1",
      projectName: "Proj",
      summary: "Night run finished: 2 to merge — $1.00",
      durationMs: 1234,
    });
    expect(payload.url.endsWith("/projects/p1?nightRun=night_x")).toBe(true);
    expect(payload).not.toHaveProperty("error");

    const bare = buildWebhookPayload("p1", "Proj", {
      event: "session.completed",
    });
    expect(bare).not.toHaveProperty("summary");
  });
});

describe("GET night-runs routes", () => {
  it("lists runs inside the { data } envelope and 404s unknown projects", async () => {
    const projectId = seedProject();
    const runId = `night_route_${counter}`;
    insertSession({
      id: `r1-${counter}`,
      projectId,
      batchRunId: runId,
      status: "completed",
      outcome: "answered",
      epicId: null,
    });

    const res = await listRoute(
      mockNextRequest(),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.map((e: { runId: string }) => e.runId)).toContain(runId);

    const missing = await listRoute(
      mockNextRequest(),
      mockRouteContext({ projectId: "nope" })
    );
    expect(missing.status).toBe(404);
  });

  it("serves the detail and 404s unknown runs or cross-project reads", async () => {
    const projectId = seedProject();
    const runId = `night_route_d_${counter}`;
    seedEpic(projectId, `re-${counter}`, "E-rt-1");
    insertSession({
      id: `r2-${counter}`,
      projectId,
      epicId: `re-${counter}`,
      batchRunId: runId,
      status: "completed",
      outcome: "answered",
    });

    const res = await detailRoute(
      mockNextRequest(),
      mockRouteContext({ projectId, runId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({
      runId,
      projectId,
      source: "db",
      interrupted: true,
    });
    expect(json.data.epics[0]).toMatchObject({ status: "done" });

    const unknown = await detailRoute(
      mockNextRequest(),
      mockRouteContext({ projectId, runId: "night_missing" })
    );
    expect(unknown.status).toBe(404);

    // A run from another project must 404 too.
    const otherProject = seedProject();
    const cross = await detailRoute(
      mockNextRequest(),
      mockRouteContext({ projectId: otherProject, runId })
    );
    expect(cross.status).toBe(404);
  });
});
