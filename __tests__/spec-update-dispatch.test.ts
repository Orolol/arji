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
const { projects, agentSessions, epics, userStories, releases } = await import(
  "@/lib/db/schema"
);
const {
  dispatchSpecUpdateSession,
  getPendingSpecUpdateSession,
  hasPendingSpecUpdate,
  sanitizeUpdatedSpec,
  SpecUpdateAgentNotFoundError,
} = await import("@/lib/workflow/spec-update");
const { buildSpecUpdatePrompt, buildProjectStateSection } = await import(
  "@/lib/claude/prompt-builder"
);

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

function seedProject(spec: string | null, gitRepoPath: string | null = "/repos/s") {
  counter += 1;
  const projectId = `proj-spec-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: "Spec Project", gitRepoPath, spec })
    .run();
  return projectId;
}

function seedBoardState(projectId: string) {
  const epicId = `epic-${counter}`;
  db.insert(epics)
    .values({ id: epicId, projectId, title: "Auth Epic", status: "in_progress" })
    .run();
  db.insert(userStories)
    .values({
      id: `us-${counter}`,
      epicId,
      title: "Login form",
      status: "done",
    })
    .run();
  db.insert(releases)
    .values({
      id: `rel-${counter}`,
      projectId,
      version: "1.2.0",
      title: "First release",
      changelog: "- login works",
    })
    .run();
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

  it("rejects when the project has no git repository configured", async () => {
    const projectId = seedProject("# Spec", null);

    await expect(
      dispatchSpecUpdateSession({
        projectId,
        instruction: null,
        namedAgentId: null,
      })
    ).rejects.toThrow("no git repository path configured");
    expect(specUpdateSessions(projectId)).toHaveLength(0);
  });

  it("rejects a nonexistent named agent before creating any session", async () => {
    const projectId = seedProject("# Spec");

    await expect(
      dispatchSpecUpdateSession({
        projectId,
        instruction: null,
        namedAgentId: "agent-gone",
      })
    ).rejects.toBeInstanceOf(SpecUpdateAgentNotFoundError);
    expect(specUpdateSessions(projectId)).toHaveLength(0);
  });

  it("leaves the spec untouched when the agent asks a question", async () => {
    const projectId = seedProject("# Old Spec\n\n- stale");
    processManagerState.result = {
      success: true,
      endedWithQuestion: true,
      result: claudeEnvelope("Which sections should I update?"),
      duration: 500,
    };

    await dispatchSpecUpdateSession({
      projectId,
      instruction: null,
      namedAgentId: null,
    });
    await flushBackground();

    const session = specUpdateSessions(projectId)[0];
    expect(session.error).toContain("asked a question");
    const row = db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    expect(row?.spec).toBe("# Old Spec\n\n- stale");
  });
  it("marks a silent run failed and leaves the spec untouched", async () => {
    const projectId = seedProject("# Old Spec\n\n- stale");
    processManagerState.result = {
      success: true,
      result: "",
      duration: 500,
    };

    await dispatchSpecUpdateSession({
      projectId,
      instruction: null,
      namedAgentId: null,
    });
    await flushBackground();

    const session = specUpdateSessions(projectId)[0];
    expect(session.status).toBe("failed");
    expect(session.outcome).toBe("silent");
    expect(session.error).toContain("left unchanged");
    const row = db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    expect(row?.spec).toBe("# Old Spec\n\n- stale");
  });

  it("keeps a missing-CLI spawn failure's readable reason on the session", async () => {
    const projectId = seedProject("# Old Spec\n\n- stale");
    processManagerState.result = {
      success: false,
      error:
        "Codex CLI not found. Install it with: npm i -g @openai/codex",
      duration: 10,
    };

    await dispatchSpecUpdateSession({
      projectId,
      instruction: null,
      namedAgentId: null,
    });
    await flushBackground();

    const session = specUpdateSessions(projectId)[0];
    expect(session.status).toBe("failed");
    expect(session.error).toContain("Codex CLI not found");
    const row = db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    expect(row?.spec).toBe("# Old Spec\n\n- stale");
  });


  it("embeds the board and release state in the dispatched prompt", async () => {
    const projectId = seedProject("# Spec");
    seedBoardState(projectId);

    await dispatchSpecUpdateSession({
      projectId,
      instruction: null,
      namedAgentId: null,
    });
    await flushBackground();

    const prompt = specUpdateSessions(projectId)[0].prompt;
    expect(prompt).toContain("## Current Project State");
    expect(prompt).toContain("**Auth Epic** — in_progress");
    expect(prompt).toContain("- Login form — done");
    expect(prompt).toContain("**1.2.0** — First release");
    expect(prompt).toContain("- login works");
  });

  it("returns the pending session or null via getPendingSpecUpdateSession", () => {
    const projectId = seedProject("# Spec");
    expect(getPendingSpecUpdateSession(projectId)).toBeNull();

    db.insert(agentSessions)
      .values({
        id: `spec-queued-pending-${counter}`,
        projectId,
        status: "running",
        agentType: "spec_generation",
        createdAt: new Date().toISOString(),
      })
      .run();

    const pending = getPendingSpecUpdateSession(projectId);
    expect(pending).not.toBeNull();
    expect(pending?.id).toBe(`spec-queued-pending-${counter}`);
    expect(pending?.status).toBe("running");
  });
});

describe("sanitizeUpdatedSpec", () => {
  it("strips a full-document fence but keeps inner content intact", () => {
    expect(sanitizeUpdatedSpec("```markdown\n# A\n\n- b\n```")).toBe(
      "# A\n\n- b"
    );
    expect(sanitizeUpdatedSpec("```md5\r\n# A\r\n\n- b\r\n```  ")).toBe(
      "# A\r\n\n- b"
    );
    expect(sanitizeUpdatedSpec("# A\n\n- b")).toBe("# A\n\n- b");
  });
});

describe("buildProjectStateSection", () => {
  it("renders nothing when the project has no epics or releases", () => {
    expect(buildProjectStateSection([], [], [])).toBe("");
  });

  it("groups stories under their epics", () => {
    const section = buildProjectStateSection(
      [{ id: "e1", title: "Epic One", status: "review" }],
      [{ epicId: "e1", title: "Story A", status: "todo" }],
      []
    );
    expect(section).toContain("### Board");
    expect(section).toContain("- **Epic One** — review");
    expect(section).toContain("  - Story A — todo");
    expect(section).not.toContain("### Releases");
  });

  it("truncates epics over cap and appends truncation marker", () => {
    const epicsList = Array.from({ length: 35 }, (_, i) => ({
      id: `epic-${i}`,
      title: `Epic ${i}`,
      status: "todo",
    }));
    const section = buildProjectStateSection(epicsList, [], []);
    expect(section).toContain("- **Epic 0** — todo");
    expect(section).toContain("- **Epic 29** — todo");
    expect(section).not.toContain("- **Epic 30** — todo");
    expect(section).toContain("- _... and 5 more epics (truncated)_");
  });

  it("truncates stories over cap per epic and appends truncation marker", () => {
    const stories = Array.from({ length: 25 }, (_, i) => ({
      epicId: "e1",
      title: `Story ${i}`,
      status: "done",
    }));
    const section = buildProjectStateSection(
      [{ id: "e1", title: "Epic 1", status: "todo" }],
      stories,
      []
    );
    expect(section).toContain("  - Story 0 — done");
    expect(section).toContain("  - Story 19 — done");
    expect(section).not.toContain("  - Story 20 — done");
    expect(section).toContain("  - _... and 5 more stories (truncated)_");
  });

  it("truncates releases over cap and long changelogs with truncation markers", () => {
    const releasesList = Array.from({ length: 15 }, (_, i) => ({
      version: `1.${i}.0`,
      title: `Release ${i}`,
      changelog: i === 0 ? "x".repeat(1500) : "short changelog",
    }));
    const section = buildProjectStateSection([], [], releasesList);
    expect(section).toContain("### Releases");
    expect(section).toContain("**1.0.0** — Release 0");
    expect(section).toContain("_... [changelog truncated]_");
    expect(section).toContain("- _... and 5 older releases (truncated)_");
  });
});