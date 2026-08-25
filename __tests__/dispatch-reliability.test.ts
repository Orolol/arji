/**
 * Tests for the dispatch reliability aggregate (lib/agent-config/stats.ts,
 * getNamedAgentDispatchReliability) and the badge formatter
 * (lib/agent-config/dispatch-reliability-constants.ts).
 *
 * One test per acceptance criterion of "Badge de fiabilité dans les
 * sélecteurs d'agents": the 30-day window, the per-role grouping, the median,
 * the em-dash under 5 runs, and the single-pass promise.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions, namedAgents } = await import(
  "@/lib/db/schema"
);
const { getNamedAgentDispatchReliability } = await import(
  "@/lib/agent-config/stats"
);
const {
  AGENT_TYPE_TO_DISPATCH_ROLE,
  DISPATCH_RELIABILITY_MIN_SAMPLE,
  DISPATCH_RELIABILITY_WINDOW_DAYS,
  dispatchRoleForAgentType,
  formatReliabilityBadge,
  formatReliabilityDuration,
} = await import("@/lib/agent-config/dispatch-reliability-constants");
const { AGENT_TYPES } = await import("@/lib/agent-config/constants");

const PROJECT_ID = "proj-reliability";
const OTHER_PROJECT_ID = "proj-other";
/** Window anchor every test measures from. */
const NOW = "2026-08-25T12:00:00.000Z";

let seq = 0;

/** ISO timestamp `daysAgo` days before NOW. */
function daysBeforeNow(daysAgo: number): string {
  return new Date(
    new Date(NOW).getTime() - daysAgo * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function seedAgent(id: string, name: string): void {
  db.insert(namedAgents)
    .values({ id, name, provider: "claude-code", model: "sonnet" })
    .run();
}

function addSession(input: {
  namedAgentId: string | null;
  agentType: string;
  status: string;
  daysAgo?: number;
  /** Wall-clock duration in seconds; omitted leaves started/ended null. */
  durationSec?: number;
  projectId?: string;
  namedAgentName?: string | null;
}): void {
  seq += 1;
  const createdAt = daysBeforeNow(input.daysAgo ?? 1);
  const startedAt = input.durationSec === undefined ? null : createdAt;
  const endedAt =
    input.durationSec === undefined
      ? null
      : new Date(
          new Date(createdAt).getTime() + input.durationSec * 1000,
        ).toISOString();

  db.insert(agentSessions)
    .values({
      id: `sess-${seq}`,
      projectId: input.projectId ?? PROJECT_ID,
      epicId: "epic-1",
      status: input.status,
      agentType: input.agentType,
      namedAgentId: input.namedAgentId,
      namedAgentName:
        input.namedAgentName === undefined ? null : input.namedAgentName,
      createdAt,
      startedAt,
      endedAt,
    })
    .run();
}

/** N terminal runs of which `completed` succeeded. */
function addRuns(input: {
  namedAgentId: string;
  agentType: string;
  completed: number;
  failed?: number;
  daysAgo?: number;
  durationSec?: number;
}): void {
  for (let i = 0; i < input.completed; i += 1) {
    addSession({ ...input, status: "completed" });
  }
  for (let i = 0; i < (input.failed ?? 0); i += 1) {
    addSession({ ...input, status: "failed" });
  }
}

function rowFor(rows: ReturnType<typeof getNamedAgentDispatchReliability>, agentId: string, role: string) {
  return rows.find((row) => row.namedAgentId === agentId && row.role === role);
}

beforeEach(() => {
  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(namedAgents).run();
  db.delete(projects).run();
  seq = 0;

  for (const id of [PROJECT_ID, OTHER_PROJECT_ID]) {
    db.insert(projects)
      .values({ id, name: id, gitRepoPath: `/repos/${id}` })
      .run();
  }
  db.insert(epics)
    .values({
      id: "epic-1",
      projectId: PROJECT_ID,
      title: "Epic",
      status: "in_progress",
      position: 0,
    })
    .run();

  seedAgent("agent-a", "Alpha");
  seedAgent("agent-b", "Beta");
});

describe("getNamedAgentDispatchReliability", () => {
  it("reports success rate and median duration per named agent and task type", () => {
    // 3 completed + 1 failed builds, durations 60/120/180/600s → median 150s.
    addSession({
      namedAgentId: "agent-a",
      agentType: "build",
      status: "completed",
      durationSec: 60,
    });
    addSession({
      namedAgentId: "agent-a",
      agentType: "build",
      status: "completed",
      durationSec: 120,
    });
    addSession({
      namedAgentId: "agent-a",
      agentType: "build",
      status: "completed",
      durationSec: 180,
    });
    addSession({
      namedAgentId: "agent-a",
      agentType: "build",
      status: "failed",
      durationSec: 600,
    });

    const rows = getNamedAgentDispatchReliability({ nowIso: NOW });
    const build = rowFor(rows, "agent-a", "build");

    expect(build).toBeDefined();
    expect(build?.sampleSize).toBe(4);
    expect(build?.completedCount).toBe(3);
    expect(build?.failedCount).toBe(1);
    expect(build?.successRate).toBeCloseTo(0.75, 5);
    // Even count → average of the two middle durations (120s and 180s).
    expect(build?.medianDurationMs).toBe(150_000);
    expect(build?.agentName).toBe("Alpha");
  });

  it("keeps roles apart: a build record never colours the review badge", () => {
    addRuns({
      namedAgentId: "agent-a",
      agentType: "build",
      completed: 6,
      durationSec: 60,
    });
    addRuns({
      namedAgentId: "agent-a",
      agentType: "review_code",
      completed: 1,
      failed: 5,
      durationSec: 30,
    });

    const rows = getNamedAgentDispatchReliability({ nowIso: NOW });

    expect(rowFor(rows, "agent-a", "build")?.successRate).toBe(1);
    expect(rowFor(rows, "agent-a", "review")?.successRate).toBeCloseTo(
      1 / 6,
      5,
    );
  });

  it("folds every review agent type into the one review role", () => {
    addRuns({
      namedAgentId: "agent-a",
      agentType: "review_code",
      completed: 2,
    });
    addRuns({
      namedAgentId: "agent-a",
      agentType: "review_security",
      completed: 2,
    });
    addRuns({
      namedAgentId: "agent-a",
      agentType: "review_feature",
      completed: 1,
      failed: 1,
    });

    const review = rowFor(
      getNamedAgentDispatchReliability({ nowIso: NOW }),
      "agent-a",
      "review",
    );
    expect(review?.sampleSize).toBe(6);
    expect(review?.completedCount).toBe(5);
  });

  it("ignores runs older than the 30-day window", () => {
    addRuns({
      namedAgentId: "agent-a",
      agentType: "build",
      completed: 5,
      daysAgo: DISPATCH_RELIABILITY_WINDOW_DAYS + 2,
    });
    addRuns({
      namedAgentId: "agent-a",
      agentType: "build",
      completed: 1,
      failed: 1,
      daysAgo: 2,
    });

    const build = rowFor(
      getNamedAgentDispatchReliability({ nowIso: NOW }),
      "agent-a",
      "build",
    );
    expect(build?.sampleSize).toBe(2);
    expect(build?.successRate).toBe(0.5);
  });

  it("counts only terminal runs — queued and running are not evidence", () => {
    addRuns({ namedAgentId: "agent-a", agentType: "build", completed: 2 });
    addSession({
      namedAgentId: "agent-a",
      agentType: "build",
      status: "running",
    });
    addSession({
      namedAgentId: "agent-a",
      agentType: "build",
      status: "queued",
    });
    addSession({
      namedAgentId: "agent-a",
      agentType: "build",
      status: "cancelled",
    });

    expect(
      rowFor(getNamedAgentDispatchReliability({ nowIso: NOW }), "agent-a", "build")
        ?.sampleSize,
    ).toBe(2);
  });

  it("skips sessions with no named agent — the badge addresses agents by id", () => {
    addSession({
      namedAgentId: null,
      agentType: "build",
      status: "completed",
    });

    expect(getNamedAgentDispatchReliability({ nowIso: NOW })).toHaveLength(0);
  });

  it("scopes to a project only when asked", () => {
    addRuns({ namedAgentId: "agent-a", agentType: "build", completed: 3 });
    addSession({
      namedAgentId: "agent-a",
      agentType: "build",
      status: "completed",
      projectId: OTHER_PROJECT_ID,
    });

    expect(
      rowFor(getNamedAgentDispatchReliability({ nowIso: NOW }), "agent-a", "build")
        ?.sampleSize,
    ).toBe(4);
    expect(
      rowFor(
        getNamedAgentDispatchReliability({ nowIso: NOW, projectId: PROJECT_ID }),
        "agent-a",
        "build",
      )?.sampleSize,
    ).toBe(3);
  });

  it("prefers the name recorded at dispatch time over the agent's current one", () => {
    addSession({
      namedAgentId: "agent-a",
      agentType: "build",
      status: "completed",
      namedAgentName: "Alpha (old name)",
    });

    expect(
      rowFor(getNamedAgentDispatchReliability({ nowIso: NOW }), "agent-a", "build")
        ?.agentName,
    ).toBe("Alpha (old name)");
  });

  it("aggregates every agent and role in ONE query — no N+1 in the pickers", () => {
    addRuns({ namedAgentId: "agent-a", agentType: "build", completed: 5 });
    addRuns({ namedAgentId: "agent-a", agentType: "review_code", completed: 5 });
    addRuns({ namedAgentId: "agent-b", agentType: "build", completed: 5 });
    addRuns({ namedAgentId: "agent-b", agentType: "merge", completed: 5 });

    const spy = vi.spyOn(db, "all");
    const rows = getNamedAgentDispatchReliability({ nowIso: NOW });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    expect(rows).toHaveLength(4);
  });
});

describe("dispatch role mapping", () => {
  it("assigns every agent type to exactly one role", () => {
    for (const agentType of AGENT_TYPES) {
      expect(AGENT_TYPE_TO_DISPATCH_ROLE[agentType]).toBeDefined();
    }
    expect(dispatchRoleForAgentType("ticket_build")).toBe("build");
    expect(dispatchRoleForAgentType("review_security")).toBe("review");
    expect(dispatchRoleForAgentType("e2e_test")).toBe("qa");
    expect(dispatchRoleForAgentType("failure_digest")).toBe("qa");
    expect(dispatchRoleForAgentType("nonsense")).toBeNull();
    expect(dispatchRoleForAgentType(null)).toBeNull();
  });
});

describe("formatReliabilityBadge", () => {
  it("shows an em-dash below the 5-session sample threshold", () => {
    const thin = formatReliabilityBadge(
      {
        namedAgentId: "agent-a",
        agentName: "Alpha",
        role: "build",
        sampleSize: DISPATCH_RELIABILITY_MIN_SAMPLE - 1,
        completedCount: 4,
        failedCount: 0,
        successRate: 1,
        medianDurationMs: 60_000,
      },
      "build",
    );

    expect(thin.label).toBe("—");
    expect(thin.hasSample).toBe(false);
    // The percentage must not leak into the tooltip either.
    expect(thin.title).not.toContain("100%");
    expect(thin.title).toContain("4 build runs");
  });

  it("shows an em-dash when the agent has no row at all", () => {
    expect(formatReliabilityBadge(undefined, "review").label).toBe("—");
    expect(formatReliabilityBadge(null, "review").hasSample).toBe(false);
  });

  it("shows the rate and median once the sample clears the threshold", () => {
    const badge = formatReliabilityBadge(
      {
        namedAgentId: "agent-a",
        agentName: "Alpha",
        role: "build",
        sampleSize: 8,
        completedCount: 7,
        failedCount: 1,
        successRate: 7 / 8,
        medianDurationMs: 252_000,
      },
      "build",
    );

    expect(badge.label).toBe("88% · 4m 12s");
    expect(badge.hasSample).toBe(true);
    expect(badge.title).toContain("7/8 build runs succeeded");
  });

  it("formats durations across the second/minute/hour boundaries", () => {
    expect(formatReliabilityDuration(38_000)).toBe("38s");
    expect(formatReliabilityDuration(252_000)).toBe("4m 12s");
    expect(formatReliabilityDuration(3_900_000)).toBe("1h 05m");
    expect(formatReliabilityDuration(null)).toBe("—");
  });
});
