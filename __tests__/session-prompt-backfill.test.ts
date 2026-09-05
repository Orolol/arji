/**
 * Retroactive capping of `agent_sessions.prompt`.
 *
 * The write-path cap (`capSessionPrompt`) bounds what a NEW row may store and
 * leaves the backlog alone — the standing two-halves rule for any size
 * invariant. On a snapshot of the live database that backlog was 38 rows
 * holding 27.0 MB, and the half that was supposed to own it, the scheduled
 * retention routine, walked `agent_session_chunks` and nothing else.
 *
 * These tests pin the second half:
 *
 *   - the sweep exists at all, and the routine runs it (the regression);
 *   - it selects in BYTES, so a CJK prompt under the cap in CHARACTERS and
 *     well over it in bytes is not silently skipped — the failure mode a
 *     `length()` predicate or a SQL `substr()` would have;
 *   - a backfilled row is byte-identical to what the write path would have
 *     stored, so `splitCappedPrompt` and the echo scrub cannot tell them
 *     apart;
 *   - a run that prunes no chunks but caps a prompt is `completed` and
 *     vacuums, because that is exactly the measured live-database state.
 *
 * Run against the real migrated schema (createTestDb), not hand-written DDL:
 * the selection predicate is SQL and `length(CAST(... AS BLOB))` semantics are
 * the whole point.
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
const { agentSessions, projects, routines } = await import("@/lib/db/schema");
const {
  createSessionPromptBackfiller,
  DEFAULT_MAX_CAPPED_PROMPTS_PER_RUN,
} = await import("@/lib/agent-sessions/prompt-backfill");
const { capSessionPrompt } = await import("@/lib/agent-sessions/lifecycle");
const {
  SESSION_PROMPT_MAX_STORED_BYTES,
  isPromptElisionMarker,
  splitCappedPrompt,
} = await import("@/lib/agent-sessions/prompt-cap");
const { runRetentionRoutine } = await import("@/lib/routines/retention");
const {
  RETENTION_PROMPTS_VACUUMED_AT_CONFIG_KEY,
  RETENTION_VACUUMED_AT_CONFIG_KEY,
} = await import("@/lib/routines/constants");

const NOW = new Date("2026-09-05T12:00:00.000Z");
const PROJECT_ID = "project-prompt-backfill";
const OTHER_PROJECT_ID = "project-untouched";

/** ASCII filler of an exact BYTE length, since 1 char is 1 byte here. */
function asciiPrompt(bytes: number, seed: string): string {
  const head = `[${seed}] `;
  return head + "x".repeat(Math.max(0, bytes - head.length));
}

function seedSession(values: {
  id: string;
  prompt: string | null;
  projectId?: string;
  status?: string;
}): void {
  db.insert(agentSessions)
    .values({
      id: values.id,
      projectId: values.projectId ?? PROJECT_ID,
      status: values.status ?? "completed",
      prompt: values.prompt,
    })
    .run();
}

function storedPrompt(id: string): string | null {
  return (
    db
      .select({ prompt: agentSessions.prompt })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .get()?.prompt ?? null
  );
}

function storedBytes(id: string): number {
  return Buffer.byteLength(storedPrompt(id) ?? "", "utf8");
}

function backfill(maxRows: number = DEFAULT_MAX_CAPPED_PROMPTS_PER_RUN) {
  return createSessionPromptBackfiller(sqlite).backfill({
    projectId: PROJECT_ID,
    maxRows,
  });
}

beforeEach(() => {
  db.delete(routines).run();
  db.delete(agentSessions).run();
  db.delete(projects).run();
  db.insert(projects).values({ id: PROJECT_ID, name: "Backfill" }).run();
  db.insert(projects).values({ id: OTHER_PROJECT_ID, name: "Other" }).run();
});

describe("session prompt backfiller", () => {
  it("caps a stored prompt over the write-path cap and reports the bytes freed", () => {
    const original = asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 4, "huge");
    seedSession({ id: "oversized", prompt: original });

    const result = backfill();

    expect(result).toMatchObject({
      scannedSessions: 1,
      cappedPrompts: 1,
      reachedRowBudget: false,
    });
    expect(storedBytes("oversized")).toBeLessThan(
      SESSION_PROMPT_MAX_STORED_BYTES,
    );
    expect(result.reclaimedBytes).toBe(
      Buffer.byteLength(original, "utf8") - storedBytes("oversized"),
    );
    // Over 75% of a 4x-cap prompt: the reclaim is the point of the sweep.
    expect(result.reclaimedBytes).toBeGreaterThan(
      SESSION_PROMPT_MAX_STORED_BYTES * 3,
    );
  });

  it("writes the same marker the write path writes, so a backfilled row is indistinguishable from a natively capped one", () => {
    const original = asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 3, "marked");
    seedSession({ id: "marked", prompt: original });

    backfill();

    const stored = storedPrompt("marked")!;
    expect(stored).toBe(capSessionPrompt(original));

    const parts = splitCappedPrompt(stored);
    expect(parts).not.toBeNull();
    expect(stored.split("\n").some(isPromptElisionMarker)).toBe(true);
    // The invariant `stripPromptEcho` reads back out of the row: head, the
    // elided middle and tail add up to the prompt the CLI was handed.
    expect(
      Buffer.byteLength(parts!.head, "utf8") +
        parts!.elidedBytes +
        Buffer.byteLength(parts!.tail, "utf8"),
    ).toBe(Buffer.byteLength(original, "utf8"));
    expect(original.startsWith(parts!.head)).toBe(true);
    expect(original.endsWith(parts!.tail)).toBe(true);
  });

  it("selects on BYTES, so a CJK prompt under the cap in characters is still capped", () => {
    // 60,000 characters — comfortably under the 131,072 the cap would be if
    // it counted characters — and 180,000 UTF-8 bytes, well over it.
    const original = "汉字漢字".repeat(15_000);
    expect(original.length).toBeLessThan(SESSION_PROMPT_MAX_STORED_BYTES);
    expect(Buffer.byteLength(original, "utf8")).toBeGreaterThan(
      SESSION_PROMPT_MAX_STORED_BYTES,
    );
    seedSession({ id: "cjk", prompt: original });

    expect(backfill().cappedPrompts).toBe(1);

    const stored = storedPrompt("cjk")!;
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThan(
      SESSION_PROMPT_MAX_STORED_BYTES,
    );
    // A cut through the middle of a character decodes to U+FFFD. The head cut
    // lands at 106,496 bytes, which is not a multiple of 3 — so the boundary
    // walk is doing real work here, and a SQL substr() would not have.
    expect(stored).not.toContain("�");
    const parts = splitCappedPrompt(stored)!;
    expect(original.startsWith(parts.head)).toBe(true);
    expect(original.endsWith(parts.tail)).toBe(true);
  });

  it("keeps an emoji prompt's astral characters intact across both cuts", () => {
    const original = "🙂🚀".repeat(20_000); // 160,000 bytes, 80,000 chars
    expect(Buffer.byteLength(original, "utf8")).toBeGreaterThan(
      SESSION_PROMPT_MAX_STORED_BYTES,
    );
    seedSession({ id: "emoji", prompt: original });

    backfill();

    const stored = storedPrompt("emoji")!;
    expect(stored).not.toContain("�");
    expect(stored).toBe(capSessionPrompt(original));
  });

  it("leaves a prompt inside the cap byte-identical and never scans it", () => {
    const small = asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES / 4, "small");
    seedSession({ id: "small", prompt: small });
    seedSession({ id: "null-prompt", prompt: null });

    const result = backfill();

    expect(result).toMatchObject({ scannedSessions: 0, cappedPrompts: 0 });
    expect(storedPrompt("small")).toBe(small);
    expect(storedPrompt("null-prompt")).toBeNull();
  });

  it("is idempotent: a second run finds nothing left over the cap", () => {
    seedSession({
      id: "twice",
      prompt: asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 2, "twice"),
    });

    expect(backfill().cappedPrompts).toBe(1);
    const afterFirst = storedPrompt("twice");

    const second = backfill();
    expect(second).toMatchObject({
      scannedSessions: 0,
      cappedPrompts: 0,
      reclaimedBytes: 0,
    });
    expect(storedPrompt("twice")).toBe(afterFirst);
  });

  it("caps the biggest rows first and leaves the remainder for the next run", () => {
    seedSession({
      id: "biggest",
      prompt: asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 5, "biggest"),
    });
    seedSession({
      id: "middle",
      prompt: asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 3, "middle"),
    });
    const smallestOriginal = asciiPrompt(
      SESSION_PROMPT_MAX_STORED_BYTES * 2,
      "smallest",
    );
    seedSession({ id: "smallest", prompt: smallestOriginal });

    const first = backfill(2);
    expect(first).toMatchObject({
      scannedSessions: 2,
      cappedPrompts: 2,
      reachedRowBudget: true,
    });
    expect(storedBytes("biggest")).toBeLessThan(SESSION_PROMPT_MAX_STORED_BYTES);
    expect(storedBytes("middle")).toBeLessThan(SESSION_PROMPT_MAX_STORED_BYTES);
    expect(storedPrompt("smallest")).toBe(smallestOriginal);

    const second = backfill(2);
    expect(second).toMatchObject({ cappedPrompts: 1, reachedRowBudget: false });
    expect(storedBytes("smallest")).toBeLessThan(
      SESSION_PROMPT_MAX_STORED_BYTES,
    );
  });

  it("never touches another project's prompts", () => {
    const foreign = asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 2, "foreign");
    seedSession({
      id: "foreign",
      prompt: foreign,
      projectId: OTHER_PROJECT_ID,
    });

    expect(backfill()).toMatchObject({ scannedSessions: 0, cappedPrompts: 0 });
    expect(storedPrompt("foreign")).toBe(foreign);
  });

  it("caps a running session's prompt too — the cap is a column invariant, not a retention decision", () => {
    seedSession({
      id: "running",
      status: "running",
      prompt: asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 2, "running"),
    });

    expect(backfill().cappedPrompts).toBe(1);
    expect(storedBytes("running")).toBeLessThan(SESSION_PROMPT_MAX_STORED_BYTES);
  });
});

describe("retention routine — prompt backfill", () => {
  function seedRoutine(config: Record<string, unknown> = {}) {
    db.insert(routines)
      .values({
        id: "routine-retention",
        projectId: PROJECT_ID,
        kind: "retention",
        timeOfDay: "04:30",
        config: JSON.stringify(config),
      })
      .run();
    return db
      .select()
      .from(routines)
      .where(eq(routines.id, "routine-retention"))
      .get()!;
  }

  it("caps oversized stored prompts through the default dependencies, with nothing to prune", async () => {
    const original = asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 4, "wired");
    seedSession({ id: "wired", prompt: original });

    const result = await runRetentionRoutine(seedRoutine(), undefined, NOW);

    expect(result.status).toBe("completed");
    expect(storedBytes("wired")).toBeLessThan(SESSION_PROMPT_MAX_STORED_BYTES);
    expect(storedPrompt("wired")).toBe(capSessionPrompt(original));
    expect(result.message).toContain("1 stored prompt capped");
  });

  function storedConfig(): Record<string, unknown> {
    return JSON.parse(
      db
        .select({ config: routines.config })
        .from(routines)
        .where(eq(routines.id, "routine-retention"))
        .get()!.config,
    ) as Record<string, unknown>;
  }

  it("vacuums for a prompt-only run: reclaiming the pages is the point", async () => {
    seedSession({
      id: "vacuum-me",
      prompt: asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 2, "vacuum"),
    });

    const result = await runRetentionRoutine(seedRoutine(), undefined, NOW);

    expect(result.message).toContain("database vacuumed");
    // Its OWN claim. Spending the chunk prune's would leave that backlog with
    // no rewrite left when it eventually comes due.
    const stored = storedConfig();
    expect(stored[RETENTION_PROMPTS_VACUUMED_AT_CONFIG_KEY]).toBe(
      NOW.toISOString(),
    );
    expect(stored[RETENTION_VACUUMED_AT_CONFIG_KEY]).toBeUndefined();
  });

  /**
   * The reason the two claims are separate. A database whose chunks were
   * pruned and vacuumed before the prompt sweep existed — which is every
   * database that already runs this routine — must still get one rewrite for
   * the 22 MB the prompt sweep frees, or those bytes sit on SQLite's free
   * list forever.
   */
  it("still vacuums for the prompt backlog on a database that already vacuumed its chunks", async () => {
    seedSession({
      id: "late-sweep",
      prompt: asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 2, "late"),
    });

    const result = await runRetentionRoutine(
      seedRoutine({
        [RETENTION_VACUUMED_AT_CONFIG_KEY]: "2026-08-01T04:30:00.000Z",
      }),
      undefined,
      NOW,
    );

    expect(result.message).toContain("database vacuumed");
    const stored = storedConfig();
    expect(stored[RETENTION_PROMPTS_VACUUMED_AT_CONFIG_KEY]).toBe(
      NOW.toISOString(),
    );
    // The older claim survives the write rather than being reset by it.
    expect(stored[RETENTION_VACUUMED_AT_CONFIG_KEY]).toBe(
      "2026-08-01T04:30:00.000Z",
    );
  });

  it("does not vacuum a second time for a prompt backlog it already cleared", async () => {
    seedSession({
      id: "second-pass",
      prompt: asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 2, "second"),
    });

    const result = await runRetentionRoutine(
      seedRoutine({
        [RETENTION_PROMPTS_VACUUMED_AT_CONFIG_KEY]: "2026-08-01T04:30:00.000Z",
      }),
      undefined,
      NOW,
    );

    // The prompt is still capped — only the one-shot rewrite is spent.
    expect(result.status).toBe("completed");
    expect(storedBytes("second-pass")).toBeLessThan(
      SESSION_PROMPT_MAX_STORED_BYTES,
    );
    expect(result.message).not.toContain("database vacuumed");
  });

  it("stays a quiet skip when no prompt is over the cap and nothing was pruned", async () => {
    seedSession({
      id: "inside-cap",
      prompt: asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES / 2, "inside"),
    });

    const result = await runRetentionRoutine(seedRoutine(), undefined, NOW);

    expect(result.status).toBe("skipped");
    expect(result.shouldNotify).toBe(false);
    expect(result.message).toContain("no stored prompt is over its cap");
  });

  it("rejects a malformed prompt budget instead of sweeping with a guess", async () => {
    await expect(
      runRetentionRoutine(seedRoutine({ maxCappedPrompts: 0 }), undefined, NOW),
    ).rejects.toThrow(/maxCappedPrompts/);
  });

  it("reports the per-run prompt budget when it leaves rows behind", async () => {
    for (const seed of ["a", "b", "c"]) {
      seedSession({
        id: `budgeted-${seed}`,
        prompt: asciiPrompt(SESSION_PROMPT_MAX_STORED_BYTES * 2, seed),
      });
    }

    const result = await runRetentionRoutine(
      seedRoutine({ maxCappedPrompts: 2 }),
      undefined,
      NOW,
    );

    expect(result.message).toContain("2 stored prompts capped");
    expect(result.message).toContain("stopped at the 2-prompt budget");
  });
});
