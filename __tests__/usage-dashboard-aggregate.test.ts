/**
 * `getUsageReport(live, range).dashboard` — the range-scoped block frame 8d
 * renders. The eight pre-existing sections are pinned by
 * `__tests__/usage-report.test.ts` and must not move; this file only covers
 * what the dashboard adds.
 *
 * Every cutoff in the module under test is computed in JS and bound as a
 * parameter — never `date('now')` — which is exactly what lets these tests
 * freeze the clock. `date(<column>,'localtime')` is a formatter, not a clock
 * read, so grouping still works under fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<
    typeof import("@/lib/db/test-utils").createTestDb
  > | null,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.db;
  },
  get sqlite() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.sqlite;
  },
}));

// ---- Import the module under test AFTER mocks ----
import { getUsageReport, parseUsageRange } from "@/lib/usage/aggregate";
import { MONTHLY_CAP_SETTING_KEY } from "@/lib/types/usage";

/** Frozen "now": 2026-08-18 12:00 UTC, mid-month in every timezone. */
const NOW = new Date("2026-08-18T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface SeedSession {
  id: string;
  projectId?: string;
  status?: string;
  outcome?: string | null;
  provider?: string | null;
  namedAgentName?: string | null;
  totalCostUsd?: number | null;
  endedAt?: string | null;
  batchRunId?: string | null;
}

function seedSession(session: SeedSession): void {
  testDb
    .instance!.sqlite.prepare(
      `INSERT INTO agent_sessions (
         id, project_id, status, outcome, provider, named_agent_name,
         total_cost_usd, ended_at, batch_run_id, created_at
       ) VALUES (
         @id, @projectId, @status, @outcome, @provider, @namedAgentName,
         @totalCostUsd, @endedAt, @batchRunId, '2026-08-01T00:00:00.000Z'
       )`,
    )
    .run({
      id: session.id,
      projectId: session.projectId ?? "p1",
      status: session.status ?? "completed",
      outcome: session.outcome === undefined ? "answered" : session.outcome,
      provider: session.provider === undefined ? "claude-code" : session.provider,
      namedAgentName: session.namedAgentName ?? null,
      totalCostUsd: session.totalCostUsd ?? null,
      endedAt: session.endedAt ?? null,
      batchRunId: session.batchRunId ?? null,
    });
}

function seedEpic(id: string, projectId = "p1"): void {
  testDb
    .instance!.sqlite.prepare(
      "INSERT INTO epics (id, project_id, title) VALUES (?, ?, ?)",
    )
    .run(id, projectId, `Epic ${id}`);
}

function seedTransition(
  id: string,
  epicId: string,
  fromStatus: string,
  toStatus: string,
  createdAt: string,
): void {
  testDb
    .instance!.sqlite.prepare(
      `INSERT INTO ticket_activity_log
         (id, project_id, epic_id, from_status, to_status, actor, created_at)
       VALUES (?, 'p1', ?, ?, ?, 'system', ?)`,
    )
    .run(id, epicId, fromStatus, toStatus, createdAt);
}

/** Writes the raw JSON exactly as PATCH /api/settings would. */
function seedSetting(key: string, rawJson: string): void {
  testDb
    .instance!.sqlite.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?)",
    )
    .run(key, rawJson);
}

/** ISO of an instant `ms` before the frozen now. */
function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** ISO of LOCAL noon, `daysAgo` local calendar days back. */
function localNoonIso(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(12, 0, 0, 0);
  return date.toISOString();
}

/** The same local calendar key the aggregate builds. */
function localDateKey(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function dashboard(range: "7d" | "30d" | "all" = "30d") {
  return getUsageReport(undefined, range).dashboard;
}

beforeEach(() => {
  testDb.instance = createTestDb();
  testDb.instance.sqlite
    .prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Project One')")
    .run();
  testDb.instance.sqlite
    .prepare("INSERT INTO projects (id, name) VALUES ('p2', 'Project Two')")
    .run();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseUsageRange", () => {
  it("accepts the three real ranges and falls back to 30d otherwise", () => {
    expect(parseUsageRange("7d")).toBe("7d");
    expect(parseUsageRange("30d")).toBe("30d");
    expect(parseUsageRange("all")).toBe("all");
    expect(parseUsageRange(null)).toBe("30d");
    expect(parseUsageRange("yesterday")).toBe("30d");
  });
});

describe("dashboard — range cutoffs", () => {
  beforeEach(() => {
    seedSession({ id: "inside", endedAt: agoIso(6 * DAY + 23 * HOUR), totalCostUsd: 4 });
    seedSession({ id: "outside", endedAt: agoIso(7 * DAY + HOUR), totalCostUsd: 10 });
    seedSession({ id: "ancient", endedAt: agoIso(400 * DAY), totalCostUsd: 100 });
  });

  it("keeps a 6d23h session in the 7d window and drops a 7d01h one", () => {
    const block = dashboard("7d");
    expect(block.totals.sessions).toBe(1);
    expect(block.totals.costUsd).toBe(4);
    expect(block.since).toBe(agoIso(7 * DAY));
  });

  it("widens to 30 days on the default range", () => {
    const block = dashboard("30d");
    expect(block.totals.sessions).toBe(2);
    expect(block.totals.costUsd).toBe(14);
  });

  it("drops the cutoff entirely for `all`, and says so with a null since", () => {
    const block = dashboard("all");
    expect(block.since).toBeNull();
    expect(block.totals.sessions).toBe(3);
    expect(block.totals.costUsd).toBe(114);
  });

  it("never reports a fabricated zero when nothing reported a cost", () => {
    testDb.instance!.sqlite.prepare("DELETE FROM agent_sessions").run();
    seedSession({ id: "codex", provider: "codex", endedAt: agoIso(HOUR) });

    const block = dashboard();
    expect(block.totals.sessions).toBe(1);
    expect(block.totals.costUsd).toBeNull();
  });
});

describe("dashboard — cleanPercent", () => {
  it("counts completed+answered over sessions with a non-null outcome", () => {
    seedSession({ id: "ok1", endedAt: agoIso(HOUR), outcome: "answered" });
    seedSession({ id: "ok2", endedAt: agoIso(HOUR), outcome: "answered" });
    seedSession({ id: "asked", endedAt: agoIso(HOUR), outcome: "asked_question" });
    seedSession({
      id: "failed",
      status: "failed",
      endedAt: agoIso(HOUR),
      outcome: "error",
    });

    expect(dashboard().totals.cleanPercent).toBe(50);
  });

  it("excludes NULL outcomes from the denominator", () => {
    seedSession({ id: "ok", endedAt: agoIso(HOUR), outcome: "answered" });
    // Cancelled / legacy rows: NULL outcome must not drag the percentage down.
    seedSession({
      id: "cancelled",
      status: "cancelled",
      endedAt: agoIso(HOUR),
      outcome: null,
    });

    expect(dashboard().totals.cleanPercent).toBe(100);
  });

  it("refuses to call an empty window 0% clean", () => {
    seedSession({ id: "running", status: "running", endedAt: null, outcome: null });
    expect(dashboard().totals.cleanPercent).toBeNull();
  });

  it("does not count an answered session that is not `completed`", () => {
    seedSession({
      id: "weird",
      status: "cancelled",
      endedAt: agoIso(HOUR),
      outcome: "answered",
    });
    expect(dashboard().totals.cleanPercent).toBe(0);
  });
});

describe("dashboard — ticketsShipped and costPerTicketUsd", () => {
  it("counts a ticket once even when it walks review -> done -> released", () => {
    seedEpic("e1");
    seedTransition("t1", "e1", "review", "done", agoIso(2 * DAY));
    seedTransition("t2", "e1", "done", "released", agoIso(DAY));

    expect(dashboard().totals.ticketsShipped).toBe(1);
  });

  it("counts distinct epics and honours the window cutoff", () => {
    seedEpic("e1");
    seedEpic("e2");
    seedTransition("t1", "e1", "review", "done", agoIso(2 * DAY));
    seedTransition("t2", "e2", "review", "done", agoIso(20 * DAY));

    expect(dashboard("7d").totals.ticketsShipped).toBe(1);
    expect(dashboard("30d").totals.ticketsShipped).toBe(2);
    expect(dashboard("all").totals.ticketsShipped).toBe(2);
  });

  it("divides the window cost by the tickets it shipped", () => {
    seedSession({ id: "s1", endedAt: agoIso(HOUR), totalCostUsd: 9 });
    seedEpic("e1");
    seedEpic("e2");
    seedEpic("e3");
    seedTransition("t1", "e1", "review", "done", agoIso(DAY));
    seedTransition("t2", "e2", "review", "done", agoIso(DAY));
    seedTransition("t3", "e3", "review", "released", agoIso(DAY));

    expect(dashboard().totals.costPerTicketUsd).toBe(3);
  });

  it("sees a row written in the column's own CURRENT_TIMESTAMP format", () => {
    // Live databases carry BOTH formats in this column: ISO from
    // logTransition, and `YYYY-MM-DD HH:MM:SS` wherever the default fired.
    // A raw string compare drops the latter on the cutoff day.
    seedEpic("e1");
    const sameDay = new Date(Date.now() - 2 * HOUR)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    seedTransition("t1", "e1", "review", "done", sameDay);

    expect(dashboard("7d").totals.ticketsShipped).toBe(1);
  });

  it("is null — not Infinity, not 0 — when the window shipped nothing", () => {
    seedSession({ id: "s1", endedAt: agoIso(HOUR), totalCostUsd: 9 });

    const totals = dashboard().totals;
    expect(totals.ticketsShipped).toBe(0);
    expect(totals.costPerTicketUsd).toBeNull();
  });
});

describe("dashboard — monthly cap", () => {
  it("reads a positive number as the cap", () => {
    seedSetting(MONTHLY_CAP_SETTING_KEY, "250");
    seedSession({ id: "s1", endedAt: localNoonIso(0), totalCostUsd: 184 });

    const cap = dashboard().cap;
    expect(cap.capUsd).toBe(250);
    expect(cap.spentUsd).toBe(184);
    expect(cap.usedPercent).toBe(74);
    expect(cap.alertPercent).toBe(80);
  });

  it.each([
    ["a zero cap", "0"],
    ["a stringified number", '"250"'],
    ["null", "null"],
    ["corrupt JSON", "{not json"],
  ])("treats %s as no cap at all", (_label, raw) => {
    seedSetting(MONTHLY_CAP_SETTING_KEY, raw);
    seedSession({ id: "s1", endedAt: localNoonIso(0), totalCostUsd: 10 });

    const cap = dashboard().cap;
    expect(cap.capUsd).toBeNull();
    expect(cap.usedPercent).toBeNull();
    // Month-to-date spend is still reported: only the denominator is missing.
    expect(cap.spentUsd).toBe(10);
  });

  it("leaves the percentage UNCLAMPED so a blown cap reads 142%", () => {
    seedSetting(MONTHLY_CAP_SETTING_KEY, "100");
    seedSession({ id: "s1", endedAt: localNoonIso(0), totalCostUsd: 142 });

    expect(dashboard().cap.usedPercent).toBe(142);
  });

  it("counts the calendar month, not a rolling 30 days", () => {
    seedSetting(MONTHLY_CAP_SETTING_KEY, "250");
    seedSession({ id: "thisMonth", endedAt: localNoonIso(0), totalCostUsd: 5 });
    // 40 days back is certainly in a previous calendar month.
    seedSession({ id: "lastMonth", endedAt: localNoonIso(40), totalCostUsd: 999 });

    expect(dashboard().cap.spentUsd).toBe(5);
  });

  it("reports no month-to-date spend as null, never $0", () => {
    seedSetting(MONTHLY_CAP_SETTING_KEY, "250");
    expect(dashboard().cap.spentUsd).toBeNull();
  });
});

describe("dashboard — byAgent / byProject bars", () => {
  beforeEach(() => {
    seedSession({
      id: "a1",
      namedAgentName: "Opus Builder",
      endedAt: agoIso(HOUR),
      totalCostUsd: 96,
    });
    seedSession({
      id: "a2",
      namedAgentName: "Codex Fast",
      provider: "codex",
      endedAt: agoIso(HOUR),
      totalCostUsd: 52,
    });
    seedSession({
      id: "a3",
      namedAgentName: "Security CC",
      endedAt: agoIso(HOUR),
      totalCostUsd: 22,
    });
    seedSession({
      id: "a4",
      namedAgentName: "Opus Planner",
      endedAt: agoIso(HOUR),
      totalCostUsd: 14,
    });
  });

  it("orders by cost desc and shares the BAND TOTAL, not the max", () => {
    const bars = dashboard().byAgent;
    expect(bars.map((b) => b.label)).toEqual([
      "Opus Builder",
      "Codex Fast",
      "Security CC",
      "Opus Planner",
    ]);
    // The frame's own numbers: $96/$52/$22/$14 over $184 => 52/28/12/8.
    expect(bars.map((b) => Math.round(b.sharePercent!))).toEqual([52, 28, 12, 8]);
    expect(
      bars.reduce((sum, b) => sum + (b.sharePercent ?? 0), 0),
    ).toBeCloseTo(100, 5);
  });

  it("keys an agent by name and provider, and names an unnamed one", () => {
    seedSession({ id: "a5", namedAgentName: null, endedAt: agoIso(HOUR) });

    const bars = dashboard().byAgent;
    expect(bars.find((b) => b.key === "Codex Fast|codex")).toBeDefined();
    const unnamed = bars.find((b) => b.label === "Unnamed")!;
    expect(unnamed.costUsd).toBeNull();
    expect(unnamed.sharePercent).toBeNull();
  });

  it("sorts unpriced groups last and gives them no fill", () => {
    testDb.instance!.sqlite.prepare("DELETE FROM agent_sessions").run();
    seedSession({ id: "free", namedAgentName: "Codex", provider: "codex", endedAt: agoIso(HOUR) });
    seedSession({ id: "paid", namedAgentName: "Builder", endedAt: agoIso(HOUR), totalCostUsd: 3 });

    const bars = dashboard().byAgent;
    expect(bars[0].label).toBe("Builder");
    expect(bars[1].sharePercent).toBeNull();
  });

  it("nulls every share when the band total is null", () => {
    testDb.instance!.sqlite.prepare("DELETE FROM agent_sessions").run();
    seedSession({ id: "c1", namedAgentName: "Codex", provider: "codex", endedAt: agoIso(HOUR) });

    expect(dashboard().byAgent.every((b) => b.sharePercent === null)).toBe(true);
  });

  it("keeps a session whose project row is gone (LEFT JOIN, not INNER)", () => {
    testDb.instance!.sqlite.prepare("DELETE FROM agent_sessions").run();
    // The FK cascades on delete, so an orphan can only be produced the way a
    // legacy database produced one: with the constraint off.
    testDb.instance!.sqlite.pragma("foreign_keys = OFF");
    seedSession({ id: "p", projectId: "ghost", endedAt: agoIso(HOUR), totalCostUsd: 7 });
    testDb.instance!.sqlite.pragma("foreign_keys = ON");

    const bars = dashboard().byProject;
    expect(bars).toHaveLength(1);
    expect(bars[0].projectId).toBe("ghost");
    // A deleted project row leaves the raw id, never a blank cell.
    expect(bars[0].label).toBe("ghost");
    expect(bars[0].costUsd).toBe(7);
  });

  it("reports colorIndex as null while the column does not exist", () => {
    expect(dashboard().byProject.every((b) => b.colorIndex === null)).toBe(true);
  });
});

describe("dashboard — byDay", () => {
  it("draws min(rangeDays, 30) bars, oldest first, zero-filled", () => {
    expect(dashboard("7d").byDay).toHaveLength(7);
    expect(dashboard("30d").byDay).toHaveLength(30);
    // A bar per day since the first session is unreadable: `all` stays at 30.
    expect(dashboard("all").byDay).toHaveLength(30);

    const days = dashboard().byDay;
    expect(days[0].date).toBe(localDateKey(29));
    expect(days[29].date).toBe(localDateKey(0));
  });

  it("zero-fills an idle day with a null cost — zero dollars would be a claim", () => {
    seedSession({ id: "s1", endedAt: localNoonIso(0), totalCostUsd: 3 });

    const days = dashboard().byDay;
    const idle = days.find((d) => d.date === localDateKey(5))!;
    expect(idle).toEqual({
      date: localDateKey(5),
      sessions: 0,
      costUsd: null,
      failedSessions: 0,
    });
    const today = days[days.length - 1];
    expect(today.sessions).toBe(1);
    expect(today.costUsd).toBe(3);
  });

  it("counts the failed sessions that ended that day", () => {
    seedSession({ id: "ok", endedAt: localNoonIso(2), totalCostUsd: 1 });
    seedSession({
      id: "bad1",
      status: "failed",
      outcome: "error",
      endedAt: localNoonIso(2),
      totalCostUsd: 1,
    });
    seedSession({
      id: "bad2",
      status: "failed",
      outcome: "error",
      endedAt: localNoonIso(2),
      totalCostUsd: 1,
    });

    const day = dashboard().byDay.find((d) => d.date === localDateKey(2))!;
    expect(day.sessions).toBe(3);
    expect(day.failedSessions).toBe(2);
  });
});

describe("dashboard — nightYesterdayUsd", () => {
  it("sums only night_* batch ids that ended yesterday", () => {
    seedSession({
      id: "n1",
      batchRunId: "night_abc",
      endedAt: localNoonIso(1),
      totalCostUsd: 4.2,
    });
    seedSession({
      id: "n2",
      batchRunId: "night_abc",
      endedAt: localNoonIso(0),
      totalCostUsd: 99,
    });
    seedSession({
      id: "b1",
      batchRunId: "batch_xyz",
      endedAt: localNoonIso(1),
      totalCostUsd: 50,
    });
    // The underscore in the LIKE pattern is escaped, so this must not match.
    seedSession({
      id: "n3",
      batchRunId: "nightXrun",
      endedAt: localNoonIso(1),
      totalCostUsd: 7,
    });

    expect(dashboard().nightYesterdayUsd).toBeCloseTo(4.2, 5);
  });

  it("is null when no night run went out yesterday", () => {
    seedSession({ id: "s1", endedAt: localNoonIso(1), totalCostUsd: 5 });
    expect(dashboard().nightYesterdayUsd).toBeNull();
  });

  it("is null when yesterday's night run reported no cost", () => {
    seedSession({
      id: "n1",
      batchRunId: "night_abc",
      provider: "codex",
      endedAt: localNoonIso(1),
    });
    expect(dashboard().nightYesterdayUsd).toBeNull();
  });
});

describe("dashboard — invisibility to the eight legacy sections", () => {
  it("leaves the pre-existing report identical whatever the range", () => {
    seedSession({ id: "s1", endedAt: agoIso(HOUR), totalCostUsd: 1 });
    seedSession({ id: "s2", endedAt: agoIso(20 * DAY), totalCostUsd: 2 });

    const { dashboard: _a, ...wide } = getUsageReport(undefined, "all");
    const { dashboard: _b, ...narrow } = getUsageReport(undefined, "7d");
    expect(wide).toEqual(narrow);
    // ...and the default second argument is the 30d block.
    expect(getUsageReport().dashboard.range).toBe("30d");
  });
});
