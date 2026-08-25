/**
 * Dreaming — the DB-backed collector (lib/workflow/dreaming.ts) against the
 * real migrated schema.
 *
 * Covers the acceptance criteria of "Collecteur de digest cross-sessions":
 *   - the window opens at the last DELIVERED dream and is capped on both axes
 *     (~30 sessions / 14 days),
 *   - only terminal sessions of the dreamable types feed it,
 *   - each session's record carries metadata + review verdict +
 *     [critical]/[major] findings + forensic report + transition_refused +
 *     the tail of the final response,
 *   - the hard size budget is enforced with fair per-session truncation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: { start: vi.fn(), getStatus: vi.fn(() => undefined) },
}));

const { db } = await import("@/lib/db");
const {
  projects,
  epics,
  userStories,
  agentSessions,
  reviewComments,
  ticketComments,
} = await import("@/lib/db/schema");
const { collectDreamDigest, findLastDreamAt, selectDreamCandidates } =
  await import("@/lib/workflow/dreaming");
const { FORENSIC_COMMENT_HEADING } = await import("@/lib/pipeline/forensic");

const NOW = new Date("2026-08-25T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp `days` before the frozen NOW. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

/** ISO timestamp `minutes` before the frozen NOW. */
function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

let counter = 0;
let projectId = "";
let epicId = "";

function seedProject() {
  counter += 1;
  projectId = `proj-dream-${counter}`;
  epicId = `epic-dream-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: "Dream Project", gitRepoPath: "/repos/d" })
    .run();
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Checkout flow",
      status: "review",
      position: 0,
      readableId: `E-d-${counter}`,
    })
    .run();
}

let sessionSeq = 0;

function seedSession(
  overrides: Partial<typeof agentSessions.$inferInsert> = {}
): string {
  sessionSeq += 1;
  const id = `sess-${counter}-${sessionSeq}`;
  db.insert(agentSessions)
    .values({
      id,
      projectId,
      epicId,
      status: "completed",
      agentType: "ticket_build",
      outcome: "answered",
      provider: "claude-code",
      model: "opus",
      mode: "code",
      lastNonEmptyText: "Done: shipped the flow.",
      createdAt: minutesAgo(60),
      startedAt: minutesAgo(60),
      endedAt: minutesAgo(50),
      completedAt: minutesAgo(50),
      ...overrides,
    })
    .run();
  return id;
}

beforeEach(() => {
  seedProject();
});

describe("selectDreamCandidates", () => {
  it("keeps only terminal sessions of the dreamable agent types", () => {
    const build = seedSession({ agentType: "build" });
    const ticket = seedSession({ agentType: "ticket_build" });
    const team = seedSession({ agentType: "team_build" });
    const review = seedSession({ agentType: "review_code" });
    const failedBuild = seedSession({
      agentType: "build",
      status: "failed",
      outcome: "error",
      error: "boom",
    });
    // Excluded: wrong type, or not terminal.
    seedSession({ agentType: "merge" });
    seedSession({ agentType: "tech_check" });
    seedSession({ agentType: "memory_distill" });
    seedSession({ agentType: "dreaming" });
    seedSession({ agentType: "build", status: "running", outcome: null });
    seedSession({ agentType: "build", status: "queued", outcome: null });
    seedSession({ agentType: "build", status: "cancelled", outcome: null });

    const { rows, candidateCount } = selectDreamCandidates(
      projectId,
      daysAgo(14)
    );
    expect(candidateCount).toBe(5);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [build, ticket, team, review, failedBuild].sort()
    );
  });

  it("drops sessions older than the window and keeps the newest first", () => {
    const recent = seedSession({
      createdAt: minutesAgo(10),
      startedAt: minutesAgo(10),
    });
    const older = seedSession({
      createdAt: minutesAgo(120),
      startedAt: minutesAgo(120),
    });
    seedSession({ createdAt: daysAgo(20), startedAt: daysAgo(20) });

    const { rows, candidateCount } = selectDreamCandidates(
      projectId,
      daysAgo(14)
    );
    expect(candidateCount).toBe(2);
    expect(rows.map((row) => row.id)).toEqual([recent, older]);
  });

  it("caps the count, keeping the most recent sessions", () => {
    const ids: string[] = [];
    for (let i = 0; i < 35; i += 1) {
      ids.push(
        seedSession({
          createdAt: minutesAgo(35 - i),
          startedAt: minutesAgo(35 - i),
        })
      );
    }

    const { rows, candidateCount } = selectDreamCandidates(
      projectId,
      daysAgo(14),
      30
    );
    expect(candidateCount).toBe(35);
    expect(rows).toHaveLength(30);
    // The 5 oldest were dropped, not the 5 newest.
    expect(rows.map((row) => row.id)).not.toContain(ids[0]);
    expect(rows.map((row) => row.id)).toContain(ids[34]);
  });
});

describe("findLastDreamAt", () => {
  it("is null before any dream", () => {
    expect(findLastDreamAt(projectId)).toBeNull();
  });

  it("returns the most recent DELIVERED dream", () => {
    seedSession({
      agentType: "dreaming",
      completedAt: daysAgo(5),
      endedAt: daysAgo(5),
    });
    seedSession({
      agentType: "dreaming",
      completedAt: daysAgo(2),
      endedAt: daysAgo(2),
    });
    expect(findLastDreamAt(projectId)).toBe(daysAgo(2));
  });

  it("ignores dreams that failed or stayed silent — their window is unread", () => {
    seedSession({
      agentType: "dreaming",
      status: "failed",
      outcome: "error",
      completedAt: daysAgo(1),
    });
    seedSession({
      agentType: "dreaming",
      status: "completed",
      outcome: "silent",
      completedAt: daysAgo(1),
    });
    expect(findLastDreamAt(projectId)).toBeNull();
  });
});

describe("collectDreamDigest — window", () => {
  it("opens at the last delivered dream and skips everything before it", () => {
    const before = seedSession({
      createdAt: daysAgo(6),
      startedAt: daysAgo(6),
      lastNonEmptyText: "OLD SESSION",
    });
    seedSession({
      agentType: "dreaming",
      completedAt: daysAgo(5),
      endedAt: daysAgo(5),
    });
    const after = seedSession({
      createdAt: daysAgo(1),
      startedAt: daysAgo(1),
      lastNonEmptyText: "NEW SESSION",
    });

    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.lastDreamAt).toBe(daysAgo(5));
    expect(result.sinceIso).toBe(daysAgo(5));
    expect(result.sessions.map((s) => s.sessionId)).toEqual([after]);
    expect(result.sessions.map((s) => s.sessionId)).not.toContain(before);
    expect(result.text).toContain("NEW SESSION");
    expect(result.text).not.toContain("OLD SESSION");
  });

  it("never reaches past the age cap on a first dream", () => {
    seedSession({ createdAt: daysAgo(20), startedAt: daysAgo(20) });
    const recent = seedSession({ createdAt: daysAgo(3), startedAt: daysAgo(3) });

    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.lastDreamAt).toBeNull();
    expect(result.sessions.map((s) => s.sessionId)).toEqual([recent]);
  });

  it("orders the digest oldest → newest so the period reads as a story", () => {
    const first = seedSession({
      createdAt: minutesAgo(300),
      startedAt: minutesAgo(300),
      lastNonEmptyText: "FIRST",
    });
    const second = seedSession({
      createdAt: minutesAgo(200),
      startedAt: minutesAgo(200),
      lastNonEmptyText: "SECOND",
    });

    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.sessions.map((s) => s.sessionId)).toEqual([first, second]);
    expect(result.text.indexOf("FIRST")).toBeLessThan(
      result.text.indexOf("SECOND")
    );
  });

  it("is empty (and says so) when nothing happened in the window", () => {
    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.sessions).toHaveLength(0);
    expect(result.includedCount).toBe(0);
    expect(result.text).toBe("");
  });
});

describe("collectDreamDigest — per-session record", () => {
  it("carries metadata, ticket label, duration and cost", () => {
    const storyId = `story-${counter}`;
    db.insert(userStories)
      .values({ id: storyId, epicId, title: "Pay with card", position: 0 })
      .run();
    seedSession({
      userStoryId: storyId,
      agentType: "ticket_build",
      provider: "codex",
      model: "gpt-5.4",
      totalCostUsd: 2.25,
      startedAt: minutesAgo(20),
      createdAt: minutesAgo(21),
      endedAt: minutesAgo(18),
      completedAt: minutesAgo(18),
    });

    const [entry] = collectDreamDigest(projectId, { now: NOW }).sessions;
    expect(entry.ticketLabel).toBe(`E-d-${counter}: Checkout flow — Pay with card`);
    expect(entry.agentType).toBe("ticket_build");
    expect(entry.provider).toBe("codex");
    expect(entry.model).toBe("gpt-5.4");
    expect(entry.outcome).toBe("answered");
    expect(entry.costUsd).toBeCloseTo(2.25, 10);
    expect(entry.durationMs).toBe(2 * 60_000);
  });

  it("carries the review verdict and the [critical]/[major] findings of the run", () => {
    const reviewId = seedSession({
      agentType: "review_code",
      startedAt: minutesAgo(30),
      createdAt: minutesAgo(30),
      endedAt: minutesAgo(20),
      completedAt: minutesAgo(20),
      lastNonEmptyText:
        "Findings filed.\n\n**Overall Verdict: Changes Requested**",
    });

    const findings: Array<[string, string, string]> = [
      ["f-crit", "[critical] Token logged in plain text", minutesAgo(25)],
      ["f-major", "[major] No test covers the refund path", minutesAgo(24)],
      ["f-minor", "[minor] Rename this variable", minutesAgo(24)],
      // Outside the run window — belongs to another session.
      ["f-old", "[critical] Filed long before this run", minutesAgo(600)],
    ];
    for (const [id, body, createdAt] of findings) {
      db.insert(reviewComments)
        .values({
          id: `${id}-${counter}`,
          epicId,
          filePath: "lib/x.ts",
          lineNumber: 12,
          body,
          author: "agent",
          status: "open",
          createdAt,
        })
        .run();
    }

    const entry = collectDreamDigest(projectId, { now: NOW }).sessions.find(
      (s) => s.sessionId === reviewId
    )!;
    expect(entry.reviewVerdict).toBe("Changes Requested");
    expect(entry.findings).toEqual([
      "[critical] Token logged in plain text",
      "[major] No test covers the refund path",
    ]);
  });

  it("keeps resolved findings too — a fixed defect is still a mistake made", () => {
    const reviewId = seedSession({
      agentType: "review_security",
      startedAt: minutesAgo(30),
      createdAt: minutesAgo(30),
      endedAt: minutesAgo(20),
      completedAt: minutesAgo(20),
    });
    db.insert(reviewComments)
      .values({
        id: `f-resolved-${counter}`,
        epicId,
        filePath: "lib/x.ts",
        lineNumber: 3,
        body: "[major] Missing auth check",
        author: "agent",
        status: "resolved",
        createdAt: minutesAgo(25),
      })
      .run();

    const entry = collectDreamDigest(projectId, { now: NOW }).sessions.find(
      (s) => s.sessionId === reviewId
    )!;
    expect(entry.findings).toEqual(["[major] Missing auth check"]);
  });

  it("carries a refused transition with its reason", () => {
    seedSession({
      outcome: "transition_refused",
      error: "Cannot move a released ticket back to in_progress",
    });

    const [entry] = collectDreamDigest(projectId, { now: NOW }).sessions;
    expect(entry.outcome).toBe("transition_refused");
    expect(entry.error).toContain("released ticket");
    const digest = collectDreamDigest(projectId, { now: NOW }).text;
    expect(digest).toContain("**Transition refused:**");
  });

  it("attaches the forensic report filed after the run, to exactly one session", () => {
    const dead = seedSession({
      agentType: "build",
      status: "failed",
      outcome: "error",
      error: "exit 1",
      startedAt: minutesAgo(60),
      createdAt: minutesAgo(60),
      endedAt: minutesAgo(50),
      completedAt: minutesAgo(50),
    });
    const later = seedSession({
      agentType: "build",
      startedAt: minutesAgo(20),
      createdAt: minutesAgo(20),
      endedAt: minutesAgo(10),
      completedAt: minutesAgo(10),
    });
    db.insert(ticketComments)
      .values({
        id: `forensic-${counter}`,
        epicId,
        userStoryId: null,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n\nThe worktree was missing node_modules.`,
        createdAt: minutesAgo(49),
      })
      .run();
    // A plain agent comment must not be mistaken for a post-mortem.
    db.insert(ticketComments)
      .values({
        id: `chatter-${counter}`,
        epicId,
        userStoryId: null,
        author: "agent",
        content: "Just a progress note.",
        createdAt: minutesAgo(48),
      })
      .run();

    const { sessions } = collectDreamDigest(projectId, { now: NOW });
    const deadEntry = sessions.find((s) => s.sessionId === dead)!;
    const laterEntry = sessions.find((s) => s.sessionId === later)!;
    expect(deadEntry.forensic).toContain("missing node_modules");
    expect(deadEntry.forensic).not.toContain("progress note");
    expect(laterEntry.forensic).toBeNull();
  });

  it("carries the tail of the final response, never the raw chunk stream", () => {
    seedSession({
      lastNonEmptyText: "prelude ".repeat(400) + "THE CONCLUSION",
    });

    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.text).toContain("THE CONCLUSION");
    expect(result.text).toContain("**Final response (tail):**");
    // The 3200-char text was cut down to its per-field cap.
    expect(result.text.length).toBeLessThan(2500);
  });
});

describe("collectDreamDigest — size budget", () => {
  it("stays under the hard cap and reports what it had to cut", () => {
    for (let i = 0; i < 12; i += 1) {
      seedSession({
        createdAt: minutesAgo(100 - i),
        startedAt: minutesAgo(100 - i),
        lastNonEmptyText: `session ${i} ` + "verbose ".repeat(300),
      });
    }

    const result = collectDreamDigest(projectId, { now: NOW, maxChars: 3_000 });
    expect(result.text.length).toBeLessThanOrEqual(3_000);
    expect(result.sessions).toHaveLength(12);
    expect(result.includedCount + result.droppedCount).toBe(12);
    expect(result.truncatedCount).toBeGreaterThan(0);
  });

  it("truncates fairly — a terse session survives a batch of verbose ones", () => {
    seedSession({
      createdAt: minutesAgo(100),
      startedAt: minutesAgo(100),
      lastNonEmptyText: "TERSE",
    });
    for (let i = 0; i < 5; i += 1) {
      seedSession({
        createdAt: minutesAgo(90 - i),
        startedAt: minutesAgo(90 - i),
        lastNonEmptyText: "verbose ".repeat(300),
      });
    }

    const result = collectDreamDigest(projectId, { now: NOW, maxChars: 2_500 });
    expect(result.text).toContain("TERSE");
    expect(result.droppedCount).toBe(0);
    expect(result.truncatedCount).toBe(5);
  });
});
