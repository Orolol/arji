/**
 * Autonomous pipeline — forensic dispatch against the real migrated schema
 * (createTestDb) with the CLI spawn mocked:
 *
 *   - runForensic queues a 'forensic' session (mode 'plan', NO epicId so the
 *     ticket stays free), runs it through the real scheduler + lifecycle, and
 *     posts the diagnostic as an agent ticket comment + a from==to activity
 *     entry — never a status change,
 *   - the prompt carries the dead session's error, chunk tails and last text,
 *   - a dead session with zero chunks still produces a full prompt,
 *   - guards: unknown project, unknown dead session, and never a
 *     forensic-of-a-forensic,
 *   - a failing/silent forensic run is swallowed: no comment, no activity
 *     entry, and `settled` reports the failure instead of rejecting,
 *   - forensic sessions never feed the memory auto-distill trigger.
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
  resolveAgentPrompt: vi.fn().mockResolvedValue("forensic system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "gemini-cli",
    namedAgentId: "cheap-agent",
    name: "Cheap Forensic",
    model: "flash",
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
const {
  projects,
  epics,
  userStories,
  agentSessions,
  namedAgents,
  ticketComments,
  ticketActivityLog,
} = await import("@/lib/db/schema");
const {
  runForensic,
  postForensicDiagnostic,
  readChunkTail,
  FORENSIC_COMMENT_HEADING,
  FORENSIC_POSTED_REASON,
  FORENSIC_RAW_TAIL_MAX_CHARS,
  forensicDeadSessionMarker,
  parseForensicDeadSessionId,
} = await import("@/lib/pipeline/forensic");
const { appendSessionChunk } = await import("@/lib/agent-sessions/chunks");
const { evaluateAutoDistillGuards, AUTO_DISTILL_SOURCE_AGENT_TYPES } =
  await import("@/lib/workflow/memory-distill");
const { resolveAgentByNamedId } = await import(
  "@/lib/agent-config/agent-resolution"
);

let counter = 0;

async function flushBackground() {
  await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
}

function claudeEnvelope(text: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result: text });
}

/** The cheap named agent users bind to agentType 'forensic'. */
function seedCheapAgent() {
  db.insert(namedAgents)
    .values({
      id: "cheap-agent",
      name: "Cheap Forensic",
      provider: "gemini-cli",
      model: "flash",
    })
    .onConflictDoNothing()
    .run();
}

function seedProject() {
  counter += 1;
  const projectId = `proj-forensic-${counter}`;
  const epicId = `epic-forensic-${counter}`;
  const storyId = `story-forensic-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: "Forensic Project", gitRepoPath: "/repos/f" })
    .run();
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Checkout flow",
      status: "in_progress",
      position: 0,
      readableId: `E-f-${counter}`,
    })
    .run();
  db.insert(userStories)
    .values({
      id: storyId,
      epicId,
      title: "Apply a discount code",
      status: "in_progress",
      position: 0,
    })
    .run();
  return { projectId, epicId, storyId };
}

function seedDeadSession(
  projectId: string,
  epicId: string | null,
  overrides: Partial<typeof agentSessions.$inferInsert> = {}
): string {
  counter += 1;
  const id = `dead-${counter}`;
  db.insert(agentSessions)
    .values({
      id,
      projectId,
      epicId,
      status: "failed",
      agentType: "build",
      provider: "codex",
      model: "gpt-mini",
      outcome: "error",
      error: "Command failed with exit code 1",
      lastNonEmptyText: "Trying to patch lib/foo.ts",
      createdAt: new Date().toISOString(),
    })
    .run();
  if (Object.keys(overrides).length > 0) {
    db.update(agentSessions)
      .set(overrides)
      .where(eq(agentSessions.id, id))
      .run();
  }
  return id;
}

function forensicSessions(projectId: string) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.projectId, projectId))
    .all()
    .filter((row) => row.agentType === "forensic");
}

function commentsFor(epicId: string) {
  return db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.epicId, epicId))
    .all();
}

beforeEach(() => {
  vi.clearAllMocks();
  seedCheapAgent();
  processManagerState.result = {
    success: true,
    result: claudeEnvelope(
      "**Probable root cause**\n\nThe CLI died on a missing dependency."
    ),
    duration: 1000,
  };
});

describe("runForensic — happy path", () => {
  it("queues a forensic session and posts the diagnostic as an agent comment", async () => {
    const { projectId, epicId } = seedProject();
    const deadId = seedDeadSession(projectId, epicId);
    appendSessionChunk({
      sessionId: deadId,
      streamType: "raw",
      content: "npm ERR! ELIFECYCLE\n",
    });
    appendSessionChunk({
      sessionId: deadId,
      streamType: "output",
      content: "Running the test suite...\n",
    });
    // Appending an 'output' chunk refreshes lastNonEmptyText — restore the
    // seeded value so the three evidence sources stay distinguishable.
    db.update(agentSessions)
      .set({ lastNonEmptyText: "Trying to patch lib/foo.ts" })
      .where(eq(agentSessions.id, deadId))
      .run();

    const { sessionId, settled } = await runForensic({
      projectId,
      epicId,
      userStoryId: null,
      deadSessionId: deadId,
      stage: "build",
      attempts: 2,
    });
    expect(sessionId).toBeTruthy();
    await flushBackground();

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId!))
      .get();
    expect(session).toMatchObject({
      agentType: "forensic",
      mode: "plan",
      status: "completed",
      outcome: "answered",
      projectId,
      // Deliberately unanchored: the ticket must stay dispatchable while the
      // diagnostic runs.
      epicId: null,
      userStoryId: null,
      provider: "gemini-cli",
      model: "flash",
      namedAgentId: "cheap-agent",
    });

    // Cheap model comes from the named-agent binding, not a hard-coded id.
    expect(resolveAgentByNamedId).toHaveBeenCalledWith(
      "forensic",
      projectId,
      null
    );

    // Prompt carries the ticket context and every scrap of evidence.
    expect(session!.prompt).toContain("forensic system prompt");
    expect(session!.prompt).toContain("- **Ticket:** Checkout flow");
    expect(session!.prompt).toContain("- **Pipeline stage:** build");
    expect(session!.prompt).toContain("- **Attempts before giving up:** 2");
    expect(session!.prompt).toContain("- **Provider:** codex");
    expect(session!.prompt).toContain("Command failed with exit code 1");
    expect(session!.prompt).toContain("npm ERR! ELIFECYCLE");
    expect(session!.prompt).toContain("Running the test suite...");
    expect(session!.prompt).toContain("Trying to patch lib/foo.ts");

    // Diagnostic round-trip: one agent comment on the epic.
    const comments = commentsFor(epicId);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "agent",
      agentSessionId: sessionId,
      userStoryId: null,
    });
    // The heading, then the durable link back to the session being diagnosed
    // (invisible in rendered markdown), then the diagnostic itself.
    expect(comments[0].content).toBe(
      `${FORENSIC_COMMENT_HEADING}\n${forensicDeadSessionMarker(deadId)}\n\n**Probable root cause**\n\nThe CLI died on a missing dependency.`
    );
    expect(parseForensicDeadSessionId(comments[0].content)).toBe(deadId);

    // Activity entry only — the ticket status is untouched.
    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actor: "system",
      reason: FORENSIC_POSTED_REASON,
      sessionId,
      fromStatus: "in_progress",
      toStatus: "in_progress",
    });
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("in_progress");

    await expect(settled).resolves.toMatchObject({
      sessionId,
      success: true,
      outcome: "answered",
    });
  });

  it("anchors the comment to the story for a story-scoped run", async () => {
    const { projectId, epicId, storyId } = seedProject();
    const deadId = seedDeadSession(projectId, epicId);

    const { sessionId } = await runForensic({
      projectId,
      epicId,
      userStoryId: storyId,
      deadSessionId: deadId,
      stage: "fix",
      attempts: 1,
    });
    await flushBackground();

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId!))
      .get();
    expect(session!.prompt).toContain("- **Ticket:** Apply a discount code");

    const comments = commentsFor(epicId);
    expect(comments).toHaveLength(1);
    expect(comments[0].userStoryId).toBe(storyId);
  });

  it("works when the dead session produced zero chunks", async () => {
    const { projectId, epicId } = seedProject();
    const deadId = seedDeadSession(projectId, epicId, {
      error: null,
      lastNonEmptyText: null,
    });

    const { sessionId } = await runForensic({
      projectId,
      epicId,
      userStoryId: null,
      deadSessionId: deadId,
      stage: "review",
      attempts: 2,
    });
    await flushBackground();

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId!))
      .get();
    expect(session!.status).toBe("completed");
    expect(session!.prompt).toContain("### Recorded error\n\n(none)");
    expect(session!.prompt).toContain("### Raw stream (tail)\n\n(none)");
    expect(session!.prompt).toContain("### Output stream (tail)\n\n(none)");
    expect(session!.prompt).toContain("### Last text produced\n\n(none)");
    expect(commentsFor(epicId)).toHaveLength(1);
  });
});

describe("runForensic — guards", () => {
  it("refuses an unknown project", async () => {
    const result = await runForensic({
      projectId: "nope",
      epicId: "nope",
      userStoryId: null,
      deadSessionId: "nope",
      stage: "build",
      attempts: 1,
    });

    expect(result.sessionId).toBeNull();
    await expect(result.settled).resolves.toMatchObject({
      success: false,
      error: "Project not found",
    });
  });

  it("refuses an unknown dead session", async () => {
    const { projectId, epicId } = seedProject();

    const result = await runForensic({
      projectId,
      epicId,
      userStoryId: null,
      deadSessionId: "missing-session",
      stage: "build",
      attempts: 1,
    });

    expect(result.sessionId).toBeNull();
    await expect(result.settled).resolves.toMatchObject({
      success: false,
      error: "Dead session not found",
    });
    expect(forensicSessions(projectId)).toHaveLength(0);
  });

  it("never runs a forensic on a forensic session", async () => {
    const { projectId, epicId } = seedProject();
    const deadForensic = seedDeadSession(projectId, null, {
      agentType: "forensic",
    });

    const result = await runForensic({
      projectId,
      epicId,
      userStoryId: null,
      deadSessionId: deadForensic,
      stage: "build",
      attempts: 2,
    });
    await flushBackground();

    expect(result.sessionId).toBeNull();
    await expect(result.settled).resolves.toMatchObject({
      success: false,
      error: "Never run a forensic on a forensic session",
    });
    // Only the seeded one — no new forensic session, no comment.
    expect(forensicSessions(projectId)).toHaveLength(1);
    expect(commentsFor(epicId)).toHaveLength(0);
  });

  it("swallows a failed forensic run: no comment, no activity entry", async () => {
    const { projectId, epicId } = seedProject();
    const deadId = seedDeadSession(projectId, epicId);
    processManagerState.result = {
      success: false,
      error: "forensic CLI crashed",
      duration: 10,
    };

    const { sessionId, settled } = await runForensic({
      projectId,
      epicId,
      userStoryId: null,
      deadSessionId: deadId,
      stage: "build",
      attempts: 2,
    });
    await flushBackground();

    expect(
      db.select().from(agentSessions).where(eq(agentSessions.id, sessionId!)).get()
    ).toMatchObject({ status: "failed", outcome: "error" });
    expect(commentsFor(epicId)).toHaveLength(0);
    expect(
      db
        .select()
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.epicId, epicId))
        .all()
    ).toHaveLength(0);
    await expect(settled).resolves.toMatchObject({
      sessionId,
      success: false,
      error: "forensic CLI crashed",
    });
  });

  it("posts nothing when the forensic agent stayed silent", async () => {
    const { projectId, epicId } = seedProject();
    const deadId = seedDeadSession(projectId, epicId);
    processManagerState.result = { success: true, result: "", duration: 10 };

    const { settled } = await runForensic({
      projectId,
      epicId,
      userStoryId: null,
      deadSessionId: deadId,
      stage: "build",
      attempts: 2,
    });
    await flushBackground();

    expect(commentsFor(epicId)).toHaveLength(0);
    await expect(settled).resolves.toMatchObject({
      success: true,
      outcome: "silent",
    });
  });

  it("keeps forensic sessions out of the memory auto-distill trigger", () => {
    expect(AUTO_DISTILL_SOURCE_AGENT_TYPES).not.toContain("forensic");
    const decision = evaluateAutoDistillGuards({
      enabled: true,
      session: {
        id: "s1",
        projectId: "p1",
        agentType: "forensic",
        status: "completed",
        outcome: "answered",
        batchRunId: null,
      },
      hasPendingDistill: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not a build type");
  });
});

describe("readChunkTail", () => {
  it("returns null for a session with no chunks", () => {
    expect(readChunkTail("ghost-session", "raw", 100)).toBeNull();
  });

  it("keeps the LAST maxChars of the stream", () => {
    const { projectId, epicId } = seedProject();
    const deadId = seedDeadSession(projectId, epicId);
    appendSessionChunk({
      sessionId: deadId,
      streamType: "raw",
      content: "a".repeat(50) + "TAIL",
    });

    expect(readChunkTail(deadId, "raw", 10)).toBe("aaaaaaTAIL");
    expect(readChunkTail(deadId, "raw", FORENSIC_RAW_TAIL_MAX_CHARS)).toHaveLength(
      54
    );
    // Streams are independent.
    expect(readChunkTail(deadId, "output", 100)).toBeNull();
  });
});

describe("postForensicDiagnostic", () => {
  it("is a pure annotation: comment + activity entry, no status change", () => {
    const { projectId, epicId } = seedProject();
    db.update(epics).set({ status: "review" }).where(eq(epics.id, epicId)).run();

    postForensicDiagnostic({
      projectId,
      epicId,
      userStoryId: null,
      sessionId: null as unknown as string,
      diagnostic: "Root cause: flaky network.",
      createdAt: "2026-08-17T10:00:00.000Z",
    });

    const comments = commentsFor(epicId);
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe(
      `${FORENSIC_COMMENT_HEADING}\n\nRoot cause: flaky network.`
    );
    expect(comments[0].createdAt).toBe("2026-08-17T10:00:00.000Z");

    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(activity[0]).toMatchObject({
      fromStatus: "review",
      toStatus: "review",
      actor: "system",
      reason: FORENSIC_POSTED_REASON,
    });
    expect(
      db.select().from(epics).where(eq(epics.id, epicId)).get()!.status
    ).toBe("review");
  });
});
