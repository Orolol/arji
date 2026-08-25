/**
 * Dreaming — dispatch, guards and triggers, end-to-end against the real
 * migrated schema with the CLI spawn mocked.
 *
 * Covers the acceptance criteria of "Session dreaming + réécriture gardée" and
 * "Déclencheurs + garde-fous + notification":
 *   - a plan-mode 'dreaming' session with NO epicId, carrying the imposed
 *     section structure and the cross-session digest,
 *   - the memory is replaced ONLY when the session delivers (asked_question,
 *     silent and failures leave it exactly as it was),
 *   - the pre-dream memory is snapshotted and a deep-linked notification
 *     summarizes the change,
 *   - never two dreams at once on a project,
 *   - a journalled no-op when nothing happened since the last dream,
 *   - the night-run trigger: OFF by default, tri-state resolution, and the
 *     run id inherited as batch_run_id so the dream stays inside the cost cap.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

const processManagerState = vi.hoisted(() => ({
  result: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => ({
      status: "completed",
      result: processManagerState.result,
    })),
  },
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("dreaming system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  })),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw new Error("no logs in tests");
    }),
  },
}));

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions, settings, notifications } = await import(
  "@/lib/db/schema"
);
const {
  dispatchDreamingSession,
  evaluateDreamGuards,
  hasPendingDream,
  isDreamingAfterNightRunEnabled,
  maybeDreamAfterNightRun,
  sanitizeDreamedMemory,
} = await import("@/lib/workflow/dreaming");
const {
  getProjectMemoryArchiveDoc,
  getProjectMemoryContent,
  saveProjectMemory,
} = await import("@/lib/documents/memory");
const { PROJECT_MEMORY_MAX_CHARS } = await import(
  "@/lib/documents/memory-constants"
);
const {
  DREAMING_AFTER_NIGHT_RUN_SETTING_KEY,
  DREAMING_AGENT_TYPE,
  dreamingAfterNightRunSettingKey,
} = await import("@/lib/workflow/dreaming-constants");
const { DREAMING_MEMORY_SECTIONS } = await import("@/lib/claude/prompt-builder");
const { sumNightRunCost } = await import("@/lib/night/summary");

let counter = 0;
let projectId = "";
let epicId = "";

async function flushBackground() {
  await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
}

function claudeEnvelope(text: string, costUsd?: number): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: text,
    ...(costUsd !== undefined ? { total_cost_usd: costUsd } : {}),
  });
}

function seedProject() {
  counter += 1;
  projectId = `proj-dreamd-${counter}`;
  epicId = `epic-dreamd-${counter}`;
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
      readableId: `E-dd-${counter}`,
    })
    .run();
}

let sessionSeq = 0;

function seedSourceSession(
  overrides: Partial<typeof agentSessions.$inferInsert> = {}
): string {
  sessionSeq += 1;
  const id = `src-${counter}-${sessionSeq}`;
  const now = new Date().toISOString();
  db.insert(agentSessions)
    .values({
      id,
      projectId,
      epicId,
      status: "completed",
      agentType: "ticket_build",
      outcome: "answered",
      provider: "claude-code",
      lastNonEmptyText: "Learned: envelope every API response.",
      createdAt: now,
      startedAt: now,
      endedAt: now,
      completedAt: now,
      ...overrides,
    })
    .run();
  return id;
}

function dreamSessions() {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.projectId, projectId))
    .all()
    .filter((row) => row.agentType === DREAMING_AGENT_TYPE);
}

beforeEach(() => {
  vi.clearAllMocks();
  seedProject();
  processManagerState.result = {
    success: true,
    result: claudeEnvelope(
      DREAMING_MEMORY_SECTIONS.map((title) => `## ${title}\n\n- something`).join(
        "\n\n"
      )
    ),
    duration: 1000,
  };
});

describe("evaluateDreamGuards", () => {
  it("refuses while another dream is pending", () => {
    const decision = evaluateDreamGuards({
      hasPendingDream: true,
      sessionCount: 12,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("already pending");
  });

  it("refuses when the window turned up nothing", () => {
    const decision = evaluateDreamGuards({
      hasPendingDream: false,
      sessionCount: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("no new sessions");
  });

  it("allows a project with fresh evidence and no dream in flight", () => {
    expect(
      evaluateDreamGuards({ hasPendingDream: false, sessionCount: 1 })
    ).toEqual({ allowed: true, reason: "eligible" });
  });
});

describe("dispatchDreamingSession", () => {
  it("runs a plan-mode dreaming session and replaces the memory on delivery", async () => {
    saveProjectMemory(projectId, "- Old rule: keep tests green");
    seedSourceSession({ lastNonEmptyText: "SOURCE SESSION TEXT" });

    const result = await dispatchDreamingSession({ projectId, trigger: "manual" });
    await flushBackground();

    expect(result.dispatched).toBe(true);
    expect(result.sessionsAnalyzed).toBe(1);

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.sessionId!))
      .get();
    expect(session).toMatchObject({
      agentType: "dreaming",
      status: "completed",
      outcome: "answered",
      projectId,
      mode: "plan",
      // Never holds an epic slot: a dream spans every ticket and must block none.
      epicId: null,
      batchRunId: null,
    });

    // The prompt frames the current memory, the digest and the imposed sections.
    expect(session!.prompt).toContain("dreaming system prompt");
    expect(session!.prompt).toContain("## Current Project Memory");
    expect(session!.prompt).toContain("- Old rule: keep tests green");
    expect(session!.prompt).toContain("## Recent Sessions Digest");
    expect(session!.prompt).toContain("SOURCE SESSION TEXT");
    expect(session!.prompt).toContain("**Sessions analyzed:** 1");
    for (const title of DREAMING_MEMORY_SECTIONS) {
      expect(session!.prompt).toContain(`## ${title}`);
    }

    // The memory document now holds the dreamed text.
    const memory = getProjectMemoryContent(projectId)!;
    for (const title of DREAMING_MEMORY_SECTIONS) {
      expect(memory).toContain(`## ${title}`);
    }
  });

  it("snapshots the memory it overwrites", async () => {
    saveProjectMemory(projectId, "- Rule that is about to be replaced");
    seedSourceSession();

    await dispatchDreamingSession({ projectId });
    await flushBackground();

    const archive = getProjectMemoryArchiveDoc(projectId);
    expect(archive?.markdownContent).toBe("- Rule that is about to be replaced");
    expect(archive?.kind).toBe("memory_archive");
    // The live memory moved on.
    expect(getProjectMemoryContent(projectId)).not.toBe(
      "- Rule that is about to be replaced"
    );
  });

  it("notifies with a deep link and a summary of the change", async () => {
    saveProjectMemory(projectId, "x".repeat(120));
    seedSourceSession();

    const result = await dispatchDreamingSession({ projectId });
    await flushBackground();

    const notification = db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, projectId))
      .all()
      .find((row) => row.agentType === DREAMING_AGENT_TYPE);
    expect(notification).toBeDefined();
    expect(notification!.title).toContain("Project memory updated by Dreaming");
    expect(notification!.title).toContain("1 session analyzed");
    expect(notification!.title).toContain("120 → ");
    expect(notification!.targetUrl).toBe(`/projects/${projectId}/documents`);
    expect(notification!.sessionId).toBe(result.sessionId);
  });

  it("enforces the memory cap on the dreamed output", async () => {
    seedSourceSession();
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("m".repeat(PROJECT_MEMORY_MAX_CHARS + 2000)),
      duration: 1000,
    };

    await dispatchDreamingSession({ projectId });
    await flushBackground();

    expect(getProjectMemoryContent(projectId)).toHaveLength(
      PROJECT_MEMORY_MAX_CHARS
    );
    expect(PROJECT_MEMORY_MAX_CHARS).toBe(8000);
  });

  it("unwraps an accidental full-document code fence", async () => {
    seedSourceSession();
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("```markdown\n## Codebase pitfalls\n\n- fenced\n```"),
      duration: 1000,
    };

    await dispatchDreamingSession({ projectId });
    await flushBackground();

    expect(getProjectMemoryContent(projectId)).toBe(
      "## Codebase pitfalls\n\n- fenced"
    );
  });

  it("inherits the batch run id so the dream stays inside the night cost cap", async () => {
    const runId = `night_dream_${counter}`;
    seedSourceSession({ batchRunId: runId, totalCostUsd: 3 });
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("## Codebase pitfalls\n\n- rule", 0.5),
      duration: 1000,
    };

    const result = await dispatchDreamingSession({
      projectId,
      batchRunId: runId,
      trigger: "night_run",
    });
    await flushBackground();

    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.sessionId!))
      .get();
    expect(row!.batchRunId).toBe(runId);
    expect(row!.epicId).toBeNull();
    // 3 (source build) + 0.5 (the dream) — the cap query is untouched.
    expect(sumNightRunCost(runId)).toBeCloseTo(3.5, 10);
  });

  it("throws for an unknown project", async () => {
    await expect(
      dispatchDreamingSession({ projectId: "nope" })
    ).rejects.toThrow("Project not found");
  });
});

describe("dispatchDreamingSession — the memory is only replaced on delivery", () => {
  it("leaves the memory untouched when the dream asked a question", async () => {
    saveProjectMemory(projectId, "- Untouched rule");
    seedSourceSession();
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("Should I drop the legacy section?"),
      endedWithQuestion: true,
      duration: 1000,
    };

    const result = await dispatchDreamingSession({ projectId });
    await flushBackground();

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.sessionId!))
      .get();
    expect(session!.outcome).toBe("asked_question");
    expect(getProjectMemoryContent(projectId)).toBe("- Untouched rule");
    expect(getProjectMemoryArchiveDoc(projectId)).toBeNull();
  });

  it("leaves the memory untouched when the dream failed", async () => {
    saveProjectMemory(projectId, "- Untouched rule");
    seedSourceSession();
    processManagerState.result = {
      success: false,
      error: "CLI crashed",
      duration: 10,
    };

    await dispatchDreamingSession({ projectId });
    await flushBackground();

    expect(getProjectMemoryContent(projectId)).toBe("- Untouched rule");
    expect(getProjectMemoryArchiveDoc(projectId)).toBeNull();
    expect(
      db
        .select()
        .from(notifications)
        .where(eq(notifications.projectId, projectId))
        .all()
        .filter((row) => row.agentType === DREAMING_AGENT_TYPE)
    ).toHaveLength(0);
  });

  it("leaves the memory untouched when the dream produced nothing", async () => {
    saveProjectMemory(projectId, "- Untouched rule");
    seedSourceSession();
    processManagerState.result = { success: true, result: "", duration: 10 };

    await dispatchDreamingSession({ projectId });
    await flushBackground();

    expect(getProjectMemoryContent(projectId)).toBe("- Untouched rule");
    expect(getProjectMemoryArchiveDoc(projectId)).toBeNull();
  });
});

describe("dispatchDreamingSession — guard rails", () => {
  it("never starts a second dream while one is in flight", async () => {
    seedSourceSession();
    seedSourceSession({
      agentType: DREAMING_AGENT_TYPE,
      status: "running",
      outcome: null,
      epicId: null,
    });

    expect(hasPendingDream(projectId)).toBe(true);
    const result = await dispatchDreamingSession({ projectId });
    await flushBackground();

    expect(result.dispatched).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(result.reason).toContain("already pending");
    // Only the seeded one — no second dream row.
    expect(dreamSessions()).toHaveLength(1);
  });

  it("no-ops (without spending a session) when nothing happened since the last dream", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    seedSourceSession({
      createdAt: past,
      startedAt: past,
      endedAt: past,
      completedAt: past,
    });
    // A delivered dream that already read that window.
    seedSourceSession({
      agentType: DREAMING_AGENT_TYPE,
      epicId: null,
      completedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });

    const result = await dispatchDreamingSession({ projectId });
    await flushBackground();

    expect(result.dispatched).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(result.reason).toContain("no new sessions");
    expect(dreamSessions()).toHaveLength(1); // only the seeded past dream
  });

  it("no-ops on a project that never ran a dreamable session", async () => {
    const result = await dispatchDreamingSession({ projectId });
    await flushBackground();
    expect(result.dispatched).toBe(false);
    expect(dreamSessions()).toHaveLength(0);
  });
});

describe("sanitizeDreamedMemory", () => {
  it("trims plain output and unwraps a full-document fence", () => {
    expect(sanitizeDreamedMemory("  body  ")).toBe("body");
    expect(sanitizeDreamedMemory("```\nbody\n```")).toBe("body");
    expect(sanitizeDreamedMemory("```md\nbody\n```")).toBe("body");
    // Inner (partial) fences survive — they are content, not wrapping.
    expect(sanitizeDreamedMemory("intro\n```\ncode\n```")).toBe(
      "intro\n```\ncode\n```"
    );
  });
});

describe("maybeDreamAfterNightRun", () => {
  function setSetting(key: string, value: unknown) {
    db.insert(settings)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: JSON.stringify(value) },
      })
      .run();
  }

  it("is off when the setting is absent (the default)", async () => {
    seedSourceSession();
    expect(isDreamingAfterNightRunEnabled(projectId)).toBe(false);

    const decision = await maybeDreamAfterNightRun(projectId, "night_x");
    await flushBackground();

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("off");
    expect(dreamSessions()).toHaveLength(0);
  });

  it("dreams when the global setting is on, tagging the run", async () => {
    setSetting(DREAMING_AFTER_NIGHT_RUN_SETTING_KEY, true);
    seedSourceSession();

    const decision = await maybeDreamAfterNightRun(projectId, "night_on");
    await flushBackground();

    expect(decision.allowed).toBe(true);
    const spawned = dreamSessions();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].batchRunId).toBe("night_on");
    expect(spawned[0].status).toBe("completed");
  });

  it("lets an explicit per-project false override a global true", async () => {
    setSetting(DREAMING_AFTER_NIGHT_RUN_SETTING_KEY, true);
    setSetting(dreamingAfterNightRunSettingKey(projectId), false);
    seedSourceSession();

    expect(isDreamingAfterNightRunEnabled(projectId)).toBe(false);
    const decision = await maybeDreamAfterNightRun(projectId, "night_off");
    await flushBackground();

    expect(decision.allowed).toBe(false);
    expect(dreamSessions()).toHaveLength(0);
  });

  it("lets a per-project true opt in while the global stays off", async () => {
    setSetting(dreamingAfterNightRunSettingKey(projectId), true);
    seedSourceSession();

    expect(isDreamingAfterNightRunEnabled(projectId)).toBe(true);
    await maybeDreamAfterNightRun(projectId, "night_opt_in");
    await flushBackground();

    expect(dreamSessions()).toHaveLength(1);
  });

  it("never throws into the night run's finish path", async () => {
    setSetting(DREAMING_AFTER_NIGHT_RUN_SETTING_KEY, true);
    // Unknown project: dispatch throws, the trigger swallows it.
    await expect(
      maybeDreamAfterNightRun("no-such-project", "night_boom")
    ).resolves.toMatchObject({ allowed: false });
  });
});
