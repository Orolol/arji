/**
 * Tests for the Full Auto informed selection (lib/agent-config/smart-dispatch.ts).
 *
 * The argmax is pure and tested directly; `selectSmartDispatchAgent` is tested
 * against a real database so the window/threshold contract holds end to end.
 * The "explicit agent wins" and "the choice is traced" criteria live where the
 * decision is actually made — __tests__/auto-mode-engine.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DispatchReliabilityRow } from "@/lib/agent-config/dispatch-reliability-constants";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions, namedAgents } = await import(
  "@/lib/db/schema"
);
const { pickBestByReliability, selectSmartDispatchAgent } = await import(
  "@/lib/agent-config/smart-dispatch"
);
const { DISPATCH_RELIABILITY_MIN_SAMPLE } = await import(
  "@/lib/agent-config/dispatch-reliability-constants"
);

const PROJECT_ID = "proj-smart";
const NOW = "2026-08-25T12:00:00.000Z";

function row(patch: Partial<DispatchReliabilityRow>): DispatchReliabilityRow {
  return {
    namedAgentId: "agent-a",
    agentName: "Alpha",
    role: "build",
    sampleSize: 10,
    completedCount: 9,
    failedCount: 1,
    successRate: 0.9,
    medianDurationMs: 60_000,
    ...patch,
  };
}

describe("pickBestByReliability", () => {
  it("picks the best success rate among agents that clear the threshold", () => {
    const pick = pickBestByReliability(
      [
        row({ namedAgentId: "a", agentName: "Alpha", successRate: 0.6 }),
        row({ namedAgentId: "b", agentName: "Beta", successRate: 0.95 }),
        row({ namedAgentId: "c", agentName: "Gamma", successRate: 0.8 }),
      ],
      "build",
    );

    expect(pick?.namedAgentId).toBe("b");
    expect(pick?.successRate).toBe(0.95);
    expect(pick?.role).toBe("build");
  });

  it("ignores agents under the sample threshold even when they look perfect", () => {
    const pick = pickBestByReliability(
      [
        row({
          namedAgentId: "lucky",
          successRate: 1,
          sampleSize: DISPATCH_RELIABILITY_MIN_SAMPLE - 1,
          completedCount: 4,
          failedCount: 0,
        }),
        row({ namedAgentId: "proven", successRate: 0.7, sampleSize: 20 }),
      ],
      "build",
    );

    expect(pick?.namedAgentId).toBe("proven");
  });

  it("returns null when nothing clears the threshold — caller keeps its default", () => {
    expect(
      pickBestByReliability(
        [row({ sampleSize: 2, completedCount: 2, failedCount: 0 })],
        "build",
      ),
    ).toBeNull();
    expect(pickBestByReliability([], "build")).toBeNull();
  });

  it("only considers the requested role", () => {
    const pick = pickBestByReliability(
      [
        row({ namedAgentId: "builder", role: "build", successRate: 1 }),
        row({ namedAgentId: "reviewer", role: "review", successRate: 0.6 }),
      ],
      "review",
    );

    expect(pick?.namedAgentId).toBe("reviewer");
  });

  it("breaks ties deterministically: bigger sample, then faster, then name", () => {
    const bySample = pickBestByReliability(
      [
        row({ namedAgentId: "small", agentName: "Alpha", sampleSize: 6 }),
        row({ namedAgentId: "big", agentName: "Zeta", sampleSize: 40 }),
      ],
      "build",
    );
    expect(bySample?.namedAgentId).toBe("big");

    const byDuration = pickBestByReliability(
      [
        row({ namedAgentId: "slow", agentName: "Alpha", medianDurationMs: 900_000 }),
        row({ namedAgentId: "fast", agentName: "Zeta", medianDurationMs: 60_000 }),
      ],
      "build",
    );
    expect(byDuration?.namedAgentId).toBe("fast");

    const byName = pickBestByReliability(
      [
        row({ namedAgentId: "z", agentName: "Zeta" }),
        row({ namedAgentId: "a", agentName: "Alpha" }),
      ],
      "build",
    );
    expect(byName?.namedAgentId).toBe("a");
  });

  it("sorts a missing median last rather than treating it as instant", () => {
    const pick = pickBestByReliability(
      [
        row({ namedAgentId: "unknown", agentName: "Alpha", medianDurationMs: null }),
        row({ namedAgentId: "timed", agentName: "Zeta", medianDurationMs: 300_000 }),
      ],
      "build",
    );

    expect(pick?.namedAgentId).toBe("timed");
  });
});

describe("selectSmartDispatchAgent", () => {
  let seq = 0;

  function addRuns(input: {
    namedAgentId: string;
    agentType: string;
    completed: number;
    failed?: number;
    daysAgo?: number;
  }): void {
    const createdAt = new Date(
      new Date(NOW).getTime() - (input.daysAgo ?? 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rows: Array<"completed" | "failed"> = [
      ...Array<"completed">(input.completed).fill("completed"),
      ...Array<"failed">(input.failed ?? 0).fill("failed"),
    ];
    for (const status of rows) {
      seq += 1;
      db.insert(agentSessions)
        .values({
          id: `s-${seq}`,
          projectId: PROJECT_ID,
          epicId: "epic-1",
          status,
          agentType: input.agentType,
          namedAgentId: input.namedAgentId,
          createdAt,
        })
        .run();
    }
  }

  beforeEach(() => {
    db.delete(agentSessions).run();
    db.delete(epics).run();
    db.delete(namedAgents).run();
    db.delete(projects).run();
    seq = 0;

    db.insert(projects)
      .values({ id: PROJECT_ID, name: "Smart", gitRepoPath: "/repos/smart" })
      .run();
    db.insert(epics)
      .values({
        id: "epic-1",
        projectId: PROJECT_ID,
        title: "Epic",
        status: "in_progress",
        position: 0,
      })
      .run();
    for (const [id, name] of [
      ["agent-a", "Alpha"],
      ["agent-b", "Beta"],
    ]) {
      db.insert(namedAgents)
        .values({ id, name, provider: "claude-code", model: "sonnet" })
        .run();
    }
  });

  it("returns the argmax over the real 30-day aggregate", async () => {
    addRuns({ namedAgentId: "agent-a", agentType: "build", completed: 5, failed: 5 });
    addRuns({ namedAgentId: "agent-b", agentType: "build", completed: 9, failed: 1 });

    const pick = await selectSmartDispatchAgent({ role: "build", nowIso: NOW });

    expect(pick?.namedAgentId).toBe("agent-b");
    expect(pick?.agentName).toBe("Beta");
    expect(pick?.successRate).toBeCloseTo(0.9, 5);
    expect(pick?.sampleSize).toBe(10);
  });

  it("returns null when every agent is under the sample threshold", async () => {
    addRuns({ namedAgentId: "agent-a", agentType: "build", completed: 4 });
    addRuns({ namedAgentId: "agent-b", agentType: "build", completed: 3 });

    expect(
      await selectSmartDispatchAgent({ role: "build", nowIso: NOW }),
    ).toBeNull();
  });

  it("does not let a record older than the window decide", async () => {
    addRuns({
      namedAgentId: "agent-a",
      agentType: "build",
      completed: 20,
      daysAgo: 45,
    });
    addRuns({ namedAgentId: "agent-b", agentType: "build", completed: 6 });

    const pick = await selectSmartDispatchAgent({ role: "build", nowIso: NOW });
    expect(pick?.namedAgentId).toBe("agent-b");
  });

  it("scores each role on its own history", async () => {
    addRuns({ namedAgentId: "agent-a", agentType: "build", completed: 10 });
    addRuns({
      namedAgentId: "agent-a",
      agentType: "review_code",
      completed: 1,
      failed: 9,
    });
    addRuns({
      namedAgentId: "agent-b",
      agentType: "review_security",
      completed: 8,
      failed: 2,
    });

    expect(
      (await selectSmartDispatchAgent({ role: "build", nowIso: NOW }))
        ?.namedAgentId,
    ).toBe("agent-a");
    expect(
      (await selectSmartDispatchAgent({ role: "review", nowIso: NOW }))
        ?.namedAgentId,
    ).toBe("agent-b");
  });
});
