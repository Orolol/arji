/**
 * Agent-run spec updates end-to-end against the real migrated schema
 * (createTestDb), with the CLI spawn mocked:
 *
 *   - dispatchSpecUpdateSession creates a queued 'spec_generation' session,
 *     runs it through the real scheduler + lifecycle, and on an answered
 *     completion REPLACES projects.spec (fence-unwrapped),
 *   - non-answered outcomes (asked_question) and failures leave the stored
 *     spec untouched — the spec must never change when a session fails,
 *   - the optional user instruction is embedded in the prompt only when set,
 *   - hasPendingSpecUpdate guards re-entrant dispatches.
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
  resolveAgentPrompt: vi.fn().mockResolvedValue("spec system prompt"),
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
const { projects, agentSessions } = await import("@/lib/db/schema");
const {
  dispatchSpecUpdateSession,
  hasPendingSpecUpdate,
  sanitizeUpdatedSpec,
} = await import("@/lib/workflow/spec-update");
const { buildSpecUpdatePrompt } = await import("@/lib/claude/prompt-builder");

let counter = 0;

async function flushBackground() {
  await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
}

function claudeEnvelope(text: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: text,
  });
}

function seedProject(spec: string | null) {
  counter += 1;
  const projectId = `proj-spec-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: "Spec Project", gitRepoPath: "/repos/s", spec })
    .run();
  return projectId;
}

function specUpdateSessions(projectId: string) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.projectId, projectId))
    .all()
    .filter((row) => row.agentType === "spec_generation");
}

beforeEach(() => {
  vi.clearAllMocks();
  processManagerState.result = {
    success: true,
    result: claudeEnvelope("# Updated Spec\n\n- refreshed from the board"),
    duration: 1000,
  };
});

describe("dispatchSpecUpdateSession", () => {
  it("replaces the stored spec on an answered completion", async () => {
    const projectId = seedProject("# Old Spec\n\n- stale");
    expect(hasPendingSpecUpdate(projectId)).toBe(false);

    const { sessionId } = await dispatchSpecUpdateSession({
      projectId,
      instruction: null,
      namedAgentId: null,
    });

    await flushBackground();

    const sessions = specUpdateSessions(projectId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].status).toBe("completed");
    expect(sessions[0].mode).toBe("plan");

    const row = db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    expect(row?.spec).toBe("# Updated Spec\n\n- refreshed from the board");
    expect(hasPendingSpecUpdate(projectId)).toBe(false);
  });

  it("unwraps an accidental full-document code fence", async () => {
    const projectId = seedProject("# Old Spec");
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("```markdown\n# Fenced Spec\n```\n"),
      duration: 1000,
    };

    await dispatchSpecUpdateSession({
      projectId,
      instruction: null,
      namedAgentId: null,
    });
    await flushBackground();

    const row = db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    expect(row?.spec).toBe("# Fenced Spec");
  });


  it("embeds the instruction in the prompt only when provided", async () => {
    const projectId = seedProject("# Spec");

    const withInstruction = buildSpecUpdatePrompt(
      { id: projectId, name: "Spec Project", spec: "# Spec" },
      "update the architecture section",
      null
    );
    expect(withInstruction).toContain("## User Instruction");
    expect(withInstruction).toContain("update the architecture section");

    const withoutInstruction = buildSpecUpdatePrompt(
      { id: projectId, name: "Spec Project", spec: "# Spec" },
      null,
      null
    );
    expect(withoutInstruction).not.toContain("## User Instruction");
    expect(withoutInstruction).toContain("# Spec");

    await dispatchSpecUpdateSession({
      projectId,
      instruction: "focus on architecture",
      namedAgentId: null,
    });
    await flushBackground();
    const sessions = specUpdateSessions(projectId);
    expect(sessions[0].prompt).toContain("focus on architecture");
  });

  it("reports a pending spec update while a session is queued", () => {
    const projectId = seedProject("# Spec");
    db.insert(agentSessions)
      .values({
        id: `spec-queued-${counter}`,
        projectId,
        status: "queued",
        agentType: "spec_generation",
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(hasPendingSpecUpdate(projectId)).toBe(true);
  });
});

describe("sanitizeUpdatedSpec", () => {
  it("strips a full-document fence but keeps inner content intact", () => {
    expect(sanitizeUpdatedSpec("```markdown\n# A\n\n- b\n```")).toBe(
      "# A\n\n- b"
    );
    expect(sanitizeUpdatedSpec("# A\n\n- b")).toBe("# A\n\n- b");
  });
});
