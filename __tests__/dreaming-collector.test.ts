/**
 * Dreaming — the DB-backed collector (lib/workflow/dreaming.ts) against the
 * real migrated schema.
 *
 * Covers the acceptance criteria of "Collecteur de digest cross-sessions":
 *   - the window opens at the cutoff recorded by the last dream that actually
 *     rewrote the memory, is measured on TERMINAL time, and is capped on both
 *     axes (~30 sessions / 14 days),
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
  settings,
} = await import("@/lib/db/schema");
const {
  collectDreamDigest,
  findLastDreamCutoff,
  recordDreamCutoff,
  selectDreamCandidates,
} = await import("@/lib/workflow/dreaming");
const { FORENSIC_COMMENT_HEADING, forensicDeadSessionMarker } = await import(
  "@/lib/pipeline/forensic"
);
const { appendSessionChunk } = await import("@/lib/agent-sessions/chunks");

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

/**
 * Seeds one dreamable session.
 *
 * A test that moves the session in time by overriding `startedAt` gets its
 * terminal timestamps moved with it unless it says otherwise: the collector
 * places sessions by when they ENDED, so a seed that shifted only the start
 * would silently test a session that ran backwards.
 */
function seedSession(
  overrides: Partial<typeof agentSessions.$inferInsert> = {}
): string {
  sessionSeq += 1;
  const id = `sess-${counter}-${sessionSeq}`;
  const terminalDefault =
    overrides.endedAt ??
    overrides.completedAt ??
    (overrides.startedAt as string | undefined) ??
    (overrides.createdAt as string | undefined) ??
    minutesAgo(50);
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
      endedAt: terminalDefault,
      completedAt: terminalDefault,
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

describe("findLastDreamCutoff / recordDreamCutoff", () => {
  it("is null before any dream delivered", () => {
    expect(findLastDreamCutoff(projectId)).toBeNull();
  });

  it("round-trips the recorded cutoff and keeps the latest one", () => {
    recordDreamCutoff(projectId, daysAgo(5));
    expect(findLastDreamCutoff(projectId)).toBe(daysAgo(5));
    recordDreamCutoff(projectId, daysAgo(2));
    expect(findLastDreamCutoff(projectId)).toBe(daysAgo(2));
  });

  it("is scoped per project", () => {
    recordDreamCutoff(projectId, daysAgo(3));
    expect(findLastDreamCutoff("some-other-project")).toBeNull();
  });

  /**
   * The whole point of a persisted cutoff: a dream SESSION that finished and
   * answered proves nothing about whether the memory changed. Only the row
   * written after a successful save moves the window, so dream sessions alone
   * — however they ended — leave it wide open.
   */
  it("ignores dream sessions entirely — only a recorded cutoff counts", () => {
    seedSession({
      agentType: "dreaming",
      status: "completed",
      outcome: "answered",
      completedAt: daysAgo(1),
      endedAt: daysAgo(1),
    });
    seedSession({
      agentType: "dreaming",
      status: "failed",
      outcome: "error",
      completedAt: daysAgo(1),
    });
    expect(findLastDreamCutoff(projectId)).toBeNull();
  });

  it("rejects a stored value that is not a usable timestamp", () => {
    db.insert(settings)
      .values({
        key: `dreaming_last_cutoff:${projectId}`,
        value: JSON.stringify("not-a-date"),
      })
      .run();
    expect(findLastDreamCutoff(projectId)).toBeNull();
  });
});

describe("collectDreamDigest — window", () => {
  it("opens at the recorded cutoff and skips everything that ended before it", () => {
    const before = seedSession({
      createdAt: daysAgo(6),
      startedAt: daysAgo(6),
      endedAt: daysAgo(6),
      completedAt: daysAgo(6),
      lastNonEmptyText: "OLD SESSION",
    });
    recordDreamCutoff(projectId, daysAgo(5));
    const after = seedSession({
      createdAt: daysAgo(1),
      startedAt: daysAgo(1),
      endedAt: daysAgo(1),
      completedAt: daysAgo(1),
      lastNonEmptyText: "NEW SESSION",
    });

    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.lastCutoffAt).toBe(daysAgo(5));
    expect(result.sinceIso).toBe(daysAgo(5));
    expect(result.sessions.map((s) => s.sessionId)).toEqual([after]);
    expect(result.sessions.map((s) => s.sessionId)).not.toContain(before);
    expect(result.text).toContain("NEW SESSION");
    expect(result.text).not.toContain("OLD SESSION");
  });

  /**
   * The boundary the review caught: a build that STARTED before the previous
   * dream but only ENDED after it was never in that digest. Keyed on start it
   * would fall in the crack between two windows and be lost forever; keyed on
   * terminal time it is exactly what the next dream reads first.
   */
  it("includes a session that started before the cutoff but ended after it", () => {
    const straddling = seedSession({
      createdAt: daysAgo(6),
      startedAt: daysAgo(6),
      endedAt: daysAgo(4),
      completedAt: daysAgo(4),
      lastNonEmptyText: "STRADDLING SESSION",
    });
    recordDreamCutoff(projectId, daysAgo(5));

    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.sessions.map((s) => s.sessionId)).toEqual([straddling]);
    expect(result.text).toContain("STRADDLING SESSION");
  });

  it("excludes a session that had already ended when the cutoff was taken", () => {
    seedSession({
      createdAt: daysAgo(9),
      startedAt: daysAgo(9),
      endedAt: daysAgo(8),
      completedAt: daysAgo(8),
      lastNonEmptyText: "ALREADY DREAMED",
    });
    recordDreamCutoff(projectId, daysAgo(5));

    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.sessions).toHaveLength(0);
    expect(result.text).not.toContain("ALREADY DREAMED");
  });

  it("reports the collection instant as the next window's cutoff", () => {
    seedSession();
    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.collectedAtIso).toBe(NOW.toISOString());
  });

  it("never reaches past the age cap on a first dream", () => {
    seedSession({
      createdAt: daysAgo(20),
      startedAt: daysAgo(20),
      endedAt: daysAgo(20),
      completedAt: daysAgo(20),
    });
    const recent = seedSession({
      createdAt: daysAgo(3),
      startedAt: daysAgo(3),
      endedAt: daysAgo(3),
      completedAt: daysAgo(3),
    });

    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.lastCutoffAt).toBeNull();
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

  /**
   * Two reviewers on the same epic at once are indistinguishable by timestamp,
   * so the time-window match handed each of them the other's findings — and the
   * dream would then learn a lesson from the wrong run. Since migration 0032
   * submit_findings records the filing session, and that link decides.
   */
  it("attributes findings by the recorded session, not by overlapping time", () => {
    const reviewA = seedSession({
      agentType: "review_code",
      startedAt: minutesAgo(30),
      createdAt: minutesAgo(30),
      endedAt: minutesAgo(10),
      completedAt: minutesAgo(10),
    });
    const reviewB = seedSession({
      agentType: "review_security",
      startedAt: minutesAgo(28),
      createdAt: minutesAgo(28),
      endedAt: minutesAgo(12),
      completedAt: minutesAgo(12),
    });

    // Both windows cover both rows — only the recorded session separates them.
    db.insert(reviewComments)
      .values({
        id: `f-a-${counter}`,
        epicId,
        filePath: "lib/a.ts",
        lineNumber: 1,
        body: "[critical] BELONGS TO A",
        author: "agent",
        status: "open",
        agentSessionId: reviewA,
        createdAt: minutesAgo(20),
      })
      .run();
    db.insert(reviewComments)
      .values({
        id: `f-b-${counter}`,
        epicId,
        filePath: "lib/b.ts",
        lineNumber: 2,
        body: "[major] BELONGS TO B",
        author: "agent",
        status: "open",
        agentSessionId: reviewB,
        createdAt: minutesAgo(19),
      })
      .run();

    const { sessions } = collectDreamDigest(projectId, { now: NOW });
    expect(sessions.find((s) => s.sessionId === reviewA)!.findings).toEqual([
      "[critical] BELONGS TO A",
    ]);
    expect(sessions.find((s) => s.sessionId === reviewB)!.findings).toEqual([
      "[major] BELONGS TO B",
    ]);
  });

  it("never lets a time-window match steal a finding that names another session", () => {
    const linked = seedSession({
      agentType: "review_code",
      startedAt: minutesAgo(30),
      createdAt: minutesAgo(30),
      endedAt: minutesAgo(10),
      completedAt: minutesAgo(10),
    });
    // A build whose window also covers the row, but which filed nothing.
    const bystander = seedSession({
      agentType: "build",
      startedAt: minutesAgo(29),
      createdAt: minutesAgo(29),
      endedAt: minutesAgo(11),
      completedAt: minutesAgo(11),
    });
    db.insert(reviewComments)
      .values({
        id: `f-linked-${counter}`,
        epicId,
        filePath: "lib/a.ts",
        lineNumber: 1,
        body: "[critical] LINKED FINDING",
        author: "agent",
        status: "open",
        agentSessionId: linked,
        createdAt: minutesAgo(20),
      })
      .run();

    const { sessions } = collectDreamDigest(projectId, { now: NOW });
    expect(sessions.find((s) => s.sessionId === bystander)!.findings).toEqual([]);
    expect(sessions.find((s) => s.sessionId === linked)!.findings).toEqual([
      "[critical] LINKED FINDING",
    ]);
  });

  it("falls back to the time window for rows filed before the session link existed", () => {
    const reviewId = seedSession({
      agentType: "review_code",
      startedAt: minutesAgo(30),
      createdAt: minutesAgo(30),
      endedAt: minutesAgo(20),
      completedAt: minutesAgo(20),
    });
    db.insert(reviewComments)
      .values({
        id: `f-legacy-${counter}`,
        epicId,
        filePath: "lib/legacy.ts",
        lineNumber: 3,
        body: "[major] LEGACY FINDING",
        author: "agent",
        status: "open",
        // agentSessionId deliberately absent — a pre-0032 row.
        createdAt: minutesAgo(25),
      })
      .run();

    const entry = collectDreamDigest(projectId, { now: NOW }).sessions.find(
      (s) => s.sessionId === reviewId
    )!;
    expect(entry.findings).toEqual(["[major] LEGACY FINDING"]);
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

  /**
   * Two stories of the SAME epic, running at overlapping times. The pipeline
   * files each post-mortem with the dead session's own userStoryId, so an
   * epic+time-only match would hand story A's diagnosis to story B — the
   * dream would then "learn" from a lesson that belongs to other code.
   */
  it("gives each story-scoped session its own forensic, not its neighbour's", () => {
    const storyA = `story-a-${counter}`;
    const storyB = `story-b-${counter}`;
    db.insert(userStories)
      .values({ id: storyA, epicId, title: "Refunds", position: 0 })
      .run();
    db.insert(userStories)
      .values({ id: storyB, epicId, title: "Invoices", position: 1 })
      .run();

    const sessionA = seedSession({
      userStoryId: storyA,
      status: "failed",
      outcome: "error",
      startedAt: minutesAgo(60),
      createdAt: minutesAgo(60),
      endedAt: minutesAgo(40),
      completedAt: minutesAgo(40),
    });
    const sessionB = seedSession({
      userStoryId: storyB,
      status: "failed",
      outcome: "error",
      startedAt: minutesAgo(55),
      createdAt: minutesAgo(55),
      endedAt: minutesAgo(35),
      completedAt: minutesAgo(35),
    });

    // Story B's post-mortem lands FIRST in time — an epic-only match would let
    // session A (which started earlier) claim it.
    db.insert(ticketComments)
      .values({
        id: `forensic-b-${counter}`,
        epicId,
        userStoryId: storyB,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n\nINVOICES DIAGNOSIS`,
        createdAt: minutesAgo(39),
      })
      .run();
    db.insert(ticketComments)
      .values({
        id: `forensic-a-${counter}`,
        epicId,
        userStoryId: storyA,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n\nREFUNDS DIAGNOSIS`,
        createdAt: minutesAgo(38),
      })
      .run();

    const { sessions } = collectDreamDigest(projectId, { now: NOW });
    expect(sessions.find((s) => s.sessionId === sessionA)!.forensic).toContain(
      "REFUNDS DIAGNOSIS"
    );
    expect(sessions.find((s) => s.sessionId === sessionB)!.forensic).toContain(
      "INVOICES DIAGNOSIS"
    );
  });

  /**
   * The exact link. A forensic agent can sit in the scheduler queue for a long
   * time before it writes, so a time-window match either misses its diagnostic
   * or hands it to a rerun. The marker the pipeline stamps into the comment
   * makes the attribution independent of when it landed.
   */
  it("uses the dead-session marker, however late the diagnostic lands", () => {
    const dead = seedSession({
      status: "failed",
      outcome: "error",
      startedAt: minutesAgo(200),
      createdAt: minutesAgo(200),
      endedAt: minutesAgo(190),
      completedAt: minutesAgo(190),
    });
    const laterRun = seedSession({
      startedAt: minutesAgo(60),
      createdAt: minutesAgo(60),
      endedAt: minutesAgo(50),
      completedAt: minutesAgo(50),
    });
    // Written 3 hours after the run it diagnoses — far outside the slack, and
    // squarely inside the later run's window.
    db.insert(ticketComments)
      .values({
        id: `forensic-late-${counter}`,
        epicId,
        userStoryId: null,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n${forensicDeadSessionMarker(dead)}\n\nLATE DIAGNOSIS`,
        createdAt: minutesAgo(45),
      })
      .run();

    const { sessions } = collectDreamDigest(projectId, { now: NOW });
    expect(sessions.find((s) => s.sessionId === dead)!.forensic).toContain(
      "LATE DIAGNOSIS"
    );
    expect(sessions.find((s) => s.sessionId === laterRun)!.forensic).toBeNull();
  });

  it("keeps the marker itself out of the digest", () => {
    const dead = seedSession({ status: "failed", outcome: "error" });
    db.insert(ticketComments)
      .values({
        id: `forensic-marker-${counter}`,
        epicId,
        userStoryId: null,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n${forensicDeadSessionMarker(dead)}\n\nCLEAN BODY`,
        createdAt: minutesAgo(49),
      })
      .run();

    const result = collectDreamDigest(projectId, { now: NOW });
    expect(result.sessions.find((s) => s.sessionId === dead)!.forensic).toBe(
      "CLEAN BODY"
    );
    expect(result.text).not.toContain("arij:dead-session");
  });

  it("attaches nothing when the marker names a session outside the window", () => {
    seedSession({ status: "failed", outcome: "error" });
    db.insert(ticketComments)
      .values({
        id: `forensic-orphan-${counter}`,
        epicId,
        userStoryId: null,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n${forensicDeadSessionMarker("sess-from-last-month")}\n\nORPHAN DIAGNOSIS`,
        createdAt: minutesAgo(49),
      })
      .run();

    const { sessions } = collectDreamDigest(projectId, { now: NOW });
    // No fallback to the heuristic: a marked comment belongs to the session it
    // names, and that one is not here.
    expect(sessions.every((s) => s.forensic === null)).toBe(true);
  });

  /**
   * A stage that failed, was retried, and failed again produces TWO sessions
   * of the same scope with overlapping attach windows. Attributing by "first
   * session in chronological order whose window covers the comment" would hand
   * the retry's post-mortem to the attempt before it — so the dream would
   * reason about a failure that belongs to a different revision of the code.
   */
  it("gives a rerun's post-mortem to the rerun, not to the attempt before it", () => {
    const firstAttempt = seedSession({
      status: "failed",
      outcome: "error",
      startedAt: minutesAgo(90),
      createdAt: minutesAgo(90),
      endedAt: minutesAgo(70),
      completedAt: minutesAgo(70),
      lastNonEmptyText: "attempt 1",
    });
    const retry = seedSession({
      status: "failed",
      outcome: "error",
      startedAt: minutesAgo(65),
      createdAt: minutesAgo(65),
      endedAt: minutesAgo(50),
      completedAt: minutesAgo(50),
      lastNonEmptyText: "attempt 2",
    });

    // Both diagnostics land inside the FIRST attempt's window (its end + the
    // 30-minute slack reaches minute 40), so only "closest terminal session"
    // separates them.
    db.insert(ticketComments)
      .values({
        id: `forensic-1st-${counter}`,
        epicId,
        userStoryId: null,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n\nATTEMPT ONE DIAGNOSIS`,
        createdAt: minutesAgo(69),
      })
      .run();
    db.insert(ticketComments)
      .values({
        id: `forensic-retry-${counter}`,
        epicId,
        userStoryId: null,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n\nRETRY DIAGNOSIS`,
        createdAt: minutesAgo(49),
      })
      .run();

    const { sessions } = collectDreamDigest(projectId, { now: NOW });
    expect(sessions.find((s) => s.sessionId === firstAttempt)!.forensic).toContain(
      "ATTEMPT ONE DIAGNOSIS"
    );
    expect(sessions.find((s) => s.sessionId === retry)!.forensic).toContain(
      "RETRY DIAGNOSIS"
    );
  });

  it("attributes a lone diagnostic to the run that had just ended", () => {
    seedSession({
      status: "failed",
      outcome: "error",
      startedAt: minutesAgo(90),
      createdAt: minutesAgo(90),
      endedAt: minutesAgo(70),
      completedAt: minutesAgo(70),
    });
    const retry = seedSession({
      status: "failed",
      outcome: "error",
      startedAt: minutesAgo(65),
      createdAt: minutesAgo(65),
      endedAt: minutesAgo(50),
      completedAt: minutesAgo(50),
    });
    db.insert(ticketComments)
      .values({
        id: `forensic-only-${counter}`,
        epicId,
        userStoryId: null,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n\nONLY DIAGNOSIS`,
        createdAt: minutesAgo(49),
      })
      .run();

    const { sessions } = collectDreamDigest(projectId, { now: NOW });
    const withForensic = sessions.filter((s) => s.forensic !== null);
    expect(withForensic).toHaveLength(1);
    expect(withForensic[0].sessionId).toBe(retry);
  });

  it("never hands an epic-scoped forensic to a story-scoped session", () => {
    const storyId = `story-solo-${counter}`;
    db.insert(userStories)
      .values({ id: storyId, epicId, title: "Solo", position: 0 })
      .run();
    const storySession = seedSession({
      userStoryId: storyId,
      status: "failed",
      outcome: "error",
      startedAt: minutesAgo(60),
      createdAt: minutesAgo(60),
      endedAt: minutesAgo(50),
      completedAt: minutesAgo(50),
    });
    db.insert(ticketComments)
      .values({
        id: `forensic-epic-${counter}`,
        epicId,
        userStoryId: null,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}\n\nEPIC LEVEL DIAGNOSIS`,
        createdAt: minutesAgo(49),
      })
      .run();

    const { sessions } = collectDreamDigest(projectId, { now: NOW });
    expect(
      sessions.find((s) => s.sessionId === storySession)!.forensic
    ).toBeNull();
  });

  /**
   * `agent_sessions.last_non_empty_text` holds only the last non-empty LINE of
   * the newest chunk. Preferring it collapsed a whole review report to one
   * line, and the mandated `**Overall Verdict: …**` survived only when it
   * happened to BE that line — so most verdicts silently vanished from the
   * digest. The persisted chunk streams are the real record.
   */
  it("reads the final response from the chunk stream, not the one-line column", () => {
    const reviewId = seedSession({
      agentType: "review_code",
      // What the column actually stores: the report's LAST line only.
      lastNonEmptyText: "Report filed.",
    });
    appendSessionChunk({
      sessionId: reviewId,
      streamType: "response",
      content:
        "## Findings\n\n- token logged in plain text\n\n" +
        "**Overall Verdict: Changes Requested**\n\nReport filed.",
    });

    const entry = collectDreamDigest(projectId, { now: NOW }).sessions.find(
      (s) => s.sessionId === reviewId
    )!;
    // The verdict is only reachable because the WHOLE response was resolved.
    expect(entry.reviewVerdict).toBe("Changes Requested");
    expect(entry.finalText).toContain("token logged in plain text");
  });

  it("falls back to the output stream when there is no response stream", () => {
    const buildId = seedSession({ lastNonEmptyText: "Done." });
    appendSessionChunk({
      sessionId: buildId,
      streamType: "output",
      content: "Rewrote the parser.\n\n**Overall Verdict: Approved**\nDone.",
    });

    const entry = collectDreamDigest(projectId, { now: NOW }).sessions.find(
      (s) => s.sessionId === buildId
    )!;
    expect(entry.reviewVerdict).toBe("Approved");
    expect(entry.finalText).toContain("Rewrote the parser.");
  });

  it("prefers the response stream over the output stream", () => {
    const sessionId = seedSession();
    appendSessionChunk({
      sessionId,
      streamType: "output",
      content: "OUTPUT STREAM TEXT",
    });
    appendSessionChunk({
      sessionId,
      streamType: "response",
      content: "RESPONSE STREAM TEXT",
    });

    const entry = collectDreamDigest(projectId, { now: NOW }).sessions.find(
      (s) => s.sessionId === sessionId
    )!;
    expect(entry.finalText).toContain("RESPONSE STREAM TEXT");
    expect(entry.finalText).not.toContain("OUTPUT STREAM TEXT");
  });

  it("still uses the one-line column when a session streamed no chunks", () => {
    const sessionId = seedSession({ lastNonEmptyText: "ONLY THE COLUMN" });

    const entry = collectDreamDigest(projectId, { now: NOW }).sessions.find(
      (s) => s.sessionId === sessionId
    )!;
    expect(entry.finalText).toBe("ONLY THE COLUMN");
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
