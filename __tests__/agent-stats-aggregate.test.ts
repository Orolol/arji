/**
 * Integration tests for the /agents workshop aggregates
 * (lib/agent-config/agent-stats): a real migrated DB via createTestDb, all
 * aggregation in SQL.
 *
 * The things worth pinning here are the ones a rewrite gets wrong:
 * `julianday()` over two incompatible `created_at` formats, the odd/even
 * median, a NULL-preserving cost sum, and a zero-filled 14-entry day series.
 *
 * The escalation-count assertions are GONE with the mechanism they measured.
 * It was a blame heuristic over trace strings, not a recorded event, and the
 * escalation it attributed no longer exists — composite agents replaced it,
 * and their rank-downs are recorded per session (`composite_agent_id`) rather
 * than inferred from prose.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { agentSessions, epics, namedAgents, projects, ticketActivityLog } =
  await import("@/lib/db/schema");
const { getAgentDayStats, getNamedAgentStats } = await import(
  "@/lib/agent-config/agent-stats"
);

/** Window anchor. The 14-day window is 2026-08-15 .. 2026-08-28 inclusive. */
const NOW = "2026-08-28T12:00:00.000Z";

function dayIso(day: string, time = "10:00:00.000Z"): string {
  return `${day}T${time}`;
}

let seq = 0;
function insertSession(values: {
  namedAgentId?: string | null;
  status: string;
  createdAt: string;
  agentType?: string | null;
  epicId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  totalCostUsd?: number | null;
}): string {
  const id = `sess-${++seq}`;
  db.insert(agentSessions)
    .values({
      id,
      projectId: "proj-a",
      status: values.status,
      provider: "claude-code",
      namedAgentId: values.namedAgentId ?? null,
      agentType: values.agentType ?? null,
      epicId: values.epicId ?? null,
      startedAt: values.startedAt ?? null,
      endedAt: values.endedAt ?? null,
      totalCostUsd: values.totalCostUsd ?? null,
      createdAt: values.createdAt,
    })
    .run();
  return id;
}

beforeAll(() => {
  db.insert(projects).values({ id: "proj-a", name: "Alpha" }).run();
  db.insert(epics)
    .values({ id: "epic-1", projectId: "proj-a", title: "E1", status: "review" })
    .run();
  db.insert(namedAgents)
    .values([
      { id: "agent-odd", name: "Odd", provider: "claude-code", model: "" },
      { id: "agent-even", name: "Even", provider: "claude-code", model: "" },
      { id: "agent-empty", name: "Empty", provider: "claude-code", model: "" },
      { id: "agent-blame", name: "Blame", provider: "claude-code", model: "" },
      { id: "agent-other", name: "Other", provider: "claude-code", model: "" },
    ])
    .run();

  /* agent-odd -------------------------------------------------------------
   * Three terminal runs of 10s / 20s / 60s → odd median = 20s.
   * One run inside the window written in the COLUMN DEFAULT's format
   * ('YYYY-MM-DD HH:MM:SS'), one run a day BEFORE the window in ISO — a naive
   * string comparison would sort the space-separated value below 'T' and get
   * both wrong.
   * Costs: 0.05 + null + 0.10 → 0.15, never 0.15 + 0.
   * Days: 2026-08-16 (1 run, 1 failed), 2026-08-20 (2 runs) — everything else
   * zero-filled.
   */
  insertSession({
    namedAgentId: "agent-odd",
    status: "completed",
    agentType: "build",
    createdAt: dayIso("2026-08-20"),
    startedAt: dayIso("2026-08-20"),
    endedAt: dayIso("2026-08-20", "10:00:10.000Z"),
    totalCostUsd: 0.05,
  });
  insertSession({
    namedAgentId: "agent-odd",
    status: "completed",
    agentType: "build",
    createdAt: dayIso("2026-08-20", "11:00:00.000Z"),
    startedAt: dayIso("2026-08-20", "11:00:00.000Z"),
    endedAt: dayIso("2026-08-20", "11:00:20.000Z"),
    totalCostUsd: null,
  });
  // Column-default format, inside the window.
  insertSession({
    namedAgentId: "agent-odd",
    status: "failed",
    agentType: "review_code",
    createdAt: "2026-08-16 09:00:00",
    startedAt: "2026-08-16 09:00:00",
    endedAt: "2026-08-16 09:01:00",
    totalCostUsd: 0.1,
  });
  // One day before the window opens — must be excluded.
  insertSession({
    namedAgentId: "agent-odd",
    status: "completed",
    agentType: "build",
    createdAt: dayIso("2026-08-14"),
    startedAt: dayIso("2026-08-14"),
    endedAt: dayIso("2026-08-14", "10:10:00.000Z"),
    totalCostUsd: 99,
  });

  /* agent-even: 10s / 30s → even median averages both = 20s. */
  insertSession({
    namedAgentId: "agent-even",
    status: "completed",
    agentType: "merge",
    createdAt: dayIso("2026-08-25"),
    startedAt: dayIso("2026-08-25"),
    endedAt: dayIso("2026-08-25", "10:00:10.000Z"),
  });
  insertSession({
    namedAgentId: "agent-even",
    status: "completed",
    agentType: "merge",
    createdAt: dayIso("2026-08-25", "12:00:00.000Z"),
    startedAt: dayIso("2026-08-25", "12:00:00.000Z"),
    endedAt: dayIso("2026-08-25", "12:00:30.000Z"),
  });
  // Still running: not terminal, so it counts as a run but not as evidence.
  insertSession({
    namedAgentId: "agent-even",
    status: "running",
    agentType: "merge",
    createdAt: dayIso("2026-08-25", "13:00:00.000Z"),
    startedAt: dayIso("2026-08-25", "13:00:00.000Z"),
  });

  /* Two sessions on epic-1 that the day series and role split still read.
   * They used to be the escalation-blame fixture; the blame heuristic is gone
   * with the mechanism, and they are kept because the aggregates below count
   * them. */
  insertSession({
    namedAgentId: "agent-blame",
    status: "failed",
    agentType: "build",
    epicId: "epic-1",
    createdAt: dayIso("2026-08-22"),
    startedAt: dayIso("2026-08-22"),
    endedAt: dayIso("2026-08-22", "10:05:00.000Z"),
  });
  insertSession({
    namedAgentId: "agent-other",
    status: "running",
    agentType: "build",
    epicId: "epic-1",
    createdAt: dayIso("2026-08-22", "10:06:00.000Z"),
  });
  db.insert(ticketActivityLog)
    .values([
      {
        id: "trace-1",
        projectId: "proj-a",
        epicId: "epic-1",
        fromStatus: "in_progress",
        toStatus: "in_progress",
        actor: "system",
        reason: "Pipeline effort escalation: build retried with Strong",
        createdAt: dayIso("2026-08-22", "10:06:00.000Z"),
      },
      // A non-escalation system trace must not be counted.
      {
        id: "trace-2",
        projectId: "proj-a",
        epicId: "epic-1",
        fromStatus: "in_progress",
        toStatus: "in_progress",
        actor: "system",
        reason: "Pipeline retry: build attempt 2/2",
        createdAt: dayIso("2026-08-22", "10:07:00.000Z"),
      },
    ])
    .run();
});

describe("getNamedAgentStats", () => {
  it("counts only the 14-day window, across both created_at formats", () => {
    const stats = getNamedAgentStats("agent-odd", { nowIso: NOW });

    // 3 in-window runs; the 2026-08-14 one (ISO) is out, and the
    // '2026-08-16 09:00:00' one (column default) is in.
    expect(stats.runCount).toBe(3);
    expect(stats.windowDays).toBe(14);
    // The excluded run cost $99 — its absence proves the boundary held.
    expect(stats.totalCostUsd).toBeCloseTo(0.15, 10);
  });

  it("preserves NULL in the cost sum instead of adding a zero", () => {
    // Two priced runs at 0.05 and 0.10 plus one with no cost at all.
    expect(getNamedAgentStats("agent-odd", { nowIso: NOW }).totalCostUsd)
      .toBeCloseTo(0.15, 10);
    // Nothing reported a cost for agent-even → null, never 0.
    expect(getNamedAgentStats("agent-even", { nowIso: NOW }).totalCostUsd).toBe(
      null,
    );
  });

  it("computes an odd-count median (the single middle run)", () => {
    expect(
      getNamedAgentStats("agent-odd", { nowIso: NOW }).medianDurationMs,
    ).toBe(20_000);
  });

  it("computes an even-count median (the average of both middle runs)", () => {
    expect(
      getNamedAgentStats("agent-even", { nowIso: NOW }).medianDurationMs,
    ).toBe(20_000);
  });

  it("returns a null clean rate when nothing is terminal", () => {
    const stats = getNamedAgentStats("agent-empty", { nowIso: NOW });
    expect(stats.runCount).toBe(0);
    expect(stats.cleanRate).toBe(null);
    expect(stats.medianDurationMs).toBe(null);
    expect(stats.totalCostUsd).toBe(null);
  });

  it("reports the clean rate over terminal runs only", () => {
    // agent-odd: 2 completed, 1 failed.
    expect(getNamedAgentStats("agent-odd", { nowIso: NOW }).cleanRate).toBeCloseTo(
      2 / 3,
      10,
    );
  });

  it("returns exactly 14 day entries, oldest first, zero-filled", () => {
    const { days } = getNamedAgentStats("agent-odd", { nowIso: NOW });

    expect(days).toHaveLength(14);
    expect(days[0].date).toBe("2026-08-15");
    expect(days[13].date).toBe("2026-08-28");

    const byDate = new Map(days.map((day) => [day.date, day]));
    expect(byDate.get("2026-08-16")).toEqual({
      date: "2026-08-16",
      runs: 1,
      failed: 1,
    });
    expect(byDate.get("2026-08-20")).toEqual({
      date: "2026-08-20",
      runs: 2,
      failed: 0,
    });
    // A day in the middle of the window with nothing in it still has a slot.
    expect(byDate.get("2026-08-18")).toEqual({
      date: "2026-08-18",
      runs: 0,
      failed: 0,
    });
  });

  it("splits runs by dispatch role, not by agent type", () => {
    const { byRole } = getNamedAgentStats("agent-odd", { nowIso: NOW });
    const split = Object.fromEntries(byRole.map((row) => [row.role, row.runs]));

    // 'build' → build; 'review_code' → review. Both mappings come from
    // DISPATCH_ROLE_AGENT_TYPES via the shared CASE expression.
    expect(split).toEqual({ build: 2, review: 1 });
  });

  it("reports no escalation figure at all", () => {
    // The field is gone from the payload, not zeroed: a 0 would read as a
    // measurement ("nothing escalated") of a mechanism that no longer exists.
    expect(getNamedAgentStats("agent-odd", { nowIso: NOW })).not.toHaveProperty(
      "escalationCount",
    );
  });
});

describe("getAgentDayStats", () => {
  it("returns at most one row per named agent, bounded to today plus anything running", () => {
    const rows = getAgentDayStats();
    const ids = rows.map((row) => row.namedAgentId).sort();

    // THE BOUND IS THE POINT. This is polled every 10s for as long as the
    // workshop is open, so it may not read the whole history of the widest
    // table in the database. Only rows that could produce a non-zero figure
    // are admitted: today's, plus anything still running on any day.
    //
    // agent-odd and agent-blame ran only in the past and are running nothing,
    // so they drop OUT — exactly like agent-empty, which never ran at all.
    // That is not a loss: the all-zero row they used to return renders
    // identically to their absence (`0 runs / — / —`), because the card reads
    // a missing row as a truthful zero whenever the aggregate itself answered.
    expect(ids).toEqual(["agent-even", "agent-other"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counts live sessions regardless of the day they started", () => {
    const rows = getAgentDayStats();
    const byId = new Map(rows.map((row) => [row.namedAgentId, row]));

    // Both seeded `running` sessions are dated well before today, and the
    // date bound must not drop them: a session started yesterday and still
    // running is live NOW.
    expect(byId.get("agent-even")?.liveSessions).toBe(1);
    expect(byId.get("agent-other")?.liveSessions).toBe(1);
    // ...while their older, finished siblings contribute nothing to today.
    expect(byId.get("agent-even")?.runsToday).toBe(0);
    expect(byId.has("agent-odd")).toBe(false);
  });

  it("reports today's window separately from the live count", () => {
    const today = new Date().toISOString();
    // agent_sessions.named_agent_id carries a real FK in the migrated schema.
    db.insert(namedAgents)
      .values({
        id: "agent-today",
        name: "Today",
        provider: "claude-code",
        model: "",
      })
      .run();
    insertSession({
      namedAgentId: "agent-today",
      status: "completed",
      createdAt: today,
      totalCostUsd: 0.25,
    });
    insertSession({
      namedAgentId: "agent-today",
      status: "failed",
      createdAt: today,
      totalCostUsd: null,
    });

    const row = getAgentDayStats().find(
      (candidate) => candidate.namedAgentId === "agent-today",
    );

    expect(row?.runsToday).toBe(2);
    expect(row?.cleanRate).toBeCloseTo(0.5, 10);
    // NULL-preserving again: one priced run and one unpriced.
    expect(row?.costTodayUsd).toBeCloseTo(0.25, 10);
    expect(row?.liveSessions).toBe(0);
  });
});
