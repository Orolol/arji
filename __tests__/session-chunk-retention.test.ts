/**
 * Scheduled retention for `agent_session_chunks`.
 *
 * Nothing in Arij ever deleted session output: 126,953 chunk rows holding
 * 395.5 MB on the live database, from 531 sessions. The retention routine
 * prunes what is past its window; these tests pin what it must NOT take with
 * it.
 *
 * The load-bearing invariant is the forensic one. `readChunkTail`
 * (lib/pipeline/forensic.ts) joins a session's stream and slices the last N
 * characters, so a prune that keeps at least N characters leaves the forensic
 * prompt identical. Every "tail survives" assertion below compares the real
 * `readChunkTail` output before and after the prune rather than counting
 * rows — a row count would pass while the tail silently shifted.
 *
 * Run against the real migrated schema (createTestDb), not a hand-written
 * table: the eligibility filter is SQL, and `length()` semantics are exactly
 * what the boundary arithmetic depends on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: { start: vi.fn(), getStatus: vi.fn() },
}));

const { db, sqlite } = await import("@/lib/db");
const { agentSessionChunks, agentSessions, projects, routines, settings } =
  await import("@/lib/db/schema");
const { createSessionChunkPruner, PRUNE_MIN_TRUNCATION_CHARS } = await import(
  "@/lib/agent-sessions/chunk-prune"
);
const { isChunkPruneMarker } = await import(
  "@/lib/agent-sessions/chunk-retention"
);
const {
  DEFAULT_SESSION_CHUNK_RETENTION_DAYS,
  resolveSessionChunkRetentionDays,
  retentionCutoff,
  runRetentionRoutine,
  SESSION_CHUNK_RETAINED_TAIL_CHARS,
  SESSION_CHUNK_RETENTION_DAYS_SETTING_KEY,
  sessionChunkRetentionDaysSettingKey,
} = await import("@/lib/routines/retention");
const { readChunkTail } = await import("@/lib/pipeline/forensic");
const { RETENTION_VACUUMED_AT_CONFIG_KEY, isDailyRoutineKind } = await import(
  "@/lib/routines/constants"
);
const { isRoutineDue } = await import("@/lib/routines/scheduler");
const { FORENSIC_RAW_TAIL_MAX_CHARS, FORENSIC_OUTPUT_TAIL_MAX_CHARS } =
  await import("@/lib/pipeline/constants");

const NOW = new Date("2026-09-05T12:00:00.000Z");
const PROJECT_ID = "project-retention";

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

let sequence = 0;

function seedSession(values: {
  id: string;
  status: string;
  endedAt?: string | null;
  createdAt?: string | null;
  lastNonEmptyText?: string | null;
}): void {
  db.insert(agentSessions)
    .values({
      id: values.id,
      projectId: PROJECT_ID,
      status: values.status,
      endedAt: values.endedAt ?? null,
      createdAt: values.createdAt ?? values.endedAt ?? daysAgo(1),
      lastNonEmptyText: values.lastNonEmptyText ?? null,
    })
    .run();
}

function seedChunk(
  sessionId: string,
  streamType: "raw" | "output" | "response",
  content: string,
): void {
  sequence += 1;
  db.insert(agentSessionChunks)
    .values({
      id: `chunk-${sequence}`,
      sessionId,
      streamType,
      sequence,
      chunkKey: `key-${sequence}`,
      content,
    })
    .run();
}

/** Distinguishable filler: every chunk's text names its own index. */
function filler(index: number, chars: number): string {
  const seed = `[chunk ${index}] `;
  return seed + "x".repeat(Math.max(0, chars - seed.length));
}

function chunkCount(sessionId: string, streamType?: string): number {
  const rows = db
    .select({ id: agentSessionChunks.id, streamType: agentSessionChunks.streamType })
    .from(agentSessionChunks)
    .where(eq(agentSessionChunks.sessionId, sessionId))
    .all();
  return streamType
    ? rows.filter((row) => row.streamType === streamType).length
    : rows.length;
}

function storedChars(sessionId: string): number {
  return (
    sqlite
      .prepare(
        "SELECT COALESCE(SUM(length(content)), 0) AS chars FROM agent_session_chunks WHERE session_id = ?",
      )
      .get(sessionId) as { chars: number }
  ).chars;
}

function prune(overrides: Partial<{ cutoffDays: number; maxDeletedChunks: number }> = {}) {
  return createSessionChunkPruner(sqlite).prune({
    projectId: PROJECT_ID,
    cutoff: retentionCutoff(NOW, overrides.cutoffDays ?? 30),
    tailChars: SESSION_CHUNK_RETAINED_TAIL_CHARS,
    maxDeletedChunks: overrides.maxDeletedChunks ?? 50_000,
    prunedAt: NOW.toISOString(),
  });
}

beforeEach(() => {
  db.delete(agentSessionChunks).run();
  db.delete(routines).run();
  db.delete(agentSessions).run();
  db.delete(settings).run();
  db.delete(projects).run();
  db.insert(projects).values({ id: PROJECT_ID, name: "Retention" }).run();
  sequence = 0;
});

describe("session chunk pruner", () => {
  it("prunes a terminal session past the window and leaves its forensic tail identical", () => {
    seedSession({
      id: "old-session",
      status: "completed",
      endedAt: daysAgo(40),
      lastNonEmptyText: "the agent's final word",
    });
    for (let index = 0; index < 40; index += 1) {
      seedChunk("old-session", "raw", filler(index, 2000));
    }
    for (let index = 0; index < 20; index += 1) {
      seedChunk("old-session", "output", filler(index, 1000));
    }

    const rawTailBefore = readChunkTail(
      "old-session",
      "raw",
      FORENSIC_RAW_TAIL_MAX_CHARS,
    );
    const outputTailBefore = readChunkTail(
      "old-session",
      "output",
      FORENSIC_OUTPUT_TAIL_MAX_CHARS,
    );
    expect(rawTailBefore).toHaveLength(FORENSIC_RAW_TAIL_MAX_CHARS);
    expect(outputTailBefore).toHaveLength(FORENSIC_OUTPUT_TAIL_MAX_CHARS);
    const charsBefore = storedChars("old-session");

    const result = prune();

    expect(result.prunedSessions).toBe(1);
    expect(result.deletedChunks).toBeGreaterThan(0);
    expect(chunkCount("old-session", "raw")).toBeLessThan(40);
    expect(chunkCount("old-session", "output")).toBeLessThan(20);
    expect(storedChars("old-session")).toBeLessThan(charsBefore);

    // The whole point: the forensic agent reads exactly what it read before.
    expect(
      readChunkTail("old-session", "raw", FORENSIC_RAW_TAIL_MAX_CHARS),
    ).toBe(rawTailBefore);
    expect(
      readChunkTail("old-session", "output", FORENSIC_OUTPUT_TAIL_MAX_CHARS),
    ).toBe(outputTailBefore);

    // And `lastNonEmptyText` lives on the row, untouched by any chunk delete.
    expect(
      db
        .select({ text: agentSessions.lastNonEmptyText })
        .from(agentSessions)
        .where(eq(agentSessions.id, "old-session"))
        .get()?.text,
    ).toBe("the agent's final word");
  });

  it("marks the surviving head of a pruned stream", () => {
    seedSession({ id: "marked", status: "failed", endedAt: daysAgo(60) });
    for (let index = 0; index < 30; index += 1) {
      seedChunk("marked", "raw", filler(index, 2000));
    }

    prune();

    const oldest = db
      .select({ content: agentSessionChunks.content })
      .from(agentSessionChunks)
      .where(eq(agentSessionChunks.sessionId, "marked"))
      .orderBy(agentSessionChunks.sequence)
      .all()[0];
    expect(isChunkPruneMarker(oldest.content.split("\n")[0])).toBe(true);
  });

  it("never prunes running, queued or in-window sessions", () => {
    seedSession({ id: "running", status: "running", createdAt: daysAgo(90) });
    seedSession({ id: "queued", status: "queued", createdAt: daysAgo(90) });
    seedSession({ id: "recent", status: "completed", endedAt: daysAgo(3) });
    for (const id of ["running", "queued", "recent"]) {
      for (let index = 0; index < 30; index += 1) {
        seedChunk(id, "raw", filler(index, 2000));
      }
    }

    const result = prune();

    expect(result.scannedSessions).toBe(0);
    expect(result.deletedChunks).toBe(0);
    expect(chunkCount("running")).toBe(30);
    expect(chunkCount("queued")).toBe(30);
    expect(chunkCount("recent")).toBe(30);
  });

  it("reads a CURRENT_TIMESTAMP-shaped created_at as the instant it means", () => {
    // `agent_sessions.created_at` DEFAULTs to CURRENT_TIMESTAMP, which SQLite
    // renders space-separated. Compared as raw text against an ISO cutoff, a
    // same-day row of that shape sorts BELOW the cutoff and reads as older
    // than it is — and the direction of that error is deletion.
    // Six hours INSIDE the window, on the very day the cutoff falls: the one
    // day where raw text comparison and chronology disagree.
    const insideWindow = new Date(
      retentionCutoff(NOW, 30),
    ).getTime() + 6 * 3_600_000;
    const sqliteShaped = new Date(insideWindow)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    expect(sqliteShaped.slice(0, 10)).toBe(retentionCutoff(NOW, 30).slice(0, 10));
    sqlite
      .prepare(
        "INSERT INTO agent_sessions (id, project_id, status, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("default-stamped", PROJECT_ID, "completed", sqliteShaped);
    for (let index = 0; index < 20; index += 1) {
      seedChunk("default-stamped", "raw", filler(index, 2000));
    }

    expect(prune().scannedSessions).toBe(0);
    expect(chunkCount("default-stamped")).toBe(20);
  });

  it("derives lastNonEmptyText from the chunks it is about to delete", () => {
    seedSession({
      id: "no-last-text",
      status: "completed",
      endedAt: daysAgo(40),
      lastNonEmptyText: null,
    });
    for (let index = 0; index < 30; index += 1) {
      seedChunk("no-last-text", "response", filler(index, 500));
    }
    seedChunk("no-last-text", "response", "closing statement\n\n");

    const result = prune();

    expect(result.preservedLastTexts).toBe(1);
    expect(
      db
        .select({ text: agentSessions.lastNonEmptyText })
        .from(agentSessions)
        .where(eq(agentSessions.id, "no-last-text"))
        .get()?.text,
    ).toBe("closing statement");
  });

  it("trims a single oversized chunk down to its retained tail", () => {
    seedSession({ id: "one-blob", status: "completed", endedAt: daysAgo(40) });
    const blob = filler(0, FORENSIC_RAW_TAIL_MAX_CHARS + 200_000);
    seedChunk("one-blob", "raw", blob);

    const tailBefore = readChunkTail(
      "one-blob",
      "raw",
      FORENSIC_RAW_TAIL_MAX_CHARS,
    );
    const result = prune();

    expect(result.deletedChunks).toBe(0);
    expect(result.truncatedChunks).toBe(1);
    expect(result.reclaimedChars).toBeGreaterThan(190_000);
    expect(chunkCount("one-blob", "raw")).toBe(1);
    expect(storedChars("one-blob")).toBeLessThan(blob.length / 10);
    expect(readChunkTail("one-blob", "raw", FORENSIC_RAW_TAIL_MAX_CHARS)).toBe(
      tailBefore,
    );
  });

  it("drops the chunk_key of a rewritten row, since it no longer digests it", () => {
    seedSession({ id: "rekeyed", status: "completed", endedAt: daysAgo(40) });
    for (let index = 0; index < 10; index += 1) {
      seedChunk("rekeyed", "raw", filler(index, 2000));
    }

    prune();

    const oldest = db
      .select({
        chunkKey: agentSessionChunks.chunkKey,
        content: agentSessionChunks.content,
      })
      .from(agentSessionChunks)
      .where(eq(agentSessionChunks.sessionId, "rekeyed"))
      .orderBy(agentSessionChunks.sequence)
      .all()[0];
    expect(isChunkPruneMarker(oldest.content.split("\n")[0])).toBe(true);
    expect(oldest.chunkKey).toBeNull();
  });

  it("is idempotent: a second pass finds nothing left to prune", () => {
    seedSession({ id: "twice", status: "cancelled", endedAt: daysAgo(40) });
    for (let index = 0; index < 30; index += 1) {
      seedChunk("twice", "raw", filler(index, 2000));
    }

    const first = prune();
    expect(first.prunedSessions).toBe(1);
    const afterFirst = storedChars("twice");
    const tailAfterFirst = readChunkTail(
      "twice",
      "raw",
      FORENSIC_RAW_TAIL_MAX_CHARS,
    );

    const second = prune();

    expect(second.scannedSessions).toBe(1);
    expect(second.prunedSessions).toBe(0);
    expect(second.deletedChunks).toBe(0);
    expect(storedChars("twice")).toBe(afterFirst);
    expect(readChunkTail("twice", "raw", FORENSIC_RAW_TAIL_MAX_CHARS)).toBe(
      tailAfterFirst,
    );
    // The marker a prune writes is content the next pass measures; the
    // truncation floor is what stops it eating into the tail one marker at a
    // time.
    expect(PRUNE_MIN_TRUNCATION_CHARS).toBeGreaterThan(200);
  });

  it("stops at the per-run delete budget and leaves the rest for tomorrow", () => {
    for (const id of ["batch-a", "batch-b"]) {
      seedSession({ id, status: "completed", endedAt: daysAgo(40) });
      for (let index = 0; index < 20; index += 1) {
        seedChunk(id, "raw", filler(index, 2000));
      }
    }

    const result = prune({ maxDeletedChunks: 1 });

    expect(result.reachedDeleteBudget).toBe(true);
    expect(result.scannedSessions).toBe(1);
    expect(chunkCount("batch-b")).toBe(20);
  });
});

describe("retention window setting", () => {
  it("falls back to the documented default", () => {
    expect(resolveSessionChunkRetentionDays(PROJECT_ID)).toBe(
      DEFAULT_SESSION_CHUNK_RETENTION_DAYS,
    );
    expect(DEFAULT_SESSION_CHUNK_RETENTION_DAYS).toBe(30);
  });

  it("prefers a project override over the global key", () => {
    db.insert(settings)
      .values({ key: SESSION_CHUNK_RETENTION_DAYS_SETTING_KEY, value: "90" })
      .run();
    expect(resolveSessionChunkRetentionDays(PROJECT_ID)).toBe(90);

    db.insert(settings)
      .values({
        key: sessionChunkRetentionDaysSettingKey(PROJECT_ID),
        value: JSON.stringify(7),
      })
      .run();
    expect(resolveSessionChunkRetentionDays(PROJECT_ID)).toBe(7);
  });

  it("ignores a value that would delete everything", () => {
    for (const value of ["0", "-5", "not a number", "1.5", ""]) {
      db.delete(settings).run();
      db.insert(settings)
        .values({ key: SESSION_CHUNK_RETENTION_DAYS_SETTING_KEY, value })
        .run();
      expect(resolveSessionChunkRetentionDays(PROJECT_ID)).toBe(
        DEFAULT_SESSION_CHUNK_RETENTION_DAYS,
      );
    }
  });
});

describe("retention routine", () => {
  function routine(config: Record<string, unknown> = {}) {
    return {
      id: "routine-retention",
      projectId: PROJECT_ID,
      kind: "retention" as const,
      enabled: true,
      timeOfDay: "04:30",
      config: JSON.stringify(config),
      lastRunAt: null,
      lastStatus: null,
    };
  }

  function deps(pruned: number) {
    return {
      resolveRetentionDays: vi.fn(() => 30),
      prune: vi.fn(() => ({
        scannedSessions: 5,
        prunedSessions: pruned,
        deletedChunks: pruned * 10,
        truncatedChunks: 1,
        reclaimedChars: 4_000_000,
        preservedLastTexts: 1,
        reachedDeleteBudget: false,
      })),
      vacuum: vi.fn(),
      claimVacuum: vi.fn(),
    };
  }

  it("is a daily routine and becomes due after its slot", () => {
    expect(isDailyRoutineKind("retention")).toBe(true);
    expect(
      isRoutineDue(routine(), new Date("2026-09-05T05:00:00")),
    ).toBe(true);
    expect(
      isRoutineDue(routine(), new Date("2026-09-05T04:00:00")),
    ).toBe(false);
    expect(
      isRoutineDue(
        { ...routine(), lastRunAt: new Date("2026-09-05T04:31:00").toISOString() },
        new Date("2026-09-05T23:00:00"),
      ),
    ).toBe(false);
  });

  it("vacuums once, claiming it durably before the rewrite", async () => {
    const first = deps(3);
    const completed = await runRetentionRoutine(routine(), first, NOW);

    expect(completed.status).toBe("completed");
    expect(first.vacuum).toHaveBeenCalledTimes(1);
    expect(first.claimVacuum).toHaveBeenCalledWith(
      "routine-retention",
      NOW.toISOString(),
    );
    expect(first.claimVacuum.mock.invocationCallOrder[0]).toBeLessThan(
      first.vacuum.mock.invocationCallOrder[0],
    );
    expect(completed.message).toContain("database vacuumed");

    const second = deps(3);
    const again = await runRetentionRoutine(
      routine({ [RETENTION_VACUUMED_AT_CONFIG_KEY]: NOW.toISOString() }),
      second,
      NOW,
    );
    expect(second.vacuum).not.toHaveBeenCalled();
    expect(again.message).not.toContain("database vacuumed");
  });

  it("does not vacuum when nothing was pruned, and stays quiet about it", async () => {
    const quiet = deps(0);
    const result = await runRetentionRoutine(routine(), quiet, NOW);

    expect(result.status).toBe("skipped");
    expect(result.shouldNotify).toBe(false);
    expect(quiet.vacuum).not.toHaveBeenCalled();
    expect(quiet.claimVacuum).not.toHaveBeenCalled();
  });

  it("honours an explicit vacuum opt-out", async () => {
    const optedOut = deps(3);
    await runRetentionRoutine(routine({ vacuum: false }), optedOut, NOW);
    expect(optedOut.vacuum).not.toHaveBeenCalled();
  });

  it("rejects a malformed per-run budget instead of pruning with a guess", async () => {
    await expect(
      runRetentionRoutine(routine({ maxDeletedChunks: 0 }), deps(3), NOW),
    ).rejects.toThrow(/maxDeletedChunks/);
  });

  it("prunes the real database end to end through the default dependencies", async () => {
    seedSession({ id: "wired", status: "completed", endedAt: daysAgo(40) });
    for (let index = 0; index < 30; index += 1) {
      seedChunk("wired", "raw", filler(index, 2000));
    }
    const tailBefore = readChunkTail(
      "wired",
      "raw",
      FORENSIC_RAW_TAIL_MAX_CHARS,
    );
    db.insert(routines)
      .values({
        id: "routine-retention",
        projectId: PROJECT_ID,
        kind: "retention",
        timeOfDay: "04:30",
        config: "{}",
      })
      .run();

    const result = await runRetentionRoutine(
      db.select().from(routines).where(eq(routines.id, "routine-retention")).get()!,
      undefined,
      NOW,
    );

    expect(result.status).toBe("completed");
    expect(chunkCount("wired", "raw")).toBeLessThan(30);
    expect(readChunkTail("wired", "raw", FORENSIC_RAW_TAIL_MAX_CHARS)).toBe(
      tailBefore,
    );
    // The one-shot VACUUM claim is durable, so a restart cannot replay it.
    const stored = JSON.parse(
      db
        .select({ config: routines.config })
        .from(routines)
        .where(eq(routines.id, "routine-retention"))
        .get()!.config,
    ) as Record<string, unknown>;
    expect(stored[RETENTION_VACUUMED_AT_CONFIG_KEY]).toBe(NOW.toISOString());
  });
});
